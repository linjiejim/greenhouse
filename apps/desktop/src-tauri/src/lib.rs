//! Greenhouse desktop shell.
//!
//! The shell is deliberately thin: it hosts the same `apps/web` bundle the browser
//! serves, adds native capabilities the browser can't offer, and can swap the web
//! layer underneath itself via signed hot updates. Feature work belongs in
//! `apps/web`; this crate only grows when a new *native* capability is needed.

mod app_menu;
mod assets;
mod bundle;
mod commands;
mod native;
mod protocol;
mod settings;
mod shortcuts;
mod state;
mod tray;
pub mod updater;
mod windows;

use assets::AssetStore;
use shortcuts::{ShortcutId, ShortcutMap, EVENT_SHORTCUT};
use state::DesktopState;
use std::path::PathBuf;
use std::str::FromStr;
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

/// Custom scheme the production window loads from. See `protocol` for why.
const SCHEME: &str = "greenhouse";

/// The window origin, which differs by platform: Windows maps custom schemes onto
/// `http://<scheme>.localhost`, everything else uses a real custom scheme.
pub fn app_url() -> tauri::Url {
    let raw = if cfg!(windows) {
        "http://greenhouse.localhost/index.html"
    } else {
        "greenhouse://localhost/index.html"
    };
    raw.parse().expect("app url is a valid URL")
}

pub fn run() {
    tauri::Builder::default()
        .plugin(build_logger())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .on_window_event(|window, event| {
            if window.label() != windows::MAIN {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Keep global shortcuts and the tray alive. Quit remains an explicit
                // application-menu/tray action, matching normal menu-bar apps.
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .register_uri_scheme_protocol(SCHEME, |ctx, request| {
            let store = AssetStore::from_app(ctx.app_handle());
            store.serve(request.uri().path())
        })
        .invoke_handler(tauri::generate_handler![
            commands::native::desktop_capabilities,
            commands::native::desktop_capture_screen,
            commands::native::desktop_read_clipboard,
            commands::native::desktop_read_selection,
            commands::native::desktop_request_permission,
            commands::native::desktop_reveal_in_file_manager,
            commands::native::desktop_set_selection_watch,
            commands::native::desktop_write_clipboard,
            commands::settings::desktop_get_settings,
            commands::settings::desktop_set_api_base,
            commands::system::desktop_info,
            commands::system::desktop_log,
            commands::system::desktop_mark_boot_ok,
            commands::tray::desktop_set_tray_menu,
            commands::updates::desktop_check_web_update,
            commands::updates::desktop_download_shell_installer,
            commands::updates::desktop_install_shell_update,
            commands::updates::desktop_prepare_shell_update,
            commands::updates::desktop_restart,
            commands::windows::desktop_focus_main_window,
            commands::windows::desktop_hide_quick_window,
            commands::windows::desktop_hide_selection_bar,
            commands::windows::desktop_set_selection_surface_mode,
            commands::windows::desktop_show_selection_bar,
            commands::windows::desktop_set_shortcuts,
            commands::windows::desktop_take_pending_selection,
            commands::windows::desktop_toggle_quick_window,
        ])
        .setup(|app| {
            let app_data = resolve_app_data_dir(app)?;
            std::fs::create_dir_all(&app_data)?;

            // Resolve (and self-heal) the web bundle before the window exists, so the
            // first request the webview makes already hits the right source.
            let active_bundle = bundle::resolve_active(&app_data);
            log::info!("[boot] web bundle: {active_bundle:?}");
            bundle::arm_boot_watchdog(&app_data, &active_bundle)?;

            let shell_settings = settings::load(&app_data);
            // A packaged build with a server baked in at build time ignores whatever
            // is stored and always uses that server — see the note at the top of
            // `settings`. Without one, the setting is live in every build.
            let api_base = settings::effective_api_base(
                &shell_settings.api_base_url,
                settings::api_base_locked(),
            );
            log::info!(
                "[boot] api base: {api_base}{}",
                if settings::api_base_locked() {
                    " (fixed at build time)"
                } else {
                    " (configurable in Settings)"
                }
            );
            let bootstrap = settings::bootstrap_script(&api_base);
            let shortcut_map = shell_settings.shortcuts.clone();
            let watch_selection = shell_settings.selection_watch;

            app.manage(DesktopState::new(app_data, active_bundle, shell_settings));
            app_menu::install(app)?;
            tray::install(app.handle())?;

            if let Err(err) = register_shortcuts(app.handle(), &shortcut_map) {
                // A shortcut already taken by another app must not stop startup; the
                // settings page shows what actually registered.
                log::warn!("[shortcuts] {err}");
            }
            if watch_selection {
                if let Err(err) = start_selection_watch(app.handle(), true) {
                    log::warn!("[selection] watcher not started: {err}");
                }
            }

            // In dev the window loads Vite (devUrl) so HMR works exactly as it does in
            // the browser; only the packaged app goes through the custom scheme.
            //
            // `is_dev()` tracks the `custom-protocol` cargo feature, which the Tauri CLI
            // sets — NOT the build profile. A bare `cargo run` is therefore a "dev" build
            // that expects Vite on :3100; use `cargo run --features tauri/custom-protocol`
            // to exercise the packaged path without a full `tauri build`.
            let url = if tauri::is_dev() {
                WebviewUrl::App("index.html".into())
            } else {
                WebviewUrl::CustomProtocol(app_url())
            };
            log::info!("[boot] loading {url:?}");

            let main_window = WebviewWindowBuilder::new(app, windows::MAIN, url)
                .title("Greenhouse")
                .inner_size(1440.0, 900.0)
                .min_inner_size(880.0, 600.0)
                // Hand drag-and-drop back to the webview. Tauri's handler is on by
                // default and its callback returns `true` unconditionally, which wry
                // reads as "consumed" — so it swallows the drop and HTML5 `ondrop`
                // never fires. The composer's drag-to-attach was dead on both macOS
                // and Windows because of this, and it *looked* like it worked: wry
                // still answers NSDragOperation::Copy, so the cursor shows the drop
                // affordance right up until nothing happens.
                //
                // We want the plain web behaviour (real File objects straight into
                // `handleFileSelect`, identical to the browser build), not Tauri's
                // path-only `tauri://drag-drop` event — paths would need a grant +
                // a read command, i.e. a second attachment pipeline.
                //
                // Verification is necessarily manual: injected/synthetic drag events
                // take a different code path than a real OS drag, so automation is
                // green either way. Drag a file onto the composer on a real build.
                .disable_drag_drop_handler()
                // Runs before any app script on every navigation, including reloads.
                .initialization_script(&bootstrap);

            #[cfg(target_os = "macos")]
            let main_window = main_window
                .title_bar_style(tauri::TitleBarStyle::Overlay)
                .hidden_title(true)
                .traffic_light_position(tauri::LogicalPosition::new(14.0, 18.0));

            main_window.build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the Greenhouse desktop shell")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                windows::focus_main(app);
            }
        });
}

/// Resolve the shell-owned data directory.
///
/// Debug builds have one deliberately narrow override for the automated hot-update
/// lifecycle check. It lets that check run against a fresh pointer without touching
/// the real installed app's settings, login, or staged bundle. Release binaries do
/// not compile the override at all.
fn resolve_app_data_dir<R: Runtime>(app: &tauri::App<R>) -> tauri::Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(raw) = std::env::var_os("GREENHOUSE_QA_APP_DATA_DIR") {
        let path = PathBuf::from(raw);
        if !path.is_absolute() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "GREENHOUSE_QA_APP_DATA_DIR must be an absolute path",
            )
            .into());
        }
        log::warn!("[boot] using isolated QA app data: {}", path.display());
        return Ok(path);
    }

    app.path().app_data_dir()
}

/// Logging tuned for reading a shipped app's log file.
///
/// The default filter let `tao`/`wry` TRACE through, which buried everything useful
/// under a wall of `windowDidResize` — a whole session's log was window events and
/// nothing else. Dependencies are pinned to warnings; our own crate keeps info/debug.
fn build_logger<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_log::Builder::new()
        .level(log::LevelFilter::Info)
        .level_for("greenhouse_desktop_lib", log::LevelFilter::Debug)
        // Chatty at TRACE and never useful to us.
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("tauri_runtime_wry", log::LevelFilter::Warn)
        .level_for("reqwest", log::LevelFilter::Warn)
        .level_for("hyper", log::LevelFilter::Warn)
        .level_for("rustls", log::LevelFilter::Warn)
        .build()
}

#[derive(Clone, serde::Serialize)]
struct ShortcutFired {
    id: ShortcutId,
}

/// (Re)register the global shortcuts, replacing whatever was registered before.
///
/// Each shortcut only emits an event — the web layer decides what it does, so
/// behaviour stays hot-updatable while the bindings live here.
pub fn register_shortcuts<R: Runtime>(
    app: &AppHandle<R>,
    stored: &ShortcutMap,
) -> Result<(), String> {
    let manager = app.global_shortcut();
    manager.unregister_all().map_err(|e| e.to_string())?;

    let mut failed = Vec::new();
    for (id, accelerator) in shortcuts::resolve(stored) {
        let Ok(shortcut) = Shortcut::from_str(&accelerator) else {
            failed.push(format!("{}: unparseable ({accelerator})", id.as_str()));
            continue;
        };
        let handle = app.clone();
        let result = manager.on_shortcut(shortcut, move |_app, _shortcut, event| {
            // Fire on press only; without this every shortcut runs twice.
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Err(err) = handle.emit(EVENT_SHORTCUT, ShortcutFired { id }) {
                log::warn!("[shortcuts] could not emit {}: {err}", id.as_str());
            }
        });
        if let Err(err) = result {
            // Almost always "already taken by another app" — worth surfacing, not fatal.
            failed.push(format!("{}: {err} ({accelerator})", id.as_str()));
        }
    }

    if failed.is_empty() {
        Ok(())
    } else {
        Err(format!("could not register: {}", failed.join("; ")))
    }
}

/// Replace the active global shortcut set, restoring the previous set on failure.
///
/// Registration is the real validation for conflicts with other applications.
/// Persisting first would leave the user stuck with a binding that never worked.
pub fn replace_shortcuts<R: Runtime>(
    app: &AppHandle<R>,
    next: &ShortcutMap,
    previous: &ShortcutMap,
) -> Result<(), String> {
    if let Err(err) = register_shortcuts(app, next) {
        let rollback = register_shortcuts(app, previous);
        return match rollback {
            Ok(()) => Err(err),
            Err(rollback_err) => Err(format!(
                "{err}; restoring the previous shortcuts also failed: {rollback_err}"
            )),
        };
    }
    Ok(())
}

/// Start or stop the always-on selection watcher, showing the floating bar on a hit.
pub fn start_selection_watch<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Result<(), String> {
    if !enabled {
        native::selection::reset_dedup();
        windows::hide_selection_bar(app);
    }

    let handle = app.clone();
    native::selection::set_watching(enabled, move |event| {
        let Some(state) = handle.try_state::<DesktopState>() else {
            return;
        };
        match event {
            native::selection::SelectionWatchEvent::Selected(found) => {
                // Stash before emitting: if the web policy chooses to show the bar,
                // its satellite window consumes the pending selection as it mounts.
                state.set_pending_selection(found.clone());

                // The hot-updatable web layer owns the display policy. It may show
                // the icon, suppress it, or change that policy later.
                let _ = handle.emit(commands::native::EVENT_SELECTION, &found);
            }
            native::selection::SelectionWatchEvent::Cleared => {
                state.clear_pending_selection();
                let _ = handle.emit(commands::native::EVENT_SELECTION_CLEARED, ());
            }
        }
    })
}

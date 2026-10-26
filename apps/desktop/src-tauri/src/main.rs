#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod credentials;
mod menu;

use std::sync::Mutex;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
struct Links(Mutex<Vec<String>>);
#[derive(Default)]
struct Routes(Mutex<Vec<String>>);

fn local_url(url: &url::Url) -> bool {
    url.scheme() == "tauri" && url.host_str() == Some("localhost")
}

fn window(app: &tauri::AppHandle, label: &str) -> tauri::Result<WebviewWindow> {
    if let Some(window) = app.get_webview_window(label) {
        window.show()?;
        window.unminimize()?;
        window.set_focus()?;
        return Ok(window);
    }
    let quick = label == "quick-ask";
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App("index.html".into()))
        .title(if quick { "快问" } else { "Greenhouse" })
        .initialization_script(format!("window.__GREENHOUSE_WINDOW__ = '{}';", label))
        .on_navigation(local_url)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .inner_size(
            if quick { 560.0 } else { 1360.0 },
            if quick { 320.0 } else { 900.0 },
        )
        .min_inner_size(
            if quick { 560.0 } else { 760.0 },
            if quick { 240.0 } else { 560.0 },
        );
    if quick {
        builder = builder
            .decorations(false)
            .resizable(false)
            .always_on_top(true)
            .center();
    } else {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .traffic_light_position(tauri::LogicalPosition::new(18.0, 18.0))
            .hidden_title(true)
            .transparent(true)
            .effects(tauri::utils::config::WindowEffectsConfig {
                effects: vec![tauri::window::Effect::Sidebar],
                state: Some(tauri::window::EffectState::Active),
                radius: None,
                color: None,
                ..Default::default()
            });
    }
    builder.build()
}

#[tauri::command]
fn take_links(app: tauri::AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<Links>().0.lock().unwrap())
}

#[tauri::command]
fn take_routes(app: tauri::AppHandle) -> Vec<String> {
    std::mem::take(&mut *app.state::<Routes>().0.lock().unwrap())
}

#[tauri::command]
fn open_main(app: tauri::AppHandle, route: String) -> Result<(), String> {
    if !route.starts_with('/') || route.starts_with("//") || route.len() > 2048 {
        return Err("Invalid route".into());
    }
    if route != "/login" {
        app.state::<Routes>().0.lock().unwrap().push(route);
    }
    window(&app, "main").map_err(|e| e.to_string())?;
    app.emit_to("main", "desktop:routes", ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    window(&app, "settings")
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn close_window(window: WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        window.hide()
    } else {
        window.close()
    }
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn open_external(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|_| "Invalid URL")?;
    if !matches!(parsed.scheme(), "https" | "http" | "mailto" | "tel")
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err("Unsupported external URL".into());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn notify_unread(app: tauri::AppHandle, unread: u32, title: Option<String>) -> Result<(), String> {
    let main = app.get_webview_window("main");
    if let Some(main) = &main {
        main.set_badge_count(if unread == 0 {
            None
        } else {
            Some(unread as i64)
        })
        .map_err(|e| e.to_string())?;
    }
    if main
        .as_ref()
        .is_some_and(|w| w.is_focused().unwrap_or(false))
    {
        return Ok(());
    }
    if let Some(title) = title {
        app.notification()
            .builder()
            .title("Greenhouse")
            .body(title.chars().take(200).collect::<String>())
            .show()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> Result<bool, String> {
    if option_env!("GREENHOUSE_UPDATER_ENDPOINT")
        .unwrap_or("")
        .is_empty()
    {
        return Ok(false);
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let available = update.is_some();
    if let Some(update) = update {
        // This command is only called after the member chooses the menu item.
        update
            .download_and_install(|_, _| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(available)
}

fn queue_links(app: &tauri::AppHandle, urls: Vec<String>) {
    app.state::<Links>().0.lock().unwrap().extend(urls);
    let _ = window(app, "main");
    let _ = app.emit_to("main", "desktop:links", ());
}

fn main() {
    tauri::Builder::default()
        .manage(Links::default())
        .manage(Routes::default())
        .plugin(credentials::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_denylist(&["quick-ask", "settings"])
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = window(app, "quick-ask");
                    }
                })
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            menu::sync_places,
            notify_unread,
            take_links,
            take_routes,
            open_main,
            open_settings,
            close_window,
            open_external,
            check_update
        ])
        .setup(|app| {
            window(app.handle(), "main")?;
            menu::install(app.handle(), &[])?;
            app.global_shortcut().register("Control+Alt+Space")?;
            if let Some(urls) = app.deep_link().get_current()? {
                app.state::<Links>()
                    .0
                    .lock()
                    .unwrap()
                    .extend(urls.into_iter().map(|u| u.to_string()));
            }
            app.deep_link().on_open_url({
                let app = app.handle().clone();
                move |event| {
                    queue_links(&app, event.urls().iter().map(ToString::to_string).collect());
                }
            });
            Ok(())
        })
        .on_menu_event(|app, event| menu::dispatch(app, event.id().as_ref()))
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not start Greenhouse")
        .run(|app, event| {
            if let tauri::RunEvent::Reopen { .. } = event {
                let _ = window(app, "main");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn navigation_stays_in_the_bundled_client() {
        for raw in [
            "https://example.com",
            "greenhouse://chat",
            "file:///etc/passwd",
            "tauri://evil/index.html",
        ] {
            assert!(!local_url(&url::Url::parse(raw).unwrap()));
        }
        assert!(local_url(
            &url::Url::parse("tauri://localhost/chat?session=1").unwrap()
        ));
    }
}

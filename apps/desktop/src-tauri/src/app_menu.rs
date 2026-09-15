//! Native application menu.
//!
//! The menu exists before the webview mounts, but it deliberately owns no
//! preferences UI. Selecting Preferences only focuses the main window and emits a
//! semantic event; the hot-updatable web bundle decides what the dialog contains.
//!
//! View ▸ Zoom follows the same split: the menu is here because only a native menu
//! can show a macOS user that the command exists, but *what* a zoom step is (the
//! ladder of levels, and remembering the chosen one) lives in
//! `apps/web/src/lib/desktop/zoom.ts`.

use serde::Serialize;
use tauri::{App, Emitter, Runtime};

pub const EVENT_OPEN_PREFERENCES: &str = "desktop://open-preferences";
pub const EVENT_ZOOM: &str = "desktop://zoom";

const MENU_PREFERENCES: &str = "desktop_preferences";
const MENU_ZOOM_IN: &str = "desktop_zoom_in";
const MENU_ZOOM_OUT: &str = "desktop_zoom_out";
const MENU_ZOOM_RESET: &str = "desktop_zoom_reset";

/// Payload of [`EVENT_ZOOM`]. The shell names the intent, never the level.
#[derive(Serialize, Clone)]
struct ZoomCommand {
    command: &'static str,
}

#[cfg(target_os = "macos")]
pub fn install<R: Runtime>(app: &App<R>) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let about = PredefinedMenuItem::about(app, Some("About Greenhouse"), None)?;
    let preferences = MenuItem::with_id(
        app,
        MENU_PREFERENCES,
        "Preferences…",
        true,
        Some("CmdOrCtrl+,"),
    )?;
    let separator_1 = PredefinedMenuItem::separator(app)?;
    let services = PredefinedMenuItem::services(app, None)?;
    let separator_2 = PredefinedMenuItem::separator(app)?;
    let hide = PredefinedMenuItem::hide(app, None)?;
    let hide_others = PredefinedMenuItem::hide_others(app, None)?;
    let show_all = PredefinedMenuItem::show_all(app, None)?;
    let separator_3 = PredefinedMenuItem::separator(app)?;
    let quit = PredefinedMenuItem::quit(app, Some("Quit Greenhouse"))?;

    let greenhouse = Submenu::with_items(
        app,
        "Greenhouse",
        true,
        &[
            &about,
            &separator_1,
            &preferences,
            &services,
            &separator_2,
            &hide,
            &hide_others,
            &show_all,
            &separator_3,
            &quit,
        ],
    )?;

    // Installing a custom application menu replaces Tauri's default menu. Keep
    // the standard editing commands so Cmd+X/C/V/Z continue to be dispatched to
    // the focused webview field.
    let undo = PredefinedMenuItem::undo(app, None)?;
    let redo = PredefinedMenuItem::redo(app, None)?;
    let edit_separator_1 = PredefinedMenuItem::separator(app)?;
    let cut = PredefinedMenuItem::cut(app, None)?;
    let copy = PredefinedMenuItem::copy(app, None)?;
    let paste = PredefinedMenuItem::paste(app, None)?;
    let select_all = PredefinedMenuItem::select_all(app, None)?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &undo,
            &redo,
            &edit_separator_1,
            &cut,
            &copy,
            &paste,
            &select_all,
        ],
    )?;

    // Accelerators are `=` and `-`, not `+`/`Plus` — muda's accelerator parser has
    // no code for a literal `+`, and an unparseable accelerator fails this whole
    // function, which `setup` propagates: the app would not boot. The menu
    // therefore claims ⌘= and leaves ⌘⇧+ (a different modifier set, so AppKit does
    // not match it) to fall through to the webview, where the same ladder handles
    // it — that fallback is also the only path on Windows, which has no app menu.
    let zoom_in = MenuItem::with_id(app, MENU_ZOOM_IN, "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out = MenuItem::with_id(app, MENU_ZOOM_OUT, "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset = MenuItem::with_id(
        app,
        MENU_ZOOM_RESET,
        "Actual Size",
        true,
        Some("CmdOrCtrl+0"),
    )?;
    let view = Submenu::with_items(app, "View", true, &[&zoom_in, &zoom_out, &zoom_reset])?;

    let minimize = PredefinedMenuItem::minimize(app, None)?;
    let fullscreen = PredefinedMenuItem::fullscreen(app, None)?;
    let window = Submenu::with_items(app, "Window", true, &[&minimize, &fullscreen])?;

    app.set_menu(Menu::with_items(
        app,
        &[&greenhouse, &edit, &view, &window],
    )?)?;

    app.on_menu_event(|app, event| {
        let zoom = match event.id().as_ref() {
            MENU_PREFERENCES => {
                crate::windows::focus_main(app);
                if let Err(err) = app.emit(EVENT_OPEN_PREFERENCES, ()) {
                    log::warn!("[menu] could not open web preferences: {err}");
                }
                return;
            }
            MENU_ZOOM_IN => "in",
            MENU_ZOOM_OUT => "out",
            MENU_ZOOM_RESET => "reset",
            _ => return,
        };
        if let Err(err) = app.emit(EVENT_ZOOM, ZoomCommand { command: zoom }) {
            log::warn!("[menu] could not apply zoom {zoom}: {err}");
        }
    });

    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn install<R: Runtime>(_app: &App<R>) -> tauri::Result<()> {
    Ok(())
}

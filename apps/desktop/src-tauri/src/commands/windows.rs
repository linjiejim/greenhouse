//! Window and shortcut commands.

use crate::native::selection::Selection;
use crate::settings::{self, DesktopSettings, DesktopSettingsView};
use crate::shortcuts::{self, ShortcutMap};
use crate::state::DesktopState;
use crate::windows;
use tauri::{AppHandle, State};

#[tauri::command]
pub fn desktop_toggle_quick_window(
    app: AppHandle,
    state: State<'_, DesktopState>,
) -> Result<(), String> {
    let bootstrap = settings::bootstrap_script(&settings::effective_api_base(
        &state.settings().api_base_url,
        settings::api_base_locked(),
    ));
    windows::toggle_quick(&app, &bootstrap).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_hide_quick_window(app: AppHandle) {
    windows::hide_quick(&app);
}

#[tauri::command]
pub fn desktop_hide_selection_bar(app: AppHandle) {
    windows::hide_selection_bar(&app);
}

#[tauri::command]
pub fn desktop_set_selection_surface_mode(
    app: AppHandle,
    mode: windows::SelectionSurfaceMode,
) -> Result<(), String> {
    windows::set_selection_surface_mode(&app, mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_show_selection_bar(
    app: AppHandle,
    state: State<'_, DesktopState>,
    x: f64,
    y: f64,
) -> Result<(), String> {
    let bootstrap = settings::bootstrap_script(&settings::effective_api_base(
        &state.settings().api_base_url,
        settings::api_base_locked(),
    ));
    windows::present_selection_bar(&app, x, y, &bootstrap).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn desktop_focus_main_window(app: AppHandle) {
    windows::focus_main(&app);
}

/// Hand the pending selection to whichever satellite window asks first.
///
/// Consumed on read, so a stale selection can't be replayed into a later prompt.
#[tauri::command]
pub fn desktop_take_pending_selection(state: State<'_, DesktopState>) -> Option<Selection> {
    state.take_pending_selection()
}

/// Rebind shortcuts. Rejects the whole change if any accelerator is unusable, so the
/// user finds out at the point of editing rather than by a key silently not working.
#[tauri::command]
pub fn desktop_set_shortcuts(
    app: AppHandle,
    state: State<'_, DesktopState>,
    shortcuts_map: ShortcutMap,
) -> Result<DesktopSettingsView, String> {
    for (id, accelerator) in &shortcuts_map {
        if shortcuts::ShortcutId::parse(id).is_none() {
            return Err(format!("Unknown shortcut: {id}"));
        }
        if !shortcuts::is_valid_accelerator(accelerator) {
            return Err(format!("Not a usable shortcut: {accelerator}"));
        }
    }

    let previous = state.settings();
    crate::replace_shortcuts(&app, &shortcuts_map, &previous.shortcuts)?;

    let next = DesktopSettings {
        shortcuts: shortcuts_map,
        ..previous.clone()
    };
    if let Err(err) = settings::save(&state.app_data, &next) {
        let _ = crate::replace_shortcuts(&app, &previous.shortcuts, &next.shortcuts);
        return Err(err.to_string());
    }
    state.set_settings(next.clone());
    Ok(settings::view(&next, settings::api_base_locked()))
}

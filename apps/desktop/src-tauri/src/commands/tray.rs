//! Tray menu command — the web layer pushes the dropdown's content model.

use crate::tray::{self, TrayMenuModel};
use tauri::AppHandle;

/// Replace the tray dropdown with a web-owned model (labels, Agents, sessions).
///
/// Applied on the main thread because AppKit menus are main-thread only; the
/// command itself returns as soon as the update is scheduled.
#[tauri::command]
pub fn desktop_set_tray_menu(app: AppHandle, model: TrayMenuModel) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if let Err(err) = tray::apply(&handle, &model) {
            log::warn!("[tray] menu not applied: {err}");
        }
    })
    .map_err(|err| err.to_string())
}

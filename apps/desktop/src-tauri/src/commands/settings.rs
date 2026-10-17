//! Shell settings commands — currently just which server the app talks to.

use crate::settings::{self, DesktopSettings, DesktopSettingsView};
use crate::state::DesktopState;
use tauri::{Manager, State};

#[tauri::command]
pub fn desktop_get_settings(state: State<'_, DesktopState>) -> DesktopSettingsView {
    settings::view(&state.settings(), settings::api_base_locked())
}

/// Point the app at a different Greenhouse server. Refused when the build fixed one.
///
/// Saves the setting and reloads the window, but the new base reaches the page only in
/// a new process: the window's bootstrap script was built with the old base and a
/// reload re-runs it unchanged. The web app therefore restarts the app after a switch
/// (apps/web/src/lib/desktop/server.ts).
#[tauri::command]
pub fn desktop_set_api_base(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
    url: String,
) -> Result<DesktopSettingsView, String> {
    // Fail closed rather than silently no-op: a UI that shouldn't have offered this
    // control should hear about it, not appear to succeed.
    if settings::api_base_locked() {
        return Err("The server is fixed in this build and cannot be changed".into());
    }

    let normalized = settings::normalize_api_base(&url)
        .ok_or_else(|| format!("Not a valid server URL: {url}. Expected e.g. https://host:port"))?;

    let next = DesktopSettings {
        api_base_url: normalized,
        ..state.settings()
    };
    settings::save(&state.app_data, &next).map_err(|e| e.to_string())?;
    state.set_settings(next.clone());

    if let Some(window) = app.get_webview_window(crate::windows::MAIN) {
        // Ends the page bound to the old server; the web app then restarts the process.
        let _ = window.eval("window.location.reload()");
    }

    Ok(settings::view(&next, false))
}

//! Shell settings commands — currently just which server the app talks to.

use crate::settings::{self, DesktopSettings, DesktopSettingsView};
use crate::state::DesktopState;
use tauri::{Manager, State};

#[tauri::command]
pub fn desktop_get_settings(state: State<'_, DesktopState>) -> DesktopSettingsView {
    settings::view(&state.settings(), settings::api_base_locked())
}

/// Point the app at a different Greenhouse server. **Development builds only.**
///
/// Reloads the window rather than mutating anything live: the API base is injected
/// before app scripts run, and half the app (auth tokens, open websocket, cached
/// stores) is bound to the old server. A reload is the only coherent transition.
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
        // The bootstrap script re-runs on navigation, so a reload picks up the new base.
        let _ = window.eval("window.location.reload()");
    }

    Ok(settings::view(&next, false))
}

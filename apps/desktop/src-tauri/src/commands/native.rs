//! Native capability commands — the context-collection surface.
//!
//! These are the whole point of shipping a desktop app: pulling context in from
//! outside the browser sandbox so the user doesn't have to copy-paste it.
//!
//! Every one of them is also registered as an agent *client action* (see
//! `apps/web/src/lib/desktop/native-actions.ts`), which is why the read-user-data
//! ones are gated behind a confirmation on the web side.

use crate::native::capture::{self, Capture, CaptureMode};
use crate::native::perms::{self, PermissionStatus};
use crate::native::selection::{self, Selection};
use crate::native::{Availability, Permission};
use serde::Serialize;
use tauri::AppHandle;

/// Event emitted when the always-on watcher spots a new selection.
pub const EVENT_SELECTION: &str = "desktop://selection";
/// Event emitted once when the last observed selection is no longer active.
pub const EVENT_SELECTION_CLEARED: &str = "desktop://selection-cleared";

/// What this machine can actually do, so the UI can gate honestly rather than
/// offering buttons that quietly do nothing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopCapabilities {
    pub capture: Availability,
    pub selection: Availability,
    pub clipboard: Availability,
    pub permissions: PermissionStatus,
    /// Whether the always-on selection watcher is currently running.
    pub selection_watch: bool,
    /// macOS can drag out a region; elsewhere every mode captures the full screen.
    pub interactive_capture: bool,
}

#[tauri::command]
pub fn desktop_capabilities() -> DesktopCapabilities {
    DesktopCapabilities {
        capture: capture::availability(),
        selection: selection::availability(),
        clipboard: Availability::Available,
        permissions: perms::status(),
        selection_watch: selection::is_watching(),
        interactive_capture: cfg!(target_os = "macos"),
    }
}

#[tauri::command]
pub fn desktop_request_permission(permission: Permission) -> PermissionStatus {
    perms::request(permission)
}

/// Capture the screen. `null` means the user cancelled — not an error.
#[tauri::command]
pub async fn desktop_capture_screen(mode: CaptureMode) -> Result<Option<Capture>, String> {
    // `screencapture` blocks until the user finishes dragging, so this must not run
    // on the main thread or the whole UI freezes behind the crosshair.
    tauri::async_runtime::spawn_blocking(move || capture::capture(mode))
        .await
        .map_err(|e| format!("capture task failed: {e}"))?
}

/// Read the selection in whatever app currently has focus.
///
/// User-initiated, so a simulated ⌘C fallback is allowed when the app doesn't expose
/// its selection through Accessibility. The clipboard is restored afterwards.
#[tauri::command]
pub async fn desktop_read_selection() -> Result<Option<Selection>, String> {
    tauri::async_runtime::spawn_blocking(|| selection::read_selected_text(true))
        .await
        .map_err(|e| format!("selection task failed: {e}"))?
}

/// Turn the always-on selection watcher on or off, and remember the choice.
#[tauri::command]
pub fn desktop_set_selection_watch(
    app: AppHandle,
    state: tauri::State<'_, crate::state::DesktopState>,
    enabled: bool,
) -> Result<bool, String> {
    crate::start_selection_watch(&app, enabled)?;

    let next = crate::settings::DesktopSettings {
        selection_watch: enabled,
        ..state.settings()
    };
    crate::settings::save(&state.app_data, &next).map_err(|e| e.to_string())?;
    state.set_settings(next);

    Ok(selection::is_watching())
}

#[tauri::command]
pub fn desktop_read_clipboard() -> Result<Option<String>, String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("could not open the clipboard: {e}"))?;
    // An empty or non-text clipboard is a normal state, not a failure.
    Ok(clipboard.get_text().ok().filter(|t| !t.is_empty()))
}

#[tauri::command]
pub fn desktop_write_clipboard(text: String) -> Result<(), String> {
    let mut clipboard =
        arboard::Clipboard::new().map_err(|e| format!("could not open the clipboard: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("could not write the clipboard: {e}"))
}

// ─── Files ───────────────────────────────────────────────
//
// There is deliberately no file-read command here. The webview's own
// `<input type="file">` / paste / drag-drop already hand the composer real File
// objects, and everything a chat can swallow is capped at /api/upload's 5 MB
// anyway — a native picker bought nothing the browser did not already do, so the
// grant table and its two commands were removed (2026-08-17). If a future need
// is genuinely native (streaming a file too large to upload, reading a slice of
// one), it needs its own named command and its own justification, not a revival
// of "read any path the user once clicked".

/// Reveal a path in Finder / Explorer.
#[tauri::command]
pub fn desktop_reveal_in_file_manager(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .reveal_item_in_dir(&path)
        .map_err(|e| format!("could not reveal {path}: {e}"))
}

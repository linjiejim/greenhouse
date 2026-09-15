//! System-level commands: what the shell is, and the hot-update boot handshake.

use crate::bundle::{self, ActiveBundle};
use crate::state::DesktopState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInfo {
    /// Installed app's user-facing version, sourced from root package.json.
    pub shell_version: String,
    /// Web bundle currently loaded: the baseline shipped in the app, or a staged one.
    pub web_bundle_version: String,
    pub active_bundle: ActiveBundle,
    pub platform: &'static str,
    pub arch: &'static str,
}

/// Baseline web bundle version, stamped in at build time from
/// `apps/desktop/package.json#webBundleVersion`.
pub const BASELINE_WEB_BUNDLE_VERSION: &str = match option_env!("GREENHOUSE_WEB_BUNDLE_VERSION") {
    Some(v) => v,
    None => "0",
};

/// User-facing product version, sourced from the repository root package.json.
pub const APP_VERSION: &str = match option_env!("GREENHOUSE_APP_VERSION") {
    Some(v) => v,
    None => "0.0.0",
};

/// Native command compatibility line. Web bundles use this for minShellVersion;
/// it only changes when the Rust command surface changes.
pub const NATIVE_API_VERSION: &str = match option_env!("GREENHOUSE_NATIVE_API_VERSION") {
    Some(v) => v,
    None => "0.0.0",
};

#[tauri::command]
pub fn desktop_info(state: State<'_, DesktopState>) -> DesktopInfo {
    let web_bundle_version = match &state.active_bundle {
        ActiveBundle::Staged { version, .. } => version.clone(),
        ActiveBundle::Baseline { .. } => BASELINE_WEB_BUNDLE_VERSION.to_string(),
    };

    DesktopInfo {
        shell_version: APP_VERSION.to_string(),
        web_bundle_version,
        active_bundle: state.active_bundle.clone(),
        platform: std::env::consts::OS,
        arch: std::env::consts::ARCH,
    }
}

/// Called by the web app once it has successfully mounted.
///
/// This disarms the boot watchdog: without it, a hot-update bundle that white-screens
/// would be rolled back on the next launch (see `bundle::resolve_active`).
#[tauri::command]
pub fn desktop_mark_boot_ok(state: State<'_, DesktopState>) -> Result<(), String> {
    log::info!("[boot] web app reported a successful mount");
    bundle::clear_boot_pending(&state.app_data).map_err(|e| e.to_string())
}

/// Severity for a log line forwarded from the web layer.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

/// Write a web-layer message into the shell's log file.
///
/// Without this, a packaged app's log contains nothing from the webview: browser
/// console output goes nowhere, and there are no devtools on a release build. A user
/// reporting "it just hangs" left us with a log full of window-resize events — which
/// is how the login hang stayed invisible.
#[tauri::command]
pub fn desktop_log(level: LogLevel, message: String) {
    // Truncate: this is called from a console hook, and one runaway loop should not
    // be able to fill the user's disk.
    let message: String = message.chars().take(2000).collect();
    match level {
        LogLevel::Debug => log::debug!("[web] {message}"),
        LogLevel::Info => log::info!("[web] {message}"),
        LogLevel::Warn => log::warn!("[web] {message}"),
        LogLevel::Error => log::error!("[web] {message}"),
    }
}

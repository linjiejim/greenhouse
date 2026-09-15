//! OS permission state.
//!
//! macOS gates the two capabilities this app most depends on. Both fail *silently*
//! when not granted — an event tap is created successfully but delivers no events,
//! and a screen capture returns a desktop-picture-only image. So the app has to ask
//! the OS what it's allowed to do, up front, and tell the user; there's no way to
//! infer it from a failed call.

use super::Permission;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionStatus {
    pub accessibility: bool,
    pub screen_recording: bool,
    /// False on platforms where these grants don't exist, so the UI can hide the
    /// whole section rather than showing two meaningless green ticks.
    pub applicable: bool,
}

#[cfg(target_os = "macos")]
pub fn status() -> PermissionStatus {
    PermissionStatus {
        accessibility: unsafe { accessibility_sys::AXIsProcessTrusted() },
        screen_recording: core_graphics::access::ScreenCaptureAccess.preflight(),
        applicable: true,
    }
}

#[cfg(not(target_os = "macos"))]
pub fn status() -> PermissionStatus {
    PermissionStatus {
        accessibility: true,
        screen_recording: true,
        applicable: false,
    }
}

/// Ask the OS to prompt for a permission.
///
/// macOS only shows its own dialog once per app, ever; after that the call is a
/// no-op and the user has to go to System Settings themselves. So this also opens
/// the relevant settings pane, which is the only reliably useful action on a second
/// attempt.
#[cfg(target_os = "macos")]
pub fn request(permission: Permission) -> PermissionStatus {
    match permission {
        Permission::Accessibility => {
            request_accessibility_prompt();
            open_settings_pane("Privacy_Accessibility");
        }
        Permission::ScreenRecording => {
            core_graphics::access::ScreenCaptureAccess.request();
            open_settings_pane("Privacy_ScreenCapture");
        }
    }
    status()
}

#[cfg(not(target_os = "macos"))]
pub fn request(_permission: Permission) -> PermissionStatus {
    status()
}

#[cfg(target_os = "macos")]
fn request_accessibility_prompt() {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;

    let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
    let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
    unsafe {
        accessibility_sys::AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const _);
    }
}

#[cfg(target_os = "macos")]
fn open_settings_pane(anchor: &str) {
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    let _ = std::process::Command::new("open").arg(url).spawn();
}

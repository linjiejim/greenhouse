//! Shared shell state, resolved once at startup and read by commands.

use crate::bundle::ActiveBundle;
use crate::native::selection::Selection;
use crate::settings::DesktopSettings;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct DesktopState {
    /// Root of the app data dir (`~/Library/Application Support/<bundle identifier>`).
    pub app_data: PathBuf,
    /// Which web bundle this launch booted from — baseline or a staged hot update.
    /// Fixed for the lifetime of the process: swapping bundles requires a restart.
    pub active_bundle: ActiveBundle,
    settings: Mutex<DesktopSettings>,
    /// Selection waiting to be picked up by the floating bar. Handed over rather than
    /// passed in the URL: selections can be long, and URL-encoding them is a trap.
    pending_selection: Mutex<Option<Selection>>,
}

impl DesktopState {
    pub fn new(app_data: PathBuf, active_bundle: ActiveBundle, settings: DesktopSettings) -> Self {
        Self {
            app_data,
            active_bundle,
            settings: Mutex::new(settings),
            pending_selection: Mutex::new(None),
        }
    }

    pub fn settings(&self) -> DesktopSettings {
        self.settings
            .lock()
            .expect("settings mutex poisoned")
            .clone()
    }

    pub fn set_settings(&self, next: DesktopSettings) {
        *self.settings.lock().expect("settings mutex poisoned") = next;
    }

    pub fn set_pending_selection(&self, selection: Selection) {
        *self
            .pending_selection
            .lock()
            .expect("pending selection mutex poisoned") = Some(selection);
    }

    pub fn clear_pending_selection(&self) {
        *self
            .pending_selection
            .lock()
            .expect("pending selection mutex poisoned") = None;
    }

    /// Read and clear — a selection is consumed once, by whichever window asks first.
    pub fn take_pending_selection(&self) -> Option<Selection> {
        self.pending_selection
            .lock()
            .expect("pending selection mutex poisoned")
            .take()
    }
}

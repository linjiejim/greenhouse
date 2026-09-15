//! Global shortcuts.
//!
//! These are what make the app reachable without switching to it — the difference
//! between "a website in a window" and something that collects context wherever the
//! user already is.
//!
//! The shell owns registration but does almost nothing itself: each shortcut just
//! emits an event, and the web layer decides what it means. That keeps behaviour
//! hot-updatable while only the key bindings live in native code.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::str::FromStr;

/// Event emitted when a registered shortcut fires. Payload: `{ "id": <ShortcutId> }`.
pub const EVENT_SHORTCUT: &str = "desktop://shortcut";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShortcutId {
    /// Bring the main application window to the front.
    FocusMain,
    /// Bring up the small always-on-top composer.
    QuickCapture,
    /// Capture a region of the screen and hand it to the agent.
    Screenshot,
    /// Read the current selection and hand it to the agent.
    Selection,
}

impl ShortcutId {
    pub const ALL: [ShortcutId; 4] = [
        Self::FocusMain,
        Self::QuickCapture,
        Self::Screenshot,
        Self::Selection,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::FocusMain => "focus_main",
            Self::QuickCapture => "quick_capture",
            Self::Screenshot => "screenshot",
            Self::Selection => "selection",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|id| id.as_str() == raw)
    }

    /// `CmdOrCtrl` resolves per-platform, so one default works everywhere.
    pub fn default_accelerator(self) -> &'static str {
        match self {
            Self::FocusMain => "CmdOrCtrl+G",
            // Deliberately NOT ⌘⇧3/4 — those are macOS's own screenshot shortcuts.
            Self::QuickCapture => "CmdOrCtrl+Shift+Space",
            Self::Screenshot => "CmdOrCtrl+Shift+2",
            Self::Selection => "CmdOrCtrl+Shift+K",
        }
    }
}

/// Accelerator per shortcut, as stored in settings. Missing entries fall back to the
/// default, so a partial settings file still yields a fully working set.
pub type ShortcutMap = BTreeMap<String, String>;

pub fn defaults() -> ShortcutMap {
    ShortcutId::ALL
        .into_iter()
        .map(|id| {
            (
                id.as_str().to_string(),
                id.default_accelerator().to_string(),
            )
        })
        .collect()
}

/// Merge stored bindings over the defaults, dropping anything unusable.
///
/// An unparseable accelerator is skipped rather than fatal: one bad hand-edited
/// binding shouldn't cost the user every other shortcut.
pub fn resolve(stored: &ShortcutMap) -> Vec<(ShortcutId, String)> {
    ShortcutId::ALL
        .into_iter()
        .map(|id| {
            let accelerator = stored
                .get(id.as_str())
                .filter(|raw| is_valid_accelerator(raw))
                .cloned()
                .unwrap_or_else(|| id.default_accelerator().to_string());
            (id, accelerator)
        })
        .collect()
}

pub fn is_valid_accelerator(raw: &str) -> bool {
    !raw.trim().is_empty() && tauri_plugin_global_shortcut::Shortcut::from_str(raw.trim()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_round_trip_through_their_wire_names() {
        for id in ShortcutId::ALL {
            assert_eq!(ShortcutId::parse(id.as_str()), Some(id));
        }
        assert_eq!(ShortcutId::parse("nope"), None);
    }

    #[test]
    fn every_shortcut_has_a_registrable_default() {
        for id in ShortcutId::ALL {
            assert!(
                is_valid_accelerator(id.default_accelerator()),
                "{} has an unregistrable default: {}",
                id.as_str(),
                id.default_accelerator()
            );
        }
    }

    #[test]
    fn defaults_cover_every_shortcut() {
        assert_eq!(defaults().len(), ShortcutId::ALL.len());
    }

    #[test]
    fn stored_bindings_override_defaults() {
        let mut stored = ShortcutMap::new();
        stored.insert("screenshot".into(), "CmdOrCtrl+Alt+5".into());

        let resolved = resolve(&stored);
        let screenshot = resolved
            .iter()
            .find(|(id, _)| *id == ShortcutId::Screenshot)
            .unwrap();
        assert_eq!(screenshot.1, "CmdOrCtrl+Alt+5");

        // Untouched entries keep their defaults.
        let quick = resolved
            .iter()
            .find(|(id, _)| *id == ShortcutId::QuickCapture)
            .unwrap();
        assert_eq!(quick.1, ShortcutId::QuickCapture.default_accelerator());
    }

    #[test]
    fn an_unusable_binding_falls_back_instead_of_disabling_the_shortcut() {
        let mut stored = ShortcutMap::new();
        stored.insert("selection".into(), "not a shortcut".into());
        stored.insert("screenshot".into(), "   ".into());

        let resolved = resolve(&stored);
        assert_eq!(resolved.len(), ShortcutId::ALL.len());
        for (id, accelerator) in resolved {
            assert!(
                is_valid_accelerator(&accelerator),
                "{} resolved to something unregistrable: {accelerator}",
                id.as_str()
            );
        }
    }
}

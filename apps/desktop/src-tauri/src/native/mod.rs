//! Platform-specific capability implementations.
//!
//! Each submodule exposes the same API on every platform and reports honestly when
//! the current platform can't do something — `Capability::Unsupported { reason }`
//! rather than a silent no-op. That matters because the web layer advertises these
//! to the user *and to the agent*: a capability that claims to work and then does
//! nothing is worse than one that says it can't.

pub mod capture;
pub mod perms;
pub mod selection;

/// Whether a capability can run right now, and if not, why.
///
/// `NeedsPermission` is deliberately distinct from `Unsupported`: the first is
/// actionable by the user, the second never will be, and the UI says different
/// things for each.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum Availability {
    Available,
    NeedsPermission {
        permission: Permission,
    },
    // Constructed only under the `target_os` arms that lack an implementation, so it
    // reads as dead code on any single platform while being load-bearing overall.
    #[allow(dead_code)]
    Unsupported {
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Permission {
    /// macOS Accessibility — required to observe global input and read selections.
    Accessibility,
    /// macOS Screen Recording — required to capture anything but our own window.
    ScreenRecording,
}

impl Availability {
    /// See the note on `Unsupported` — only some platforms call this.
    #[allow(dead_code)]
    pub fn unsupported(reason: impl Into<String>) -> Self {
        Availability::Unsupported {
            reason: reason.into(),
        }
    }
}

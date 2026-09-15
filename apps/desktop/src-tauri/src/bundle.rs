//! Staged web-bundle pointer — which hot-update bundle (if any) is active.
//!
//! Layout under the app data dir:
//!
//! ```text
//! web-bundles/
//!   current.json      { webBundleVersion, dir, bootPending }
//!   v4/               extracted, already-verified bundle
//!   v3/               previous bundle, kept for rollback
//! ```
//!
//! Download + signature verification live in `updater::web_bundle` (they decide
//! what gets written here). This module only answers "what should we boot from",
//! and owns the self-heal rule that makes hot updates safe to ship:
//!
//! A downloaded bundle is staged with `bootPending=false`. When the next launch
//! selects it, `bootPending` is set immediately before the window opens and cleared
//! when the web app reports a successful mount. If a later start still sees it set,
//! that attempted boot never finished — so we fall back to the embedded baseline
//! instead of handing the user a second white screen.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const BUNDLES_DIRNAME: &str = "web-bundles";
pub const POINTER_FILENAME: &str = "current.json";

/// The `current.json` pointer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BundlePointer {
    /// Monotonic bundle version (string, matching the manifest on the update source).
    pub web_bundle_version: String,
    /// Directory name under `web-bundles/`, e.g. `v4`.
    pub dir: String,
    /// Set immediately before a staged bundle is loaded, then cleared once mounted.
    #[serde(default)]
    pub boot_pending: bool,
}

/// Why we are (or aren't) booting from a staged bundle. Surfaced in `desktop_info()`
/// so the settings page can explain itself instead of silently showing "baseline".
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ActiveBundle {
    /// No pointer, or the pointer is unusable — the embedded baseline is in use.
    Baseline {
        reason: BaselineReason,
        /// Set only for `RolledBackAfterFailedBoot`: the version we backed out of.
        rolled_back_from: Option<String>,
    },
    /// Booting from a staged hot-update bundle.
    Staged { version: String, dir: PathBuf },
}

impl ActiveBundle {
    /// Baseline with no rollback context — the common case.
    fn baseline(reason: BaselineReason) -> Self {
        Self::Baseline {
            reason,
            rolled_back_from: None,
        }
    }
}

/// Kept a flat unit enum (serializing to a bare string) rather than carrying data
/// per-variant: the TypeScript mirror in `apps/web/src/lib/desktop/types.ts` stays a
/// plain union instead of a discriminated object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BaselineReason {
    /// Nothing has ever been staged.
    NoPointer,
    /// The pointer file exists but couldn't be parsed.
    PointerUnreadable,
    /// The pointer names a directory that isn't there (or has no index.html).
    BundleMissing,
    /// The previous launch of this bundle never reported a successful boot.
    RolledBackAfterFailedBoot,
}

/// `<app_data>/web-bundles`
pub fn bundles_root(app_data: &Path) -> PathBuf {
    app_data.join(BUNDLES_DIRNAME)
}

/// `<app_data>/web-bundles/current.json`
pub fn pointer_path(app_data: &Path) -> PathBuf {
    bundles_root(app_data).join(POINTER_FILENAME)
}

pub fn read_pointer(app_data: &Path) -> Option<Result<BundlePointer, ()>> {
    let raw = std::fs::read_to_string(pointer_path(app_data)).ok()?;
    Some(serde_json::from_str(&raw).map_err(|_| ()))
}

/// Atomically write the pointer (temp file + rename), so a crash mid-write can
/// never leave a half-written pointer that bricks the next launch.
pub fn write_pointer(app_data: &Path, pointer: &BundlePointer) -> std::io::Result<()> {
    let root = bundles_root(app_data);
    std::fs::create_dir_all(&root)?;
    let tmp = root.join(format!("{POINTER_FILENAME}.tmp"));
    let body = serde_json::to_vec_pretty(pointer)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(tmp, pointer_path(app_data))
}

/// Decide what to boot from, and self-heal a bundle that failed to boot last time.
///
/// Called once at startup. When it returns `RolledBackAfterFailedBoot` the pointer
/// has already been removed, so the next launch starts clean on the baseline.
pub fn resolve_active(app_data: &Path) -> ActiveBundle {
    let Some(parsed) = read_pointer(app_data) else {
        return ActiveBundle::baseline(BaselineReason::NoPointer);
    };
    let Ok(pointer) = parsed else {
        return ActiveBundle::baseline(BaselineReason::PointerUnreadable);
    };

    if pointer.boot_pending {
        // Staged last launch, never confirmed booting → assume it's broken.
        let _ = std::fs::remove_file(pointer_path(app_data));
        return ActiveBundle::Baseline {
            reason: BaselineReason::RolledBackAfterFailedBoot,
            rolled_back_from: Some(pointer.web_bundle_version),
        };
    }

    let dir = bundles_root(app_data).join(&pointer.dir);
    if !dir.join(crate::protocol::INDEX).is_file() {
        return ActiveBundle::baseline(BaselineReason::BundleMissing);
    }

    ActiveBundle::Staged {
        version: pointer.web_bundle_version,
        dir,
    }
}

/// Arm the boot watchdog for the bundle we're about to load.
///
/// Set right before the window opens; `clear_boot_pending` is called when the web
/// app reports it mounted. Nothing to do when we're already on the baseline —
/// the baseline is what we roll *back* to, so it can't be rolled back further.
pub fn arm_boot_watchdog(app_data: &Path, active: &ActiveBundle) -> std::io::Result<()> {
    let ActiveBundle::Staged { version, dir } = active else {
        return Ok(());
    };
    let dir_name = dir
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    write_pointer(
        app_data,
        &BundlePointer {
            web_bundle_version: version.clone(),
            dir: dir_name,
            boot_pending: true,
        },
    )
}

/// Disarm the watchdog — the web app booted successfully.
pub fn clear_boot_pending(app_data: &Path) -> std::io::Result<()> {
    let Some(Ok(pointer)) = read_pointer(app_data) else {
        return Ok(());
    };
    if !pointer.boot_pending {
        return Ok(());
    }
    write_pointer(
        app_data,
        &BundlePointer {
            boot_pending: false,
            ..pointer
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn stage(app_data: &Path, dir: &str) {
        let d = bundles_root(app_data).join(dir);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(crate::protocol::INDEX), b"<html></html>").unwrap();
    }

    #[test]
    fn no_pointer_means_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(
            resolve_active(tmp.path()),
            ActiveBundle::baseline(BaselineReason::NoPointer)
        );
    }

    #[test]
    fn unreadable_pointer_means_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        fs::create_dir_all(bundles_root(tmp.path())).unwrap();
        fs::write(pointer_path(tmp.path()), b"{not json").unwrap();
        assert_eq!(
            resolve_active(tmp.path()),
            ActiveBundle::baseline(BaselineReason::PointerUnreadable)
        );
    }

    #[test]
    fn pointer_to_missing_dir_means_baseline() {
        let tmp = tempfile::tempdir().unwrap();
        write_pointer(
            tmp.path(),
            &BundlePointer {
                web_bundle_version: "4".into(),
                dir: "v4".into(),
                boot_pending: false,
            },
        )
        .unwrap();
        assert_eq!(
            resolve_active(tmp.path()),
            ActiveBundle::baseline(BaselineReason::BundleMissing)
        );
    }

    #[test]
    fn staged_bundle_is_used() {
        let tmp = tempfile::tempdir().unwrap();
        stage(tmp.path(), "v4");
        write_pointer(
            tmp.path(),
            &BundlePointer {
                web_bundle_version: "4".into(),
                dir: "v4".into(),
                boot_pending: false,
            },
        )
        .unwrap();
        assert_eq!(
            resolve_active(tmp.path()),
            ActiveBundle::Staged {
                version: "4".into(),
                dir: bundles_root(tmp.path()).join("v4"),
            }
        );
    }

    #[test]
    fn bundle_that_never_booted_is_rolled_back_and_pointer_removed() {
        let tmp = tempfile::tempdir().unwrap();
        stage(tmp.path(), "v4");
        write_pointer(
            tmp.path(),
            &BundlePointer {
                web_bundle_version: "4".into(),
                dir: "v4".into(),
                boot_pending: true,
            },
        )
        .unwrap();

        assert_eq!(
            resolve_active(tmp.path()),
            ActiveBundle::Baseline {
                reason: BaselineReason::RolledBackAfterFailedBoot,
                rolled_back_from: Some("4".into()),
            }
        );
        // The pointer is gone, so the *next* launch starts clean rather than
        // re-reporting a rollback forever.
        assert!(!pointer_path(tmp.path()).exists());
        assert_eq!(
            resolve_active(tmp.path()),
            ActiveBundle::baseline(BaselineReason::NoPointer)
        );
    }

    #[test]
    fn arm_then_clear_survives_a_restart() {
        let tmp = tempfile::tempdir().unwrap();
        stage(tmp.path(), "v5");
        let active = ActiveBundle::Staged {
            version: "5".into(),
            dir: bundles_root(tmp.path()).join("v5"),
        };

        arm_boot_watchdog(tmp.path(), &active).unwrap();
        assert!(read_pointer(tmp.path()).unwrap().unwrap().boot_pending);

        clear_boot_pending(tmp.path()).unwrap();
        assert!(!read_pointer(tmp.path()).unwrap().unwrap().boot_pending);
        // And a restart now keeps the staged bundle instead of rolling back.
        assert_eq!(resolve_active(tmp.path()), active);
    }

    /// The wire shape is a contract with `apps/web/src/lib/desktop/types.ts`.
    /// Pinning it here means a Rust-side rename fails a test instead of silently
    /// producing `undefined` in the settings page.
    #[test]
    fn active_bundle_serializes_to_the_shape_typescript_expects() {
        let staged = serde_json::to_value(ActiveBundle::Staged {
            version: "4".into(),
            dir: PathBuf::from("/tmp/web-bundles/v4"),
        })
        .unwrap();
        assert_eq!(
            staged,
            serde_json::json!({ "kind": "staged", "version": "4", "dir": "/tmp/web-bundles/v4" })
        );

        let rolled_back = serde_json::to_value(ActiveBundle::Baseline {
            reason: BaselineReason::RolledBackAfterFailedBoot,
            rolled_back_from: Some("4".into()),
        })
        .unwrap();
        assert_eq!(
            rolled_back,
            serde_json::json!({
                "kind": "baseline",
                "reason": "rolled_back_after_failed_boot",
                "rolledBackFrom": "4"
            })
        );

        let clean =
            serde_json::to_value(ActiveBundle::baseline(BaselineReason::NoPointer)).unwrap();
        assert_eq!(
            clean,
            serde_json::json!({ "kind": "baseline", "reason": "no_pointer", "rolledBackFrom": null })
        );
    }

    #[test]
    fn arming_on_baseline_is_a_no_op() {
        let tmp = tempfile::tempdir().unwrap();
        arm_boot_watchdog(
            tmp.path(),
            &ActiveBundle::baseline(BaselineReason::NoPointer),
        )
        .unwrap();
        assert!(!pointer_path(tmp.path()).exists());
    }
}

//! Update commands, covering both lines: web bundle and shell.

use crate::bundle::ActiveBundle;
use crate::commands::system::{BASELINE_WEB_BUNDLE_VERSION, NATIVE_API_VERSION};
use crate::settings;
use crate::state::DesktopState;
use crate::updater::web_bundle::{self, UpdateOutcome, WebReleaseNotes};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

/// Channel to pull updates from. `stable` unless overridden at launch, which is how
/// a tester opts into `beta` without a separate build.
fn channel() -> String {
    std::env::var("GREENHOUSE_UPDATE_CHANNEL").unwrap_or_else(|_| "stable".into())
}

/// The shell updater, pointed at this build's update source.
///
/// The endpoint is derived at runtime from the same base that serves the web-bundle
/// manifest and the release index, rather than frozen into `tauri.conf.json` — so
/// the three documents a client trusts can never come from different places, and a
/// deployment that builds its own shell only has to set `GREENHOUSE_DESKTOP_*`.
fn shell_updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    use tauri::Manager;
    use tauri_plugin_updater::UpdaterExt;

    let state = app.state::<DesktopState>();
    let api_base =
        settings::effective_api_base(&state.settings().api_base_url, settings::api_base_locked());
    let endpoint = format!(
        "{}/{}/app/latest.json",
        settings::update_base(&api_base),
        channel()
    );
    let endpoint: tauri::Url = endpoint
        .parse()
        .map_err(|e| format!("update endpoint is not a URL: {e}"))?;
    app.updater_builder()
        .endpoints(vec![endpoint])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum WebUpdateResult {
    /// Downloaded and verified; takes effect on the next launch.
    Staged {
        version: String,
        release_notes: Option<WebReleaseNotes>,
        downloaded: bool,
    },
    UpToDate,
    /// A newer bundle exists but this shell is too old to run it.
    NeedsNewerShell {
        required: String,
    },
}

/// Check for a newer web bundle and stage it.
///
/// Staging never touches the running app — the swap happens at next launch, guarded
/// by the boot watchdog. So this is safe to call in the background.
#[tauri::command]
pub async fn desktop_check_web_update(
    state: State<'_, DesktopState>,
) -> Result<WebUpdateResult, String> {
    let app_data = state.app_data.clone();
    let api_base =
        settings::effective_api_base(&state.settings().api_base_url, settings::api_base_locked());
    let update_base = settings::update_base(&api_base);
    let active_version = match &state.active_bundle {
        ActiveBundle::Staged { version, .. } => version.clone(),
        ActiveBundle::Baseline { .. } => BASELINE_WEB_BUNDLE_VERSION.to_string(),
    };
    let pending = pending_update(&app_data, &active_version);
    let current = pending
        .as_ref()
        .map(|pending| pending.version.clone())
        .unwrap_or_else(|| active_version.clone());

    let outcome = web_bundle::check_and_stage(
        &app_data,
        &update_base,
        &channel(),
        NATIVE_API_VERSION,
        &current,
        &active_version,
    )
    .await?;

    Ok(match outcome {
        UpdateOutcome::Staged {
            version,
            release_notes,
        } => {
            log::info!("[update] staged web bundle v{version}");
            WebUpdateResult::Staged {
                version,
                release_notes,
                downloaded: true,
            }
        }
        UpdateOutcome::UpToDate => pending
            .map(|pending| WebUpdateResult::Staged {
                version: pending.version,
                release_notes: pending.release_notes,
                downloaded: false,
            })
            .unwrap_or(WebUpdateResult::UpToDate),
        UpdateOutcome::NeedsNewerShell { required } => {
            log::info!("[update] web bundle needs shell >= {required}");
            pending
                .map(|pending| WebUpdateResult::Staged {
                    version: pending.version,
                    release_notes: pending.release_notes,
                    downloaded: false,
                })
                .unwrap_or(WebUpdateResult::NeedsNewerShell { required })
        }
    })
}

struct PendingUpdate {
    version: String,
    release_notes: Option<WebReleaseNotes>,
}

/// Return a verified bundle that is newer than what this process is serving.
///
/// This makes checks latest-wins without re-downloading the same pending version.
fn pending_update(app_data: &Path, active_version: &str) -> Option<PendingUpdate> {
    let pointer = bundle_pointer(app_data)?;
    if pointer.boot_pending || !web_bundle::is_newer(&pointer.web_bundle_version, active_version) {
        return None;
    }
    let dir = crate::bundle::bundles_root(app_data).join(pointer.dir);
    if !dir.join(crate::protocol::INDEX).is_file() {
        return None;
    }
    Some(PendingUpdate {
        release_notes: web_bundle::release_notes_for_bundle(&dir, &pointer.web_bundle_version),
        version: pointer.web_bundle_version,
    })
}

fn bundle_pointer(app_data: &Path) -> Option<crate::bundle::BundlePointer> {
    crate::bundle::read_pointer(app_data)?.ok()
}

/// Restart so a staged web bundle takes effect.
#[tauri::command]
pub fn desktop_restart(app: tauri::AppHandle) {
    app.restart()
}

/// Outcome of an in-app shell update attempt.
#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ShellUpdateResult {
    /// Downloaded, verified (minisign) and installed over the current .app;
    /// call `desktop_restart` to run the new shell.
    Installed { version: String },
    /// The updater feed has nothing newer than this shell — typically the release
    /// is still being published (the web line can land minutes before the app line).
    UpToDate,
}

/// A downloaded shell update, waiting for the user to restart into it.
///
/// Kept in memory instead of being installed on arrival, because installing swaps
/// the `.app` **under the running process** — which may still be serving baseline
/// web assets out of it (`assets.rs`), hash-named files the replacement no longer
/// contains. Today that window is a second wide because an install is immediately
/// followed by a restart. Holding the payload here is what lets the *download* move
/// to the background without widening it.
struct PreparedShellUpdate {
    version: String,
    update: tauri_plugin_updater::Update,
    payload: Vec<u8>,
}

/// At most one prepared update: a later release supersedes an earlier one, and
/// there is never a reason to install anything but the newest.
static PREPARED_SHELL_UPDATE: Mutex<Option<PreparedShellUpdate>> = Mutex::new(None);

fn prepared_shell_version() -> Option<String> {
    PREPARED_SHELL_UPDATE
        .lock()
        .ok()?
        .as_ref()
        .map(|prepared| prepared.version.clone())
}

/// Outcome of a background shell-update preparation.
#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum ShellUpdatePreparation {
    /// Downloaded and signature-checked; installing is now a local file swap.
    Ready {
        version: String,
    },
    UpToDate,
}

/// Check for a newer shell and download it, without installing anything.
///
/// The app line's counterpart to `desktop_check_web_update`: the web layer calls it
/// on the same schedule, so a shell release reaches people the same way a web bundle
/// does — quietly in the background, surfacing only as a restart prompt. Before this
/// existed the download ran in the foreground while the user watched a spinner, which
/// on the real update source means minutes (see the installer command below).
#[tauri::command]
pub async fn desktop_prepare_shell_update(
    app: tauri::AppHandle,
) -> Result<ShellUpdatePreparation, String> {
    let updater = shell_updater(&app)?;
    let update = match updater.check().await.map_err(|err| err.to_string())? {
        Some(update) => update,
        None => return Ok(ShellUpdatePreparation::UpToDate),
    };

    // Already have this one. Without the check, every 4h tick would re-download it.
    if prepared_shell_version().as_deref() == Some(update.version.as_str()) {
        return Ok(ShellUpdatePreparation::Ready {
            version: update.version,
        });
    }

    log::info!(
        "[update] downloading shell v{} in the background",
        update.version
    );
    let payload = update
        .download(|_, _| {}, || {})
        .await
        .map_err(|err| err.to_string())?;
    log::info!(
        "[update] shell v{} downloaded; installs on restart",
        update.version
    );

    let version = update.version.clone();
    *PREPARED_SHELL_UPDATE
        .lock()
        .map_err(|_| "shell update state is poisoned")? = Some(PreparedShellUpdate {
        version: version.clone(),
        update,
        payload,
    });
    Ok(ShellUpdatePreparation::Ready { version })
}

/// Install a newer shell over the current .app; restart to run it.
///
/// Normally instant, because `desktop_prepare_shell_update` already downloaded the
/// payload in the background — this is then a local extract and swap. The fallback
/// path (check + download + install) is what runs when the user reaches for the
/// button before the background pass has produced anything.
///
/// The install replaces the .app on disk while the running process keeps serving the
/// old binary, so a failure here leaves a fully working app behind.
#[tauri::command]
pub async fn desktop_install_shell_update(
    app: tauri::AppHandle,
) -> Result<ShellUpdateResult, String> {
    let prepared = PREPARED_SHELL_UPDATE
        .lock()
        .map_err(|_| "shell update state is poisoned")?
        .take();
    if let Some(prepared) = prepared {
        return match prepared.update.install(&prepared.payload) {
            Ok(()) => {
                log::info!(
                    "[update] shell v{} installed from the background download",
                    prepared.version
                );
                Ok(ShellUpdateResult::Installed {
                    version: prepared.version,
                })
            }
            Err(err) => {
                // Put it back: a failed install must not cost the user another
                // multi-minute download when they retry.
                let message = format!("could not install shell v{}: {err}", prepared.version);
                if let Ok(mut slot) = PREPARED_SHELL_UPDATE.lock() {
                    *slot = Some(prepared);
                }
                Err(message)
            }
        };
    }

    let updater = shell_updater(&app)?;
    let update = match updater.check().await.map_err(|err| err.to_string())? {
        Some(update) => update,
        None => return Ok(ShellUpdateResult::UpToDate),
    };

    log::info!("[update] downloading shell v{}", update.version);
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|err| err.to_string())?;
    log::info!(
        "[update] shell v{} installed, restart to apply",
        update.version
    );
    Ok(ShellUpdateResult::Installed {
        version: update.version.clone(),
    })
}

// ─── Manual installer download ───────────────────────────
//
// The in-app updater above is the smooth path, but it is a single path: when it
// fails, or when someone would rather install the package themselves, the only
// remaining option used to be "open the web app in a browser". These three pieces
// close that gap without opening a general-purpose hatch — see the command's doc.

/// The published release index (`<channel>/app/downloads.json`).
///
/// The mirror of `AppDownloads` in `apps/web/src/lib/desktop/app-release.ts`; both
/// read the document `scripts/desktop/app-release-manifests.mjs` writes. Only the
/// fields this command needs are modelled.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppDownloads {
    version: String,
    platforms: HashMap<String, AppDownloadPlatform>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppDownloadPlatform {
    url: String,
    size_bytes: u64,
}

/// Key into `downloads.json#platforms` for the running build.
///
/// The manifest uses the updater's platform naming, where macOS is `darwin` — not
/// Rust's `macos`.
fn platform_key() -> String {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    format!("{os}-{}", std::env::consts::ARCH)
}

fn downloads_url(update_base: &str, channel: &str) -> String {
    format!(
        "{}/{channel}/app/downloads.json",
        update_base.trim_end_matches('/')
    )
}

/// The only installer suffix this shell may save, decided at compile time: a
/// macOS shell can never be handed an `.exe`, nor a Windows shell a `.dmg` —
/// even by a tampered index (spec 20260814 D6).
const INSTALLER_SUFFIX: &str = if cfg!(target_os = "windows") {
    "-setup.exe"
} else {
    ".dmg"
};

/// Filename to save an installer under, taken from its published URL.
///
/// Naming the saved file after the release artifact is what makes a Downloads
/// folder readable later; validating it here is what keeps a rogue update source
/// from writing outside that folder.
fn installer_file_name(url: &str) -> Option<String> {
    installer_file_name_with_suffix(url, INSTALLER_SUFFIX)
}

/// Suffix passed explicitly so unit tests cover both platforms' rules on any host.
fn installer_file_name_with_suffix(url: &str, suffix: &str) -> Option<String> {
    let name = url.split(['?', '#']).next()?.rsplit('/').next()?;
    let plausible = name.ends_with(suffix)
        && name.len() > suffix.len()
        && name.len() <= 128
        && !name.starts_with('.')
        && !name.contains(['/', '\\']);
    plausible.then(|| name.to_string())
}

/// May we download this installer URL?
///
/// It has to sit under the update source we just read the index from. That is a
/// stronger rule than requiring `https://`: a tampered index cannot point the
/// download at some other host, and in the packaged configuration the update source
/// *is* https, so the transport guarantee comes along for free. The trailing slash
/// matters — without it `https://host:18888.evil.com/` would pass as a prefix.
fn is_installer_url_allowed(url: &str, allowed_origins: &[String]) -> bool {
    allowed_origins
        .iter()
        .any(|origin| url.starts_with(&format!("{}/", origin.trim_end_matches('/'))))
}

/// Where a downloaded installer ended up.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedInstaller {
    /// Absolute path of the saved installer (`.dmg` / `-setup.exe`), already
    /// revealed in the file manager.
    pub path: String,
    pub version: String,
}

/// How far along the download is. Emitted as `desktop://installer-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallerProgress {
    pub received: u64,
    pub total: u64,
}

pub const EVENT_INSTALLER_PROGRESS: &str = "desktop://installer-progress";

/// Download the published installer for this platform into Downloads, and reveal it.
///
/// The web layer passes no URL: this reads the same `downloads.json` the settings
/// download card renders and takes the entry for the running platform. So the shell
/// keeps its "named capability, no generic hatch" rule — there is still no way to
/// make the app fetch an arbitrary URL or write to an arbitrary path (revises the
/// update-pipeline spec's D4, which assumed the only alternative was an opener).
///
/// The bytes are not signature-checked here: the `.dmg` carries Apple's own
/// notarization, which Gatekeeper verifies when the user opens it — a stronger
/// check than anything this side could add. The size from the index is compared
/// only to catch a truncated download. Windows has no notarization equivalent
/// (the NSIS installer ships unsigned, spec 20260814 D3); the saved `.exe` gets a
/// Mark-of-the-Web instead, so running it goes through the same SmartScreen gate
/// as a browser download rather than silently around it.
#[tauri::command]
pub async fn desktop_download_shell_installer(
    app: tauri::AppHandle,
    state: State<'_, DesktopState>,
) -> Result<DownloadedInstaller, String> {
    use tauri::{Emitter, Manager};
    use tauri_plugin_opener::OpenerExt;

    let api_base =
        settings::effective_api_base(&state.settings().api_base_url, settings::api_base_locked());
    let update_base = settings::update_base(&api_base);
    let downloads_dir = app
        .path()
        .download_dir()
        .map_err(|e| format!("could not resolve the Downloads folder: {e}"))?;

    // Measured against the real update source, an installer takes minutes, not
    // seconds (7.6 MB at ~22 KB/s on 2026-08-06). A button that only spins for that
    // long reads as broken, so the web layer gets progress to show.
    let emitter = app.clone();
    let saved = download_installer_into(
        &update_base,
        &channel(),
        &downloads_dir,
        &move |received, total| {
            let _ = emitter.emit(
                EVENT_INSTALLER_PROGRESS,
                InstallerProgress { received, total },
            );
        },
    )
    .await?;

    if let Err(err) = app.opener().reveal_item_in_dir(&saved.path) {
        // The file is on disk either way; not revealing it is not a failed download.
        log::warn!("[update] could not reveal the installer: {err}");
    }
    Ok(saved)
}

/// Fetch the release index and save this platform's installer into `into_dir`.
///
/// Split from the command so the part that can actually go wrong — index → platform
/// entry → allowed URL → validated filename → streamed bytes → completeness →
/// atomic rename — is exercised by tests without a window. The command itself only
/// decides *which* directory and reveals the result.
async fn download_installer_into(
    update_base: &str,
    channel: &str,
    into_dir: &Path,
    on_progress: &(dyn Fn(u64, u64) + Sync),
) -> Result<DownloadedInstaller, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        // A *read* timeout, not a total one. The link to the update source runs at
        // tens of KB/s, so any whole-request budget large enough to succeed there is
        // too large to catch a stall — while "no bytes for a minute" is a stall at
        // any speed.
        .read_timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| format!("could not build an HTTP client: {e}"))?;

    let index: AppDownloads = client
        .get(downloads_url(update_base, channel))
        .send()
        .await
        .map_err(|e| format!("could not reach the update source: {e}"))?
        .error_for_status()
        .map_err(|e| format!("update source returned an error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("release index is not readable: {e}"))?;

    let key = platform_key();
    let platform = index
        .platforms
        .get(&key)
        .ok_or_else(|| format!("no installer is published for {key}"))?;
    if !is_installer_url_allowed(&platform.url, &settings::artifact_origins(update_base)) {
        return Err(format!(
            "published installer url is not on the update source: {}",
            platform.url
        ));
    }
    let file_name = installer_file_name(&platform.url).ok_or_else(|| {
        format!(
            "published installer url is not a {INSTALLER_SUFFIX} installer: {}",
            platform.url
        )
    })?;

    let final_path = into_dir.join(&file_name);
    // Download beside the target and rename on success: an interrupted download must
    // not leave something that looks like a complete installer sitting in Downloads.
    let partial_path = into_dir.join(format!("{file_name}.partial"));
    log::info!(
        "[update] downloading installer {} to {:?}",
        platform.url,
        final_path
    );

    let written = match stream_to_file(
        &client,
        &platform.url,
        &partial_path,
        platform.size_bytes,
        on_progress,
    )
    .await
    {
        Ok(written) if written == platform.size_bytes => written,
        Ok(written) => {
            let _ = std::fs::remove_file(&partial_path);
            return Err(format!(
                "installer download is incomplete ({written} of {} bytes)",
                platform.size_bytes
            ));
        }
        Err(err) => {
            let _ = std::fs::remove_file(&partial_path);
            return Err(err);
        }
    };

    std::fs::rename(&partial_path, &final_path).map_err(|e| {
        let _ = std::fs::remove_file(&partial_path);
        format!("could not save the installer: {e}")
    })?;

    // Files written by a program carry no Mark-of-the-Web, so an unsigned exe
    // saved here would launch without any SmartScreen evaluation at all. Adding
    // the zone marker keeps this download on the same footing as a browser one;
    // failing to add it (non-NTFS Downloads) is not a failed download.
    #[cfg(target_os = "windows")]
    {
        use std::io::Write;
        let ads = format!("{}:Zone.Identifier", final_path.display());
        let marked = std::fs::File::create(&ads)
            .and_then(|mut f| f.write_all(b"[ZoneTransfer]\r\nZoneId=3\r\n"));
        if let Err(err) = marked {
            log::warn!("[update] could not mark the installer as downloaded: {err}");
        }
    }

    log::info!("[update] installer saved ({written} bytes): {final_path:?}");

    Ok(DownloadedInstaller {
        path: final_path.to_string_lossy().into_owned(),
        version: index.version,
    })
}

/// Stream a response body to disk, returning the number of bytes written.
///
/// Streamed rather than buffered because there is no reason to hold an installer in
/// memory at once — and because a download this slow has to be able to report where
/// it has got to while it runs.
async fn stream_to_file(
    client: &reqwest::Client,
    url: &str,
    path: &PathBuf,
    total: u64,
    on_progress: &(dyn Fn(u64, u64) + Sync),
) -> Result<u64, String> {
    use std::io::Write;

    /// Report at most every ~1%, and never more often than this. Chunks arrive far
    /// faster than a progress bar can usefully move.
    const MIN_PROGRESS_STEP: u64 = 128 * 1024;

    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("could not download the installer: {e}"))?
        .error_for_status()
        .map_err(|e| format!("installer download failed: {e}"))?;

    let mut file =
        std::fs::File::create(path).map_err(|e| format!("could not write to Downloads: {e}"))?;
    let step = (total / 100).max(MIN_PROGRESS_STEP);
    let mut written = 0u64;
    let mut reported = 0u64;
    // Report once up front so the UI starts at 0% rather than at the first chunk.
    on_progress(0, total);

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("installer download was interrupted: {e}"))?
    {
        file.write_all(&chunk)
            .map_err(|e| format!("could not write the installer: {e}"))?;
        written += chunk.len() as u64;
        if written - reported >= step {
            reported = written;
            on_progress(written, total);
        }
    }
    file.flush()
        .map_err(|e| format!("could not write the installer: {e}"))?;
    on_progress(written, total);
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_update_must_be_newer_and_present_on_disk() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = crate::bundle::bundles_root(tmp.path()).join("v3");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(crate::protocol::INDEX), b"<html></html>").unwrap();
        crate::bundle::write_pointer(
            tmp.path(),
            &crate::bundle::BundlePointer {
                web_bundle_version: "3".into(),
                dir: "v3".into(),
                boot_pending: false,
            },
        )
        .unwrap();

        assert_eq!(pending_update(tmp.path(), "2").unwrap().version, "3");
        assert!(pending_update(tmp.path(), "3").is_none());
        std::fs::remove_file(dir.join(crate::protocol::INDEX)).unwrap();
        assert!(pending_update(tmp.path(), "2").is_none());
    }

    /// The wire shape TypeScript expects (lib/desktop/types.ts ShellUpdateResult).
    #[test]
    fn shell_update_result_serializes_to_the_shape_typescript_expects() {
        let installed = serde_json::to_value(ShellUpdateResult::Installed {
            version: "0.38.0".into(),
        })
        .unwrap();
        assert_eq!(
            installed,
            serde_json::json!({ "status": "installed", "version": "0.38.0" })
        );

        let up_to_date = serde_json::to_value(ShellUpdateResult::UpToDate).unwrap();
        assert_eq!(up_to_date, serde_json::json!({ "status": "up_to_date" }));
    }

    #[test]
    fn downloads_url_is_built_from_the_update_base() {
        assert_eq!(
            downloads_url(
                "https://greenhouse.example.com:18888/updates/desktop/",
                "beta"
            ),
            "https://greenhouse.example.com:18888/updates/desktop/beta/app/downloads.json"
        );
    }

    #[test]
    fn platform_key_matches_what_the_release_manifest_publishes() {
        // app-release-manifests.mjs writes `darwin-aarch64` / `windows-x86_64`;
        // Rust calls the first OS macos, and the second one matches as-is.
        #[cfg(target_os = "macos")]
        assert!(platform_key().starts_with("darwin-"), "{}", platform_key());
        #[cfg(target_os = "windows")]
        assert!(platform_key().starts_with("windows-"), "{}", platform_key());
        assert!(platform_key().ends_with(std::env::consts::ARCH));
    }

    #[test]
    fn installer_file_name_comes_from_the_url_but_cannot_escape_downloads() {
        let dmg = "https://greenhouse.example.com:18888/updates/desktop/stable/app/Greenhouse-0.41.0-aarch64.dmg";
        assert_eq!(
            installer_file_name_with_suffix(dmg, ".dmg").as_deref(),
            Some("Greenhouse-0.41.0-aarch64.dmg")
        );
        assert_eq!(
            installer_file_name_with_suffix(&format!("{dmg}?v=2"), ".dmg").as_deref(),
            Some("Greenhouse-0.41.0-aarch64.dmg")
        );
        let exe = "https://greenhouse.example.com:18888/updates/desktop/stable/app/Greenhouse-0.53.0-x86_64-setup.exe";
        assert_eq!(
            installer_file_name_with_suffix(exe, "-setup.exe").as_deref(),
            Some("Greenhouse-0.53.0-x86_64-setup.exe")
        );

        // The other platform's artifact is never this platform's installer.
        assert_eq!(installer_file_name_with_suffix(exe, ".dmg"), None);
        assert_eq!(installer_file_name_with_suffix(dmg, "-setup.exe"), None);

        // A feed we do not control must never pick the path we write to.
        for suffix in [".dmg", "-setup.exe"] {
            assert_eq!(
                installer_file_name_with_suffix("https://host/a/../../etc/passwd", suffix),
                None
            );
            assert_eq!(
                installer_file_name_with_suffix("https://host/app/installer.sh", suffix),
                None
            );
            assert_eq!(
                installer_file_name_with_suffix("https://host/app/", suffix),
                None
            );
        }
        // A bare suffix is not a file name.
        assert_eq!(
            installer_file_name_with_suffix("https://host/app/.dmg", ".dmg"),
            None
        );
        assert_eq!(
            installer_file_name_with_suffix("https://host/app/-setup.exe", "-setup.exe"),
            None
        );

        // The wrapper pins the compile-time suffix for the running platform.
        #[cfg(target_os = "windows")]
        assert_eq!(
            installer_file_name(exe).as_deref(),
            Some("Greenhouse-0.53.0-x86_64-setup.exe")
        );
        #[cfg(not(target_os = "windows"))]
        assert_eq!(
            installer_file_name(dmg).as_deref(),
            Some("Greenhouse-0.41.0-aarch64.dmg")
        );
        #[cfg(target_os = "windows")]
        assert_eq!(installer_file_name(dmg), None);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(installer_file_name(exe), None);
    }

    /// The wire shape TypeScript expects (lib/desktop/types.ts DownloadedInstaller).
    #[test]
    fn downloaded_installer_serializes_to_the_shape_typescript_expects() {
        let value = serde_json::to_value(DownloadedInstaller {
            path: "/Users/x/Downloads/Greenhouse-0.41.0-aarch64.dmg".into(),
            version: "0.41.0".into(),
        })
        .unwrap();
        assert_eq!(
            value,
            serde_json::json!({
                "path": "/Users/x/Downloads/Greenhouse-0.41.0-aarch64.dmg",
                "version": "0.41.0",
            })
        );
    }

    #[test]
    fn only_the_update_source_or_an_allowed_release_host_may_supply_the_installer() {
        let base = "https://greenhouse.example.com:18888/updates/desktop";
        let published = "https://greenhouse.example.com:18888/updates/desktop/stable/app/x.dmg";
        let allowed = settings::artifact_origins(base);
        assert!(is_installer_url_allowed(published, &allowed));
        assert!(is_installer_url_allowed(
            published,
            &settings::artifact_origins(&format!("{base}/"))
        ));

        // A release host the build allowed explicitly is fine too.
        let with_release_host = vec![
            base.to_string(),
            "https://github.com/example/greenhouse/releases/download".to_string(),
        ];
        assert!(is_installer_url_allowed(
            "https://github.com/example/greenhouse/releases/download/v1.2.0/x.dmg",
            &with_release_host
        ));

        // A tampered index must not be able to send the download anywhere else —
        // including hosts that merely start with the same characters.
        assert!(!is_installer_url_allowed(
            "https://evil.example/x.dmg",
            &allowed
        ));
        assert!(!is_installer_url_allowed(
            "https://greenhouse.example.com:18888.evil.example/x.dmg",
            &allowed
        ));
        assert!(!is_installer_url_allowed(
            "https://greenhouse.example.com:18888@evil.example/x.dmg",
            &allowed
        ));
    }

    // ── The download path, end to end over a real socket ──
    //
    // Real HTTP rather than a mocked client: what is worth checking here is exactly
    // what a fake would paper over — chunked reads, byte counts, files on disk.

    const INDEX_ROUTE: &str = "/updates/desktop/stable/app/downloads.json";
    const DMG_ROUTE: &str = "/updates/desktop/stable/app/Greenhouse-0.41.0-test.dmg";

    /// Serve fixed bodies for `requests` many requests, then stop.
    ///
    /// `build` receives the base URL, because the index has to carry an absolute
    /// installer URL and the port is only known after binding.
    fn serve(build: impl FnOnce(&str) -> Vec<(String, Vec<u8>)>, requests: usize) -> String {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let routes = build(&base);

        std::thread::spawn(move || {
            use std::io::{Read, Write};
            for _ in 0..requests {
                let Ok((mut socket, _)) = listener.accept() else {
                    return;
                };
                let mut buffer = [0u8; 2048];
                let read = socket.read(&mut buffer).unwrap_or(0);
                let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let path = request.split_whitespace().nth(1).unwrap_or("/");
                let body = routes
                    .iter()
                    .find(|(route, _)| route == path)
                    .map(|(_, body)| body.clone());
                // `Connection: close` keeps one request per socket, so the accept
                // loop above stays a plain counter.
                let head = match &body {
                    Some(body) => format!(
                        "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    ),
                    None => {
                        "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                            .into()
                    }
                };
                let _ = socket.write_all(head.as_bytes());
                if let Some(body) = body {
                    let _ = socket.write_all(&body);
                }
                let _ = socket.flush();
            }
        });
        base
    }

    /// Big enough to arrive as more than one chunk.
    fn installer_bytes() -> Vec<u8> {
        (0..300_000).map(|i| (i % 251) as u8).collect()
    }

    fn index_json(dmg_url: &str, size_bytes: usize) -> Vec<u8> {
        format!(
            r#"{{"schemaVersion":1,"version":"0.41.0","nativeApiVersion":"0.7.0",
                "releasedAt":"2026-08-06T00:00:00.000Z",
                "platforms":{{"{key}":{{"label":"test","url":"{dmg_url}","sizeBytes":{size_bytes}}}}}}}"#,
            key = platform_key(),
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn saves_the_published_installer_under_its_release_name() {
        let bytes = installer_bytes();
        let body = bytes.clone();
        let base = serve(
            move |base| {
                vec![
                    (
                        INDEX_ROUTE.into(),
                        index_json(&format!("{base}{DMG_ROUTE}"), body.len()),
                    ),
                    (DMG_ROUTE.into(), body),
                ]
            },
            2,
        );

        let tmp = tempfile::tempdir().unwrap();
        let seen: std::sync::Mutex<Vec<(u64, u64)>> = std::sync::Mutex::new(Vec::new());
        let saved = download_installer_into(
            &format!("{base}/updates/desktop"),
            "stable",
            tmp.path(),
            &|received, total| {
                seen.lock().unwrap().push((received, total));
            },
        )
        .await
        .unwrap();

        // Progress has to start at zero and end at the full size: a bar that only
        // appears once the download is done is the thing this replaced.
        let seen = seen.into_inner().unwrap();
        assert_eq!(seen.first(), Some(&(0, bytes.len() as u64)));
        assert_eq!(seen.last(), Some(&(bytes.len() as u64, bytes.len() as u64)));
        assert!(seen.windows(2).all(|pair| pair[0].0 <= pair[1].0));

        assert_eq!(saved.version, "0.41.0");
        let expected = tmp.path().join("Greenhouse-0.41.0-test.dmg");
        assert_eq!(saved.path, expected.to_string_lossy());
        assert_eq!(std::fs::read(&expected).unwrap(), bytes);
        assert!(
            !tmp.path()
                .join("Greenhouse-0.41.0-test.dmg.partial")
                .exists(),
            "the partial file is renamed, not left behind"
        );
    }

    #[tokio::test]
    async fn a_truncated_download_leaves_nothing_that_looks_installable() {
        let bytes = installer_bytes();
        let body = bytes.clone();
        // The index claims more bytes than the server actually sends.
        let claimed = bytes.len() + 1;
        let base = serve(
            move |base| {
                vec![
                    (
                        INDEX_ROUTE.into(),
                        index_json(&format!("{base}{DMG_ROUTE}"), claimed),
                    ),
                    (DMG_ROUTE.into(), body),
                ]
            },
            2,
        );

        let tmp = tempfile::tempdir().unwrap();
        let err = download_installer_into(
            &format!("{base}/updates/desktop"),
            "stable",
            tmp.path(),
            &|_, _| {},
        )
        .await
        .unwrap_err();

        assert!(err.contains("incomplete"), "{err}");
        // Neither half-file may survive: one would be silently unusable, the other
        // would be mistaken for a finished download.
        assert!(!tmp.path().join("Greenhouse-0.41.0-test.dmg").exists());
        assert!(!tmp
            .path()
            .join("Greenhouse-0.41.0-test.dmg.partial")
            .exists());
    }

    #[tokio::test]
    async fn refuses_an_index_that_points_the_download_off_the_update_source() {
        let base = serve(
            |_| {
                vec![(
                    INDEX_ROUTE.into(),
                    index_json("https://evil.example/Greenhouse-0.41.0-test.dmg", 10),
                )]
            },
            1,
        );

        let tmp = tempfile::tempdir().unwrap();
        let err = download_installer_into(
            &format!("{base}/updates/desktop"),
            "stable",
            tmp.path(),
            &|_, _| {},
        )
        .await
        .unwrap_err();

        assert!(err.contains("not on the update source"), "{err}");
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 0);
    }

    /// The index shape `scripts/desktop/app-release-manifests.mjs` publishes.
    #[test]
    fn app_downloads_deserializes_the_published_index() {
        let index: AppDownloads = serde_json::from_str(
            r#"{
              "schemaVersion": 1,
              "version": "0.41.0",
              "nativeApiVersion": "0.7.0",
              "releasedAt": "2026-08-06T00:00:00.000Z",
              "platforms": {
                "darwin-aarch64": {
                  "label": "macOS (Apple Silicon)",
                  "url": "https://host/app/Greenhouse-0.41.0-aarch64.dmg",
                  "sizeBytes": 18874368
                }
              }
            }"#,
        )
        .unwrap();
        assert_eq!(index.version, "0.41.0");
        assert_eq!(index.platforms["darwin-aarch64"].size_bytes, 18_874_368);
    }
}

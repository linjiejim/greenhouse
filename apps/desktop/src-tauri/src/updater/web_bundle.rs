//! Web-bundle hot updates — shipping web changes without shipping an app.
//!
//! The whole point of this shell is that feature work stays in `apps/web`. This is
//! how that work reaches installed apps: a signed tarball of the Vite output, staged
//! next to the app and preferred over the embedded baseline on next launch.
//!
//! ```text
//!   GET <update base>/<channel>/web/manifest.json
//!     → newer version? and our shell is new enough?
//!     → GET the tarball
//!     → sha256 must match, ed25519 signature over that digest must verify
//!     → unpack to web-bundles/v<N>/, then atomically flip current.json
//! ```
//!
//! Two rules make this safe enough to run unattended:
//!
//! 1. **Nothing is destructive until it has verified.** Any failure leaves the
//!    active pointer exactly where it was, so a bad update is a no-op, not an outage.
//! 2. **A bundle that never boots is rolled back** by the watchdog in `crate::bundle`.
//!    Verification proves a bundle is *authentic*, not that it *works*.

use crate::bundle::{self, BundlePointer};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// Public half of the web-bundle signing key, base64 raw 32 bytes.
///
/// The private half lives in `apps/desktop/.keys/` (git-ignored) and in the
/// `WEB_BUNDLE_SIGN_KEY` CI secret. Rotating it invalidates every published
/// manifest, so a rotation must ship with a new shell.
pub const SIGNING_PUBLIC_KEY: &str = match option_env!("GREENHOUSE_WEB_BUNDLE_PUBKEY") {
    Some(key) => key,
    None => "",
};

/// How many old bundles to keep. One is enough to roll back to; more is just disk.
const KEEP_BUNDLES: usize = 2;
pub const RELEASE_NOTES_FILENAME: &str = "release-notes.json";

/// Short, user-facing notes shipped inside the signed tarball.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebReleaseNotes {
    pub schema_version: u8,
    pub app_version: String,
    pub web_bundle_version: String,
    pub title: String,
    pub summary: String,
    pub changes: Vec<String>,
    pub released_at: String,
}

/// Manifest published at `<channel>/web/manifest.json`.
///
/// Field names match the manifest the retired Electron shell published, so the
/// update source keeps one schema across both generations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebBundleManifest {
    /// Monotonically increasing integer, as a string.
    pub web_bundle_version: String,
    /// Shells older than this must skip the bundle — see `is_compatible`.
    pub min_shell_version: String,
    /// Tarball filename, resolved relative to the manifest URL.
    pub url: String,
    /// Hex sha256 of the tarball.
    pub sha256: String,
    /// Base64 ed25519 signature over the *sha256 hex string*.
    pub sig: String,
    #[serde(default)]
    pub released_at: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum UpdateOutcome {
    /// Staged and ready; takes effect on next launch.
    Staged {
        version: String,
        release_notes: Option<WebReleaseNotes>,
    },
    /// Already running the newest bundle.
    UpToDate,
    /// A newer bundle exists but needs a newer shell.
    NeedsNewerShell { required: String },
}

// ─── Verification (pure, and therefore tested) ───────────

#[derive(Debug, PartialEq, Eq)]
pub enum VerifyError {
    DigestMismatch,
    BadSignature,
    MalformedKey,
}

impl std::fmt::Display for VerifyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::DigestMismatch => write!(f, "bundle contents do not match the manifest digest"),
            Self::BadSignature => write!(f, "manifest signature is not valid"),
            Self::MalformedKey => write!(f, "embedded signing key is malformed"),
        }
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

/// Check a downloaded tarball against its manifest.
///
/// Both halves matter and neither is redundant: the digest proves the bytes are the
/// ones the manifest describes, the signature proves the *manifest* came from us.
/// Checking only the digest would let anyone who can serve the update source publish
/// whatever they like.
pub fn verify_bundle(
    manifest: &WebBundleManifest,
    tarball: &[u8],
    public_key_b64: &str,
) -> Result<(), VerifyError> {
    let actual = sha256_hex(tarball);
    if !actual.eq_ignore_ascii_case(&manifest.sha256) {
        return Err(VerifyError::DigestMismatch);
    }

    let key_bytes = decode_base64(public_key_b64).ok_or(VerifyError::MalformedKey)?;
    let key_array: [u8; 32] = key_bytes
        .try_into()
        .map_err(|_| VerifyError::MalformedKey)?;
    let key = VerifyingKey::from_bytes(&key_array).map_err(|_| VerifyError::MalformedKey)?;

    let sig_bytes = decode_base64(&manifest.sig).ok_or(VerifyError::BadSignature)?;
    let sig_array: [u8; 64] = sig_bytes
        .try_into()
        .map_err(|_| VerifyError::BadSignature)?;
    let signature = Signature::from_bytes(&sig_array);

    key.verify_strict(actual.as_bytes(), &signature)
        .map_err(|_| VerifyError::BadSignature)
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .ok()
}

/// Is `candidate` a newer bundle than `current`?
///
/// Bundle versions are integers-as-strings, so they're compared numerically — "10"
/// is newer than "9", which a string comparison would get backwards.
pub fn is_newer(candidate: &str, current: &str) -> bool {
    match (
        candidate.trim().parse::<u64>(),
        current.trim().parse::<u64>(),
    ) {
        (Ok(candidate), Ok(current)) => candidate > current,
        // An unparseable version is not something to upgrade *to*.
        _ => false,
    }
}

/// Can this shell run the bundle?
///
/// `minShellVersion` is the guard that stops a web bundle calling a native command
/// the installed shell doesn't have — which would otherwise be a white screen.
pub fn is_compatible(min_shell_version: &str, shell_version: &str) -> bool {
    compare_semver(shell_version, min_shell_version) >= 0
}

/// -1 / 0 / 1, comparing dotted numeric versions. Missing parts count as 0, and any
/// pre-release suffix is ignored — this only ever compares our own versions.
fn compare_semver(a: &str, b: &str) -> i8 {
    let parts = |v: &str| -> Vec<u64> {
        v.trim()
            .split('-')
            .next()
            .unwrap_or("")
            .split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (parts(a), parts(b));
    for index in 0..a.len().max(b.len()) {
        let left = a.get(index).copied().unwrap_or(0);
        let right = b.get(index).copied().unwrap_or(0);
        if left != right {
            return if left > right { 1 } else { -1 };
        }
    }
    0
}

// ─── Staging ─────────────────────────────────────────────

/// Unpack a verified tarball and make it the active bundle.
///
/// Extraction goes to a temp directory first and is only moved into place once it
/// has produced an `index.html` — a truncated download must not leave a half-written
/// bundle that the next launch tries to boot.
pub fn stage_bundle(
    app_data: &Path,
    version: &str,
    tarball: &[u8],
    protected_version: Option<&str>,
) -> Result<PathBuf, String> {
    let root = bundle::bundles_root(app_data);
    std::fs::create_dir_all(&root).map_err(|e| format!("could not create bundle dir: {e}"))?;

    let staging = root.join(format!(".staging-v{version}"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| format!("could not create staging dir: {e}"))?;

    let decoder = flate2::read::GzDecoder::new(tarball);
    let mut archive = tar::Archive::new(decoder);
    archive
        .unpack(&staging)
        .map_err(|e| format!("could not unpack the bundle: {e}"))?;

    if !staging.join(crate::protocol::INDEX).is_file() {
        let _ = std::fs::remove_dir_all(&staging);
        return Err("bundle has no index.html at its root".into());
    }

    let final_dir = root.join(format!("v{version}"));
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&staging, &final_dir).map_err(|e| format!("could not activate bundle: {e}"))?;

    // Point at the new bundle, but do not arm the watchdog yet. The running process
    // is still serving the old bundle; `arm_boot_watchdog` flips this to true only
    // after the next launch has selected vN and is about to load it.
    bundle::write_pointer(
        app_data,
        &BundlePointer {
            web_bundle_version: version.to_string(),
            dir: format!("v{version}"),
            boot_pending: false,
        },
    )
    .map_err(|e| format!("could not write the bundle pointer: {e}"))?;

    prune_old_bundles(&root, protected_version);
    Ok(final_dir)
}

/// Delete old bundles while retaining the directory the running process serves.
fn prune_old_bundles(root: &Path, protected_version: Option<&str>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    let mut versions: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter(|entry| entry.path().is_dir())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let number = name.strip_prefix('v')?.parse::<u64>().ok()?;
            Some((number, entry.path()))
        })
        .collect();
    versions.sort_by_key(|(number, _)| std::cmp::Reverse(*number));

    let protected = protected_version.and_then(|version| version.parse::<u64>().ok());
    for (number, path) in versions.into_iter().skip(KEEP_BUNDLES) {
        if Some(number) == protected {
            continue;
        }
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Read and validate notes from a verified bundle directory.
pub fn release_notes_for_bundle(dir: &Path, expected_version: &str) -> Option<WebReleaseNotes> {
    let raw = std::fs::read_to_string(dir.join(RELEASE_NOTES_FILENAME)).ok()?;
    let notes = serde_json::from_str::<WebReleaseNotes>(&raw).ok()?;
    if notes.schema_version != 1
        || notes.web_bundle_version != expected_version
        || notes.title.trim().is_empty()
        || notes.title.chars().count() > 40
        || notes.summary.trim().is_empty()
        || notes.summary.chars().count() > 100
        || notes.changes.is_empty()
        || notes.changes.len() > 6
        || notes
            .changes
            .iter()
            .any(|change| change.trim().is_empty() || change.chars().count() > 80)
    {
        return None;
    }
    Some(notes)
}

// ─── Fetch + apply ───────────────────────────────────────

pub fn manifest_url(update_base: &str, channel: &str) -> String {
    format!(
        "{}/{channel}/web/manifest.json",
        update_base.trim_end_matches('/')
    )
}

/// Resolve the tarball URL against the manifest's own location, so a manifest can
/// use a bare filename (as the published ones do).
pub fn tarball_url(manifest_url: &str, entry: &str) -> String {
    if entry.starts_with("http://") || entry.starts_with("https://") {
        return entry.to_string();
    }
    let base = manifest_url
        .rsplit_once('/')
        .map(|(base, _)| base)
        .unwrap_or("");
    format!("{base}/{}", entry.trim_start_matches('/'))
}

/// Check for, download, verify and stage a newer web bundle.
pub async fn check_and_stage(
    app_data: &Path,
    update_base: &str,
    channel: &str,
    shell_version: &str,
    current_bundle_version: &str,
    active_bundle_version: &str,
) -> Result<UpdateOutcome, String> {
    if SIGNING_PUBLIC_KEY.is_empty() {
        return Err("this build has no web-bundle signing key, so hot updates are disabled".into());
    }

    let manifest_url = manifest_url(update_base, channel);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not build an HTTP client: {e}"))?;

    let manifest: WebBundleManifest = client
        .get(&manifest_url)
        .send()
        .await
        .map_err(|e| format!("could not reach the update source: {e}"))?
        .error_for_status()
        .map_err(|e| format!("update source returned an error: {e}"))?
        .json()
        .await
        .map_err(|e| format!("update manifest is not readable: {e}"))?;

    if !is_newer(&manifest.web_bundle_version, current_bundle_version) {
        return Ok(UpdateOutcome::UpToDate);
    }
    if !is_compatible(&manifest.min_shell_version, shell_version) {
        return Ok(UpdateOutcome::NeedsNewerShell {
            required: manifest.min_shell_version,
        });
    }

    let tarball = client
        .get(tarball_url(&manifest_url, &manifest.url))
        .send()
        .await
        .map_err(|e| format!("could not download the bundle: {e}"))?
        .error_for_status()
        .map_err(|e| format!("bundle download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("could not read the bundle: {e}"))?;

    verify_bundle(&manifest, &tarball, SIGNING_PUBLIC_KEY).map_err(|e| e.to_string())?;
    let final_dir = stage_bundle(
        app_data,
        &manifest.web_bundle_version,
        &tarball,
        Some(active_bundle_version),
    )?;
    let release_notes = release_notes_for_bundle(&final_dir, &manifest.web_bundle_version);

    Ok(UpdateOutcome::Staged {
        version: manifest.web_bundle_version,
        release_notes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn keypair() -> (SigningKey, String) {
        // Fixed seed: tests must not depend on randomness.
        let signing = SigningKey::from_bytes(&[7u8; 32]);
        let public = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD.encode(signing.verifying_key().to_bytes())
        };
        (signing, public)
    }

    fn signed_manifest(signing: &SigningKey, tarball: &[u8], version: &str) -> WebBundleManifest {
        let digest = sha256_hex(tarball);
        let signature = {
            use base64::Engine;
            base64::engine::general_purpose::STANDARD
                .encode(signing.sign(digest.as_bytes()).to_bytes())
        };
        WebBundleManifest {
            web_bundle_version: version.into(),
            min_shell_version: "0.1.0".into(),
            url: format!("web-bundle-{version}.tar.gz"),
            sha256: digest,
            sig: signature,
            released_at: None,
        }
    }

    #[test]
    fn accepts_a_correctly_signed_bundle() {
        let (signing, public) = keypair();
        let tarball = b"pretend this is a tarball";
        let manifest = signed_manifest(&signing, tarball, "4");
        assert_eq!(verify_bundle(&manifest, tarball, &public), Ok(()));
    }

    #[test]
    fn rejects_tampered_contents() {
        let (signing, public) = keypair();
        let manifest = signed_manifest(&signing, b"original", "4");
        assert_eq!(
            verify_bundle(&manifest, b"tampered", &public),
            Err(VerifyError::DigestMismatch)
        );
    }

    #[test]
    fn rejects_a_manifest_signed_by_someone_else() {
        // The attack the signature exists to stop: whoever controls the update source
        // swaps in their own bundle AND recomputes the digest to match.
        let (_, public) = keypair();
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let tarball = b"malicious bundle";
        let manifest = signed_manifest(&attacker, tarball, "5");

        assert_eq!(
            verify_bundle(&manifest, tarball, &public),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn rejects_a_garbage_signature() {
        let (signing, public) = keypair();
        let tarball = b"contents";
        let mut manifest = signed_manifest(&signing, tarball, "4");
        manifest.sig = "not base64 !!!".into();
        assert_eq!(
            verify_bundle(&manifest, tarball, &public),
            Err(VerifyError::BadSignature)
        );
    }

    #[test]
    fn versions_compare_numerically_not_lexically() {
        assert!(is_newer("10", "9"), "10 must be newer than 9");
        assert!(is_newer("2", "1"));
        assert!(!is_newer("9", "10"));
        assert!(!is_newer("4", "4"));
        assert!(!is_newer("garbage", "4"));
    }

    #[test]
    fn min_shell_version_gates_bundles_that_need_newer_native_code() {
        assert!(is_compatible("0.1.0", "0.1.0"));
        assert!(is_compatible("0.1.0", "0.2.0"));
        assert!(is_compatible("0.2.0", "0.10.0"), "0.10 is newer than 0.2");
        assert!(!is_compatible("0.3.0", "0.2.9"));
        assert!(!is_compatible("1.0.0", "0.9.9"));
    }

    #[test]
    fn tarball_url_resolves_against_the_manifest() {
        let manifest = "https://host:1/updates/desktop/stable/web/manifest.json";
        assert_eq!(
            tarball_url(manifest, "web-bundle-4.tar.gz"),
            "https://host:1/updates/desktop/stable/web/web-bundle-4.tar.gz"
        );
        // An absolute URL in the manifest wins.
        assert_eq!(
            tarball_url(manifest, "https://cdn/x.tar.gz"),
            "https://cdn/x.tar.gz"
        );
    }

    #[test]
    fn manifest_url_is_built_from_the_update_base() {
        assert_eq!(
            manifest_url(
                "https://greenhouse.example.com:18888/updates/desktop/",
                "beta"
            ),
            "https://greenhouse.example.com:18888/updates/desktop/beta/web/manifest.json"
        );
    }

    // ── Staging ──

    fn tarball_with(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (name, contents) in files {
            let mut header = tar::Header::new_gnu();
            header.set_size(contents.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            builder.append_data(&mut header, name, *contents).unwrap();
        }
        let tar = builder.into_inner().unwrap();

        use flate2::write::GzEncoder;
        use std::io::Write;
        let mut encoder = GzEncoder::new(Vec::new(), flate2::Compression::fast());
        encoder.write_all(&tar).unwrap();
        encoder.finish().unwrap()
    }

    #[test]
    fn staging_unpacks_and_points_at_the_new_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let tarball = tarball_with(&[
            ("index.html", b"<html>v4</html>"),
            ("assets/app.js", b"//js"),
        ]);

        let dir = stage_bundle(tmp.path(), "4", &tarball, None).unwrap();
        assert_eq!(
            std::fs::read(dir.join("index.html")).unwrap(),
            b"<html>v4</html>"
        );
        assert!(dir.join("assets/app.js").is_file());

        let pointer = bundle::read_pointer(tmp.path()).unwrap().unwrap();
        assert_eq!(pointer.web_bundle_version, "4");
        assert!(
            !pointer.boot_pending,
            "staging happens in the old process; the next launch arms the watchdog"
        );
        assert_eq!(
            bundle::resolve_active(tmp.path()),
            bundle::ActiveBundle::Staged {
                version: "4".into(),
                dir,
            }
        );
    }

    #[test]
    fn a_bundle_without_index_html_is_rejected_and_leaves_the_pointer_alone() {
        let tmp = tempfile::tempdir().unwrap();
        bundle::write_pointer(
            tmp.path(),
            &BundlePointer {
                web_bundle_version: "3".into(),
                dir: "v3".into(),
                boot_pending: false,
            },
        )
        .unwrap();

        let broken = tarball_with(&[("assets/app.js", b"//js")]);
        assert!(stage_bundle(tmp.path(), "4", &broken, None).is_err());

        // Still on v3 — a bad bundle is a no-op, not an outage.
        let pointer = bundle::read_pointer(tmp.path()).unwrap().unwrap();
        assert_eq!(pointer.web_bundle_version, "3");
        assert!(!bundle::bundles_root(tmp.path()).join("v4").exists());
    }

    #[test]
    fn old_bundles_are_pruned_but_the_rollback_target_survives() {
        let tmp = tempfile::tempdir().unwrap();
        for version in ["1", "2", "3"] {
            stage_bundle(
                tmp.path(),
                version,
                &tarball_with(&[("index.html", b"<html></html>")]),
                None,
            )
            .unwrap();
        }
        stage_bundle(
            tmp.path(),
            "4",
            &tarball_with(&[("index.html", b"<html></html>")]),
            None,
        )
        .unwrap();

        let root = bundle::bundles_root(tmp.path());
        assert!(root.join("v4").exists(), "current bundle must survive");
        assert!(root.join("v3").exists(), "one rollback target must survive");
        assert!(!root.join("v1").exists(), "ancient bundles must be pruned");
    }

    #[test]
    fn pruning_never_deletes_the_bundle_the_running_process_serves() {
        let tmp = tempfile::tempdir().unwrap();
        for version in ["2", "3", "4", "5"] {
            stage_bundle(
                tmp.path(),
                version,
                &tarball_with(&[("index.html", b"<html></html>")]),
                Some("2"),
            )
            .unwrap();
        }

        let root = bundle::bundles_root(tmp.path());
        assert!(
            root.join("v2").exists(),
            "the active bundle must stay readable"
        );
        assert!(
            root.join("v5").exists(),
            "the latest pending bundle must stay"
        );
        assert!(
            root.join("v4").exists(),
            "one recent bundle may stay cached"
        );
        assert!(
            !root.join("v3").exists(),
            "unprotected old bundles are pruned"
        );
    }

    #[test]
    fn release_notes_are_read_only_when_they_match_the_signed_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let notes = r#"{
          "schemaVersion": 1,
          "appVersion": "0.32.0",
          "webBundleVersion": "4",
          "title": "更顺手的桌面体验",
          "summary": "更新已准备好，重启即可使用。",
          "changes": ["侧边栏会持续提示可用更新"],
          "releasedAt": "2026-07-30T00:00:00.000Z"
        }"#;
        let dir = stage_bundle(
            tmp.path(),
            "4",
            &tarball_with(&[
                ("index.html", b"<html></html>"),
                (RELEASE_NOTES_FILENAME, notes.as_bytes()),
            ]),
            None,
        )
        .unwrap();

        let parsed = release_notes_for_bundle(&dir, "4").unwrap();
        assert_eq!(parsed.app_version, "0.32.0");
        assert_eq!(parsed.changes, ["侧边栏会持续提示可用更新"]);
        assert!(release_notes_for_bundle(&dir, "5").is_none());
    }
}

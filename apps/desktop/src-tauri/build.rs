use std::path::Path;

fn main() {
    stamp_app_versions();
    stamp_web_bundle_baseline();
    stamp_signing_key();
    check_deployment_env();
    tauri_build::build()
}

/// The deployment knobs a build may bake in (see `settings.rs`): a server, an update
/// source, and extra installer origins. They are read with `option_env!` in the crate,
/// so cargo must know to rebuild when they change — and a malformed value should
/// fail here, at build time, rather than surface as a 404 on a user's machine.
fn check_deployment_env() {
    for name in [
        "GREENHOUSE_DESKTOP_API_BASE",
        "GREENHOUSE_DESKTOP_UPDATE_BASE",
        "GREENHOUSE_DESKTOP_ARTIFACT_ORIGINS",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    if let Ok(base) = std::env::var("GREENHOUSE_DESKTOP_API_BASE") {
        assert!(
            is_bare_http_origin(&base),
            "GREENHOUSE_DESKTOP_API_BASE must be a bare http(s) origin such as https://greenhouse.example.com:18888, got {base:?}"
        );
    }
    if let Ok(base) = std::env::var("GREENHOUSE_DESKTOP_UPDATE_BASE") {
        assert!(
            base.starts_with("https://") || base.starts_with("http://"),
            "GREENHOUSE_DESKTOP_UPDATE_BASE must be an http(s) URL, got {base:?}"
        );
    }
}

/// `scheme://host[:port]` with nothing after it. Kept dependency-free on purpose: this
/// runs in the build script, and it only needs to reject the obviously wrong shapes.
fn is_bare_http_origin(value: &str) -> bool {
    let rest = match value
        .strip_prefix("https://")
        .or_else(|| value.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return false,
    };
    let rest = rest.trim_end_matches('/');
    !rest.is_empty() && !rest.contains(['/', '?', '#', '@', ' '])
}

/// Keep the user-facing app version aligned with the root product release while
/// retaining a separate compatibility version for native commands.
fn stamp_app_versions() {
    let desktop_manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../package.json");
    let root_manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../package.json");
    println!("cargo:rerun-if-changed={}", desktop_manifest.display());
    println!("cargo:rerun-if-changed={}", root_manifest.display());

    let read_field = |path: &Path, field: &str| {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok())
            .and_then(|json| json.get(field)?.as_str().map(str::to_string))
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| panic!("{}#{field} must be a non-empty string", path.display()))
    };

    println!(
        "cargo:rustc-env=GREENHOUSE_APP_VERSION={}",
        read_field(&root_manifest, "version")
    );
    println!(
        "cargo:rustc-env=GREENHOUSE_NATIVE_API_VERSION={}",
        read_field(&desktop_manifest, "nativeApiVersion")
    );
}

/// Bake in the web-bundle version this binary ships with.
///
/// The web-bundle version is the commit count of the tree being built
/// (`git rev-list --count HEAD`): monotonic on a branch, needs no hand-maintained
/// field, and is the same number `scripts/desktop/make-web-bundle.mjs` tags a
/// published bundle with — so "what am I running" and "what did we publish" can't
/// drift. `GREENHOUSE_WEB_BUNDLE_VERSION` overrides it (CI passes the number it
/// computed once, so every job in a run agrees); outside a git checkout it is `0`.
fn stamp_web_bundle_baseline() {
    println!("cargo:rerun-if-env-changed=GREENHOUSE_WEB_BUNDLE_VERSION");
    println!("cargo:rerun-if-env-changed=GREENHOUSE_QA_BASELINE_WEB_BUNDLE_VERSION");

    let version = match std::env::var("GREENHOUSE_QA_BASELINE_WEB_BUNDLE_VERSION") {
        Ok(version) => {
            assert_eq!(
                std::env::var("PROFILE").as_deref(),
                Ok("debug"),
                "GREENHOUSE_QA_BASELINE_WEB_BUNDLE_VERSION is only allowed in debug builds"
            );
            assert!(
                version.parse::<u64>().is_ok(),
                "GREENHOUSE_QA_BASELINE_WEB_BUNDLE_VERSION must be an integer"
            );
            version
        }
        Err(_) => match std::env::var("GREENHOUSE_WEB_BUNDLE_VERSION") {
            Ok(version) => {
                assert!(
                    version.parse::<u64>().is_ok(),
                    "GREENHOUSE_WEB_BUNDLE_VERSION must be an integer"
                );
                version
            }
            Err(_) => commit_count().unwrap_or_else(|| "0".into()),
        },
    };

    println!("cargo:rustc-env=GREENHOUSE_WEB_BUNDLE_VERSION={version}");
}

/// `git rev-list --count HEAD` for the checkout that contains this crate, if any.
fn commit_count() -> Option<String> {
    let output = std::process::Command::new("git")
        .args(["rev-list", "--count", "HEAD"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let count = String::from_utf8(output.stdout).ok()?.trim().to_string();
    count.parse::<u64>().ok().map(|_| count)
}

/// Bake in the public half of the web-bundle signing key.
///
/// Read from the environment first (that's how CI injects it) and otherwise from the
/// git-ignored local key. Absent, the constant stays empty and hot updates refuse to
/// run — failing closed, rather than accepting unsigned bundles.
fn stamp_signing_key() {
    println!("cargo:rerun-if-env-changed=GREENHOUSE_WEB_BUNDLE_PUBKEY");
    let local = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.keys/web-bundle-sign.pub");
    println!("cargo:rerun-if-changed={}", local.display());

    let key = std::env::var("GREENHOUSE_WEB_BUNDLE_PUBKEY")
        .ok()
        .or_else(|| std::fs::read_to_string(&local).ok())
        .map(|key| key.trim().to_string())
        .unwrap_or_default();

    if key.is_empty() {
        println!("cargo:warning=No web-bundle signing key found — hot updates will be disabled in this build.");
    }
    println!("cargo:rustc-env=GREENHOUSE_WEB_BUNDLE_PUBKEY={key}");
}

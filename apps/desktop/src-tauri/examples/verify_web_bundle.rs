//! Verify a packaged web bundle exactly as an installed app would.
//!
//! The signing script is Node and the verifier is Rust, so the two agree only by
//! convention: ed25519 over the sha256 *hex string*, signature base64, public key as
//! raw 32 bytes. That contract is the one thing unit tests on either side can't
//! check — this closes it.
//!
//! Run after packaging, and in CI before anything is published:
//!
//!   pnpm web:build
//!   node scripts/desktop/make-web-bundle.mjs
//!   cargo run --example verify_web_bundle --manifest-path apps/desktop/src-tauri/Cargo.toml

use greenhouse_desktop_lib::updater::web_bundle::{verify_bundle, WebBundleManifest};
use std::path::PathBuf;

fn main() {
    let release = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../release/web");
    let manifest_path = release.join("manifest.json");

    let raw = match std::fs::read_to_string(&manifest_path) {
        Ok(raw) => raw,
        Err(err) => {
            eprintln!("✗ no manifest at {}: {err}", manifest_path.display());
            eprintln!("  Run `node scripts/desktop/make-web-bundle.mjs` first.");
            std::process::exit(1);
        }
    };
    let manifest: WebBundleManifest = serde_json::from_str(&raw).expect("manifest is valid JSON");
    // `url` is either the tarball's file name (served beside the manifest) or the
    // absolute URL it will be published at; the packaged file always sits beside the
    // manifest under its own name.
    let file_name = manifest
        .url
        .rsplit('/')
        .next()
        .filter(|name| !name.is_empty())
        .expect("manifest url ends in a file name");
    let tarball = std::fs::read(release.join(file_name)).expect("tarball is present");

    let public_key = std::fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.keys/web-bundle-sign.pub"),
    )
    .expect("public key is present");

    match verify_bundle(&manifest, &tarball, public_key.trim()) {
        Ok(()) => {
            println!(
                "✅ web bundle v{} verifies ({} bytes, min shell {})",
                manifest.web_bundle_version,
                tarball.len(),
                manifest.min_shell_version
            );
        }
        Err(err) => {
            eprintln!("✗ verification failed: {err}");
            std::process::exit(1);
        }
    }
}

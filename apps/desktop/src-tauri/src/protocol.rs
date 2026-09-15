//! Custom `greenhouse://` URI scheme — the layered resolver behind hot updates.
//!
//! Tauri embeds `frontendDist` into the binary, so a hot update can't simply
//! overwrite it. Instead the main window loads `greenhouse://localhost/index.html`
//! and this module answers every asset request from, in order:
//!
//!   1. the staged (verified) hot-update bundle, if one is active
//!   2. the embedded baseline (`AssetResolver`)
//!   3. `index.html`, for client-side routes that have no file on disk
//!
//! Using a custom scheme rather than `file://` keeps the origin fixed at
//! `greenhouse://localhost` (`http://greenhouse.localhost` on Windows). That
//! matters: the web app keeps its auth tokens in `localStorage` (see
//! `apps/web/src/lib/auth.ts`), which is keyed by origin — a stable origin means a
//! hot update never logs anyone out.

use std::path::{Component, Path, PathBuf};

/// What to serve for a given request path.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolution {
    /// Serve this concrete, traversal-safe relative asset path.
    Asset(String),
    /// No such file, but the path looks like a client-side route — serve the SPA shell.
    SpaFallback,
    /// Nothing to serve (traversal attempt, or a missing file that looks like an asset).
    NotFound,
}

/// The SPA entry document, and the SPA fallback target.
pub const INDEX: &str = "index.html";

/// Normalize a request path into a relative, traversal-safe asset path.
///
/// Returns `None` when the path tries to escape the asset root. `..` is rejected
/// outright rather than resolved, because a staged bundle directory is
/// attacker-influenced input in the threat model where the update source is
/// compromised — and "resolve then check prefix" is easy to get subtly wrong.
pub fn normalize_asset_path(raw: &str) -> Option<String> {
    // Strip the query/fragment a webview may append, then percent-decode.
    let path = raw.split(['?', '#']).next().unwrap_or("");
    let decoded = percent_decode(path);
    let trimmed = decoded.trim_start_matches('/');

    if trimmed.is_empty() {
        return Some(INDEX.to_string());
    }

    let mut out = PathBuf::new();
    for component in Path::new(trimmed).components() {
        match component {
            Component::Normal(part) => out.push(part),
            // A bare `.` is harmless noise; everything else is an escape attempt.
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }

    let normalized = out.to_str()?.replace('\\', "/");
    if normalized.is_empty() {
        return Some(INDEX.to_string());
    }
    Some(normalized)
}

/// Decide what to serve, given a way to test whether an asset exists.
///
/// `exists` is injected so this stays a pure function: the real caller checks the
/// staged bundle directory and the embedded assets, tests pass a closure.
pub fn resolve(raw_path: &str, exists: impl Fn(&str) -> bool) -> Resolution {
    let Some(path) = normalize_asset_path(raw_path) else {
        return Resolution::NotFound;
    };

    if exists(&path) {
        return Resolution::Asset(path);
    }

    // A request with a file extension is asking for a real file; if it's missing,
    // that's a 404. Returning index.html there would hand the webview an HTML body
    // for a `.js` request, which fails confusingly instead of loudly.
    if has_asset_extension(&path) {
        return Resolution::NotFound;
    }

    if exists(INDEX) {
        Resolution::SpaFallback
    } else {
        Resolution::NotFound
    }
}

/// Does the last path segment carry a file extension?
fn has_asset_extension(path: &str) -> bool {
    Path::new(path).extension().is_some()
}

/// Minimal percent-decoding — enough for asset paths, no dependency needed.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Content type for an asset path.
///
/// Covers what the Vite build emits; anything else is served as a byte stream
/// rather than guessed, so a wrong guess can't turn into a rendering bug.
pub fn mime_for(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .as_deref()
    {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("wasm") => "application/wasm",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn store(paths: &[&str]) -> impl Fn(&str) -> bool {
        let set: HashSet<String> = paths.iter().map(|p| p.to_string()).collect();
        move |p: &str| set.contains(p)
    }

    #[test]
    fn root_and_empty_paths_map_to_index() {
        assert_eq!(normalize_asset_path("/").as_deref(), Some(INDEX));
        assert_eq!(normalize_asset_path("").as_deref(), Some(INDEX));
    }

    #[test]
    fn strips_query_and_fragment() {
        assert_eq!(
            normalize_asset_path("/assets/app.js?v=3#x").as_deref(),
            Some("assets/app.js")
        );
    }

    #[test]
    fn percent_decodes_paths() {
        assert_eq!(
            normalize_asset_path("/assets/my%20file.png").as_deref(),
            Some("assets/my file.png")
        );
    }

    #[test]
    fn rejects_traversal() {
        // Both plain and percent-encoded `..`, since the decode happens first.
        assert_eq!(normalize_asset_path("/../../etc/passwd"), None);
        assert_eq!(normalize_asset_path("/assets/../../secret"), None);
        assert_eq!(normalize_asset_path("/%2e%2e/%2e%2e/etc/passwd"), None);
    }

    #[test]
    fn serves_existing_asset() {
        let exists = store(&["assets/app.js", INDEX]);
        assert_eq!(
            resolve("/assets/app.js", &exists),
            Resolution::Asset("assets/app.js".into())
        );
    }

    #[test]
    fn client_side_route_falls_back_to_index() {
        let exists = store(&[INDEX]);
        assert_eq!(
            resolve("/knowledge/wiki/foo", &exists),
            Resolution::SpaFallback
        );
    }

    #[test]
    fn missing_file_with_extension_is_not_found() {
        // Handing index.html back for a missing .js would surface as a baffling
        // syntax error in the console instead of an honest 404.
        let exists = store(&[INDEX]);
        assert_eq!(resolve("/assets/missing.js", &exists), Resolution::NotFound);
    }

    #[test]
    fn traversal_resolves_to_not_found() {
        let exists = store(&[INDEX, "etc/passwd"]);
        assert_eq!(resolve("/../etc/passwd", &exists), Resolution::NotFound);
    }

    #[test]
    fn mime_types_cover_the_vite_output() {
        assert_eq!(mime_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(
            mime_for("assets/app-abc123.js"),
            "text/javascript; charset=utf-8"
        );
        assert_eq!(mime_for("assets/app-abc123.css"), "text/css; charset=utf-8");
        assert_eq!(mime_for("brand-logo.jpg"), "image/jpeg");
        assert_eq!(mime_for("weird.bin"), "application/octet-stream");
    }
}

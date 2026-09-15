//! Asset IO for the `greenhouse://` scheme.
//!
//! `protocol` decides *what* to serve; this module knows *where* the bytes are —
//! the staged hot-update bundle on disk, or the baseline embedded in the binary.

use crate::bundle::ActiveBundle;
use crate::protocol::{self, Resolution, INDEX};
use crate::state::DesktopState;
use std::cell::RefCell;
use std::path::PathBuf;
use tauri::http::{Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime};

pub struct AssetStore<R: Runtime> {
    /// Directory of the active hot-update bundle, when one is booted.
    staged: Option<PathBuf>,
    resolver: tauri::AssetResolver<R>,
    csp: Option<String>,
}

impl<R: Runtime> AssetStore<R> {
    pub fn from_app(app: &AppHandle<R>) -> Self {
        let staged = match app
            .try_state::<DesktopState>()
            .map(|s| s.active_bundle.clone())
        {
            Some(ActiveBundle::Staged { dir, .. }) => Some(dir),
            _ => None,
        };
        Self {
            staged,
            resolver: app.asset_resolver(),
            csp: app
                .config()
                .app
                .security
                .csp
                .as_ref()
                .map(|c| c.to_string()),
        }
    }

    /// Read an asset, staged bundle first, embedded baseline second.
    fn read(&self, path: &str) -> Option<Vec<u8>> {
        if let Some(dir) = &self.staged {
            let candidate = dir.join(path);
            // `is_file` guards against a directory shadowing an asset name.
            if candidate.is_file() {
                if let Ok(bytes) = std::fs::read(&candidate) {
                    return Some(bytes);
                }
            }
        }
        self.resolver.get(format!("/{path}")).map(|a| a.bytes)
    }

    pub fn serve(&self, request_path: &str) -> Response<Vec<u8>> {
        log::debug!("[protocol] {request_path}");
        // `resolve` takes a plain existence predicate; stash the bytes it finds so a
        // hit doesn't cost a second read of the same file.
        let hit: RefCell<Option<(String, Vec<u8>)>> = RefCell::new(None);
        let resolution = protocol::resolve(request_path, |candidate| match self.read(candidate) {
            Some(bytes) => {
                *hit.borrow_mut() = Some((candidate.to_string(), bytes));
                true
            }
            None => false,
        });

        match resolution {
            Resolution::Asset(path) => match hit.into_inner() {
                Some((hit_path, bytes)) if hit_path == path => self.ok(&path, bytes),
                // Unreachable in practice (resolve only returns Asset on a hit), but
                // re-reading is cheaper than an unwrap that could take down the window.
                _ => match self.read(&path) {
                    Some(bytes) => self.ok(&path, bytes),
                    None => not_found(),
                },
            },
            Resolution::SpaFallback => match self.read(INDEX) {
                Some(bytes) => self.ok(INDEX, bytes),
                None => not_found(),
            },
            Resolution::NotFound => not_found(),
        }
    }

    fn ok(&self, path: &str, bytes: Vec<u8>) -> Response<Vec<u8>> {
        let mut builder = Response::builder()
            .status(StatusCode::OK)
            .header("Content-Type", protocol::mime_for(path))
            // Hashed asset filenames make the bundle self-versioning, but index.html
            // is not hashed — and a cached index.html after a hot update would point
            // at assets that no longer exist. Never cache within a session.
            .header("Cache-Control", "no-store");

        // Tauri injects the configured CSP for assets it serves itself; responses
        // built here have to carry it explicitly or the window runs unprotected.
        if path.ends_with(".html") {
            if let Some(csp) = &self.csp {
                builder = builder.header("Content-Security-Policy", csp);
            }
        }

        builder.body(bytes).unwrap_or_else(|_| not_found())
    }
}

fn not_found() -> Response<Vec<u8>> {
    Response::builder()
        .status(StatusCode::NOT_FOUND)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(b"not found".to_vec())
        .expect("static 404 response is well-formed")
}

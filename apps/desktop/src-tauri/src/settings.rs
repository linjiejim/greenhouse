//! Persisted shell settings.
//!
//! The shell owns which server the app talks to. It pushes that into the web layer
//! as a window global at page-load time rather than letting the web layer store it
//! itself — so "which server am I on" survives hot updates, can't drift between the
//! two layers, and can only be changed through a native command.
//!
//! **A deployment that builds its own shell fixes the server at build time.** With
//! `GREENHOUSE_DESKTOP_API_BASE` set, a packaged build always talks to that server,
//! with no setting and no first-run prompt: a shipped internal app pointing somewhere
//! unexpected is a support problem, not a feature. `api_base_locked()` is the switch;
//! it keys off the same `custom-protocol` cargo feature that decides how the window
//! loads its assets — so "packaged" means one thing throughout the shell — and it is
//! only ever true when a server was baked in. The generic build has none, so there
//! the server stays a setting in every build (the default is the local dev server).

use crate::shortcuts::{self, ShortcutMap};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const SETTINGS_FILENAME: &str = "settings.json";

/// Server baked in at build time (`GREENHOUSE_DESKTOP_API_BASE`), if any. Must be a
/// bare `http(s)` origin; `build.rs` rejects anything else before it gets here.
pub const BUILT_IN_API_BASE_URL: Option<&str> = option_env!("GREENHOUSE_DESKTOP_API_BASE");

/// Update source baked in at build time (`GREENHOUSE_DESKTOP_UPDATE_BASE`), if any.
/// Absent, updates are served by the API server itself under `/updates/desktop`.
pub const BUILT_IN_UPDATE_BASE_URL: Option<&str> = option_env!("GREENHOUSE_DESKTOP_UPDATE_BASE");

/// Extra origins a published installer may be downloaded from
/// (`GREENHOUSE_DESKTOP_ARTIFACT_ORIGINS`, comma separated). The open-source build
/// lists its GitHub Release host here; the update source itself is always allowed.
pub const BUILT_IN_ARTIFACT_ORIGINS: &str = match option_env!("GREENHOUSE_DESKTOP_ARTIFACT_ORIGINS")
{
    Some(list) => list,
    None => "",
};

/// Where a build without a baked-in server starts: the API's default dev port.
pub const LOCAL_API_BASE_URL: &str = "http://localhost:3000";

/// What a fresh install talks to: the baked-in server, else the local dev server.
pub const DEFAULT_API_BASE_URL: &str = match BUILT_IN_API_BASE_URL {
    Some(url) => url,
    None => LOCAL_API_BASE_URL,
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettings {
    pub api_base_url: String,
    /// Accelerator per shortcut id. Missing entries fall back to defaults.
    #[serde(default = "shortcuts::defaults")]
    pub shortcuts: ShortcutMap,
    /// Always-on selection watcher. Opt-in: it needs Accessibility permission and
    /// observes every click the user makes, so it must never default to on.
    #[serde(default)]
    pub selection_watch: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            api_base_url: DEFAULT_API_BASE_URL.to_string(),
            shortcuts: shortcuts::defaults(),
            selection_watch: false,
        }
    }
}

/// What the settings UI needs to render, which is not the same as what we persist:
/// `api_base_url` here is the base actually in use after the release-build lock, and
/// `api_base_locked` tells the UI to omit the server control entirely.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSettingsView {
    pub api_base_url: String,
    pub api_base_locked: bool,
    pub shortcuts: ShortcutMap,
    pub selection_watch: bool,
}

/// Is the server fixed? Only in a packaged build that carries a baked-in server.
pub fn api_base_locked() -> bool {
    !tauri::is_dev() && BUILT_IN_API_BASE_URL.is_some()
}

/// The update source for this build: `<update base>/<channel>/{web,app}/…`.
///
/// Explicit when the build set one (the open-source shell reads its manifests from
/// the project website); otherwise the API server serves them under
/// `/updates/desktop`, which is how a self-hosted deployment keeps one origin.
pub fn update_base(api_base: &str) -> String {
    match BUILT_IN_UPDATE_BASE_URL {
        Some(base) => base.trim_end_matches('/').to_string(),
        None => format!("{}/updates/desktop", api_base.trim_end_matches('/')),
    }
}

/// URL prefixes an installer download may come from: the update source itself, plus
/// whatever release host the build allowed. Anything else in a release index is
/// treated as tampering.
pub fn artifact_origins(update_base: &str) -> Vec<String> {
    let mut origins = vec![update_base.trim_end_matches('/').to_string()];
    origins.extend(
        BUILT_IN_ARTIFACT_ORIGINS
            .split(',')
            .map(str::trim)
            .filter(|origin| !origin.is_empty())
            .map(|origin| origin.trim_end_matches('/').to_string()),
    );
    origins
}

/// The base actually used, applying the release-build lock.
///
/// Takes `locked` explicitly rather than calling `api_base_locked()` so both branches
/// are testable — `cargo test` builds are always "dev".
pub fn effective_api_base(stored: &str, locked: bool) -> String {
    if locked {
        return DEFAULT_API_BASE_URL.to_string();
    }
    normalize_api_base(stored).unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string())
}

pub fn view(settings: &DesktopSettings, locked: bool) -> DesktopSettingsView {
    DesktopSettingsView {
        api_base_url: effective_api_base(&settings.api_base_url, locked),
        api_base_locked: locked,
        shortcuts: shortcuts::resolve(&settings.shortcuts)
            .into_iter()
            .map(|(id, accelerator)| (id.as_str().to_string(), accelerator))
            .collect(),
        selection_watch: settings.selection_watch,
    }
}

pub fn settings_path(app_data: &Path) -> PathBuf {
    app_data.join(SETTINGS_FILENAME)
}

/// Load settings, falling back to defaults for anything missing or corrupt.
///
/// Never fails: a broken settings file must not stop the app from starting, or a
/// bad write would leave the user with no way back in.
pub fn load(app_data: &Path) -> DesktopSettings {
    std::fs::read_to_string(settings_path(app_data))
        .ok()
        .and_then(|raw| serde_json::from_str::<DesktopSettings>(&raw).ok())
        .map(|mut s| {
            // A hand-edited or older file could hold something unusable.
            s.api_base_url = normalize_api_base(&s.api_base_url)
                .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string());
            s
        })
        .unwrap_or_default()
}

pub fn save(app_data: &Path, settings: &DesktopSettings) -> std::io::Result<()> {
    std::fs::create_dir_all(app_data)?;
    let body = serde_json::to_vec_pretty(settings)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = settings_path(app_data).with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(tmp, settings_path(app_data))
}

/// Validate and canonicalise a server URL.
///
/// Accepts only an `http(s)` origin — no path, query or fragment. A base with a path
/// would silently produce URLs like `https://host/foo/api/chat`, which fail as 404s
/// far from the setting that caused them.
pub fn normalize_api_base(raw: &str) -> Option<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    let url = tauri::Url::parse(trimmed).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.host_str()?;
    if url.path() != "/" && !url.path().is_empty() {
        return None;
    }
    if url.query().is_some() || url.fragment().is_some() {
        return None;
    }

    let port = url
        .port()
        .map(|p| format!(":{p}"))
        .unwrap_or_else(String::new);
    Some(format!(
        "{}://{}{}",
        url.scheme(),
        url.host_str().unwrap_or_default(),
        port
    ))
}

/// The script injected before any app script runs, handing the web layer its API base.
///
/// `serde_json` does the escaping — the value comes from a settings file a user could
/// hand-edit, and string-concatenating it into JS would be an injection into our own
/// window.
pub fn bootstrap_script(api_base_url: &str) -> String {
    let literal = serde_json::to_string(api_base_url).unwrap_or_else(|_| "\"\"".into());
    format!("window.__GREENHOUSE_DESKTOP_API_BASE__ = {literal};")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_an_origin_with_a_port() {
        assert_eq!(
            normalize_api_base("https://greenhouse.example.com:18888").as_deref(),
            Some("https://greenhouse.example.com:18888")
        );
    }

    #[test]
    fn strips_trailing_slashes() {
        assert_eq!(
            normalize_api_base("https://greenhouse.example.com:18888///").as_deref(),
            Some("https://greenhouse.example.com:18888")
        );
    }

    #[test]
    fn accepts_plain_localhost_for_local_development() {
        assert_eq!(
            normalize_api_base("http://localhost:3101").as_deref(),
            Some("http://localhost:3101")
        );
    }

    #[test]
    fn rejects_anything_that_is_not_a_bare_http_origin() {
        assert_eq!(normalize_api_base(""), None);
        assert_eq!(normalize_api_base("   "), None);
        assert_eq!(normalize_api_base("greenhouse.example.com"), None); // no scheme
        assert_eq!(normalize_api_base("ftp://example.com"), None);
        assert_eq!(normalize_api_base("javascript:alert(1)"), None);
        // A path would produce URLs like https://host/base/api/chat.
        assert_eq!(normalize_api_base("https://example.com/base"), None);
        assert_eq!(normalize_api_base("https://example.com?a=1"), None);
    }

    #[test]
    fn bootstrap_script_escapes_its_value() {
        // The settings file is hand-editable, so a value that tries to break out of
        // its string literal must survive as *data*. Assert the property directly:
        // the emitted literal parses back to exactly what went in.
        let hostile = "https://example.com\"; alert(1); //";
        let script = bootstrap_script(hostile);

        let literal = script
            .strip_prefix("window.__GREENHOUSE_DESKTOP_API_BASE__ = ")
            .and_then(|rest| rest.strip_suffix(';'))
            .expect("script has the expected shape");
        let parsed: String = serde_json::from_str(literal).expect("literal is valid JSON");
        assert_eq!(parsed, hostile);

        // And the raw quote is escaped rather than terminating the literal early.
        assert!(script.contains(r#"\""#), "quote was not escaped: {script}");
    }

    #[test]
    fn missing_settings_file_yields_defaults() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(load(tmp.path()), DesktopSettings::default());
    }

    #[test]
    fn corrupt_settings_file_yields_defaults_instead_of_failing_to_start() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(settings_path(tmp.path()), b"{ nope").unwrap();
        assert_eq!(load(tmp.path()), DesktopSettings::default());
    }

    #[test]
    fn an_unusable_stored_base_falls_back_to_the_default() {
        let tmp = tempfile::tempdir().unwrap();
        std::fs::write(settings_path(tmp.path()), br#"{"apiBaseUrl":"not a url"}"#).unwrap();
        assert_eq!(load(tmp.path()).api_base_url, DEFAULT_API_BASE_URL);
    }

    #[test]
    fn a_packaged_build_ignores_whatever_is_stored() {
        // Someone hand-edits settings.json, or a dev build leaves a localhost base
        // behind and the same app data dir is later used by a release build. Either
        // way the shipped app must stay on the dev deployment.
        assert_eq!(
            effective_api_base("http://localhost:3101", true),
            DEFAULT_API_BASE_URL
        );
        assert_eq!(effective_api_base("", true), DEFAULT_API_BASE_URL);
    }

    #[test]
    fn a_dev_build_honours_the_stored_base() {
        assert_eq!(
            effective_api_base("http://localhost:3101", false),
            "http://localhost:3101"
        );
        // …but still falls back rather than using something unusable.
        assert_eq!(effective_api_base("nonsense", false), DEFAULT_API_BASE_URL);
    }

    #[test]
    fn the_view_tells_the_ui_whether_to_show_a_server_control() {
        let stored = DesktopSettings {
            api_base_url: "http://localhost:3101".into(),
            ..DesktopSettings::default()
        };

        let packaged = view(&stored, true);
        assert!(packaged.api_base_locked);
        assert_eq!(packaged.api_base_url, DEFAULT_API_BASE_URL);

        let dev = view(&stored, false);
        assert!(!dev.api_base_locked);
        assert_eq!(dev.api_base_url, "http://localhost:3101");

        // Shortcuts come back resolved, so the UI shows what is actually registered.
        assert_eq!(dev.shortcuts.len(), crate::shortcuts::ShortcutId::ALL.len());
    }

    #[test]
    fn saved_settings_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = DesktopSettings {
            api_base_url: "http://localhost:3101".into(),
            ..DesktopSettings::default()
        };
        save(tmp.path(), &settings).unwrap();
        assert_eq!(load(tmp.path()), settings);
    }

    #[test]
    fn update_base_follows_the_api_server_unless_the_build_pinned_one() {
        let base = update_base("https://greenhouse.example.com:18888/");
        match BUILT_IN_UPDATE_BASE_URL {
            Some(pinned) => assert_eq!(base, pinned.trim_end_matches('/')),
            None => assert_eq!(base, "https://greenhouse.example.com:18888/updates/desktop"),
        }
    }

    #[test]
    fn the_update_source_is_always_an_allowed_artifact_origin() {
        let origins = artifact_origins("https://updates.example.com/desktop/");
        assert_eq!(origins[0], "https://updates.example.com/desktop");
        assert!(origins.iter().all(|o| !o.ends_with('/')));
    }
}

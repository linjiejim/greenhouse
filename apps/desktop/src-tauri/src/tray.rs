//! Menu bar / system tray presence.
//!
//! The tray is the app's "always reachable" surface — the point of a desktop client
//! is that it stays useful while the main window is closed or buried.
//!
//! The dropdown's *content* is owned by the hot-updatable web layer: it pushes a
//! [`TrayMenuModel`] (labels, Agent list, recent sessions with running state) via
//! `desktop_set_tray_menu`, and this module only renders that model as a native
//! menu. Clicks come back as one typed [`TrayAction`] event; the web layer decides
//! what each action does. Until the first push — including when the webview never
//! boots — the menu is a static Open/Quit fallback built here.

use serde::{Deserialize, Serialize};
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Runtime};

pub const TRAY_ID: &str = "main";
/// Payload: [`TrayAction`]. Listened to by the main window only.
pub const EVENT_TRAY_ACTION: &str = "desktop://tray-action";

const MENU_OPEN: &str = "tray_open";
const MENU_NEW_CHAT: &str = "tray_new_chat";
const MENU_SETTINGS: &str = "tray_settings";
const MENU_QUIT: &str = "tray_quit";
const PROFILE_PREFIX: &str = "tray_profile:";
const SESSION_PREFIX: &str = "tray_session:";

/// The web layer caps these too; enforced again here so a buggy bundle cannot
/// grow the menu without bound.
const MAX_PROFILES: usize = 8;
const MAX_SESSIONS: usize = 8;
const MAX_LABEL_CHARS: usize = 60;

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuModel {
    pub labels: TrayMenuLabels,
    /// Accelerator rendered beside "Open Greenhouse" — right-aligned and dimmed
    /// by AppKit itself. The web layer sends the user's *configured* `focus_main`
    /// binding, so rebinding the shortcut updates the menu with no shell release.
    #[serde(default)]
    pub open_accelerator: Option<String>,
    #[serde(default)]
    pub profiles: Vec<TrayProfileItem>,
    #[serde(default)]
    pub sessions: Vec<TraySessionItem>,
}

/// Every fixed label comes from the model so menu text is localized and
/// hot-updatable; nothing user-visible is hardcoded past the boot fallback.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayMenuLabels {
    pub open: String,
    pub new_chat: String,
    pub profiles: String,
    pub sessions: String,
    pub settings: String,
    pub quit: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrayProfileItem {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraySessionItem {
    pub id: String,
    pub label: String,
    #[serde(default)]
    pub running: bool,
}

/// What the web layer receives for a menu click. Open and Quit are handled
/// natively — they must keep working when the webview is wedged.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TrayAction {
    NewChat,
    Settings,
    Profile { id: String },
    Session { id: String },
}

pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, MENU_OPEN, "Open Greenhouse", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Quit", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/menubar-template.png"))?;
    let builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .tooltip("Greenhouse")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(handle_menu_event);
    #[cfg(target_os = "macos")]
    let builder = builder.icon_as_template(true);
    builder.build(app)?;

    Ok(())
}

/// Replace the dropdown with a freshly pushed model. Must run on the main thread
/// (AppKit menus are main-thread only) — the command wraps it accordingly.
pub fn apply<R: Runtime>(app: &AppHandle<R>, model: &TrayMenuModel) -> tauri::Result<()> {
    // No tray means install() failed at boot (e.g. no icon); nothing to update.
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    tray.set_menu(Some(build_menu(app, model)?))?;
    // The only positive signal that the web layer's push landed — without it a
    // menu stuck on Open/Quit is indistinguishable from an empty model.
    log::debug!(
        "[tray] menu applied: {} agents, {} sessions ({} running)",
        model.profiles.len(),
        model.sessions.len(),
        model.sessions.iter().filter(|s| s.running).count()
    );
    Ok(())
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, model: &TrayMenuModel) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(app)?;
    let label = |text: &str| clamp_label(text);

    // An unparseable accelerator would fail the whole build and leave the menu
    // stale, so a bad one is dropped rather than propagated.
    let open_accelerator = model
        .open_accelerator
        .as_deref()
        .filter(|raw| crate::shortcuts::is_valid_accelerator(raw));
    menu.append(&MenuItem::with_id(
        app,
        MENU_OPEN,
        label(&model.labels.open),
        true,
        open_accelerator,
    )?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_NEW_CHAT,
        label(&model.labels.new_chat),
        true,
        None::<&str>,
    )?)?;

    if !model.profiles.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        // A disabled item is the native idiom for a section header.
        menu.append(&MenuItem::with_id(
            app,
            "tray_header_profiles",
            label(&model.labels.profiles),
            false,
            None::<&str>,
        )?)?;
        for profile in model.profiles.iter().take(MAX_PROFILES) {
            menu.append(&MenuItem::with_id(
                app,
                format!("{PROFILE_PREFIX}{}", profile.id),
                label(&profile.label),
                true,
                None::<&str>,
            )?)?;
        }
    }

    if !model.sessions.is_empty() {
        menu.append(&PredefinedMenuItem::separator(app)?)?;
        menu.append(&MenuItem::with_id(
            app,
            "tray_header_sessions",
            label(&model.labels.sessions),
            false,
            None::<&str>,
        )?)?;
        for session in model.sessions.iter().take(MAX_SESSIONS) {
            // Plain items, not `IconMenuItem`: an icon indents only the rows that
            // carry one, so session titles would sit off the menu's left edge
            // while every other row hugs it. The running marker rides in the
            // label instead (see the web layer's `buildTrayMenuModel`).
            menu.append(&MenuItem::with_id(
                app,
                format!("{SESSION_PREFIX}{}", session.id),
                label(&session.label),
                true,
                None::<&str>,
            )?)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_SETTINGS,
        label(&model.labels.settings),
        true,
        None::<&str>,
    )?)?;
    menu.append(&MenuItem::with_id(
        app,
        MENU_QUIT,
        label(&model.labels.quit),
        true,
        None::<&str>,
    )?)?;

    Ok(menu)
}

fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    let id = event.id().as_ref();
    match id {
        MENU_OPEN => return crate::windows::focus_main(app),
        MENU_QUIT => return app.exit(0),
        _ => {}
    }
    let Some(action) = menu_action(id) else {
        return;
    };

    // Bring the window forward first: every routed action ends up there, and the
    // user should see movement even if the web handler is slow.
    crate::windows::focus_main(app);
    if let Err(err) = app.emit(EVENT_TRAY_ACTION, &action) {
        log::warn!("[tray] could not emit {action:?}: {err}");
    }
}

/// Map a clicked menu id to the action the web layer should route.
fn menu_action(id: &str) -> Option<TrayAction> {
    match id {
        MENU_NEW_CHAT => Some(TrayAction::NewChat),
        MENU_SETTINGS => Some(TrayAction::Settings),
        _ => {
            if let Some(profile_id) = id.strip_prefix(PROFILE_PREFIX) {
                Some(TrayAction::Profile {
                    id: profile_id.to_string(),
                })
            } else {
                id.strip_prefix(SESSION_PREFIX)
                    .map(|session_id| TrayAction::Session {
                        id: session_id.to_string(),
                    })
            }
        }
    }
}

/// The web layer truncates for display; this is the backstop against a buggy
/// bundle pushing an unbounded string into a native menu.
fn clamp_label(label: &str) -> String {
    let mut out: String = label.chars().take(MAX_LABEL_CHARS).collect();
    if label.chars().count() > MAX_LABEL_CHARS {
        out.push('…');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_menu_model_deserializes_from_the_shape_typescript_sends() {
        let model: TrayMenuModel = serde_json::from_str(
            r#"{
              "labels": {
                "open": "Open Greenhouse",
                "newChat": "New Chat",
                "profiles": "Agents",
                "sessions": "Recent chats",
                "settings": "Settings…",
                "quit": "Quit Greenhouse"
              },
              "openAccelerator": "CmdOrCtrl+G",
              "profiles": [{ "id": "team", "label": "Sprouty" }],
              "sessions": [{ "id": "abc123", "label": "标题 (3m) 🟢", "running": true }]
            }"#,
        )
        .expect("model parses");

        assert_eq!(model.labels.new_chat, "New Chat");
        assert_eq!(model.open_accelerator.as_deref(), Some("CmdOrCtrl+G"));
        assert_eq!(model.profiles[0].id, "team");
        assert!(model.sessions[0].running);
    }

    #[test]
    fn sessions_profiles_and_the_accelerator_may_be_omitted_entirely() {
        let model: TrayMenuModel = serde_json::from_str(
            r#"{"labels":{"open":"o","newChat":"n","profiles":"p","sessions":"s","settings":"e","quit":"q"}}"#,
        )
        .expect("model parses");
        assert!(model.profiles.is_empty());
        assert!(model.sessions.is_empty());
        assert_eq!(model.open_accelerator, None);
    }

    #[test]
    fn tray_actions_serialize_to_the_shape_typescript_expects() {
        assert_eq!(
            serde_json::to_value(TrayAction::NewChat).unwrap(),
            serde_json::json!({ "kind": "newChat" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::Settings).unwrap(),
            serde_json::json!({ "kind": "settings" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::Profile { id: "p1".into() }).unwrap(),
            serde_json::json!({ "kind": "profile", "id": "p1" })
        );
        assert_eq!(
            serde_json::to_value(TrayAction::Session { id: "s1".into() }).unwrap(),
            serde_json::json!({ "kind": "session", "id": "s1" })
        );
    }

    #[test]
    fn menu_ids_round_trip_to_actions() {
        assert_eq!(menu_action("tray_new_chat"), Some(TrayAction::NewChat));
        assert_eq!(menu_action("tray_settings"), Some(TrayAction::Settings));
        assert_eq!(
            menu_action("tray_profile:custom-7"),
            Some(TrayAction::Profile {
                id: "custom-7".into()
            })
        );
        assert_eq!(
            menu_action("tray_session:abc123"),
            Some(TrayAction::Session {
                id: "abc123".into()
            })
        );
        // Headers and unknown ids route nowhere.
        assert_eq!(menu_action("tray_header_sessions"), None);
        assert_eq!(menu_action("tray_open"), None);
    }

    #[test]
    fn labels_are_clamped_by_characters_not_bytes() {
        let long = "会".repeat(80);
        let clamped = clamp_label(&long);
        assert_eq!(clamped.chars().count(), MAX_LABEL_CHARS + 1);
        assert!(clamped.ends_with('…'));
        assert_eq!(clamp_label("short"), "short");
    }

    #[test]
    fn only_a_parseable_open_accelerator_reaches_the_menu() {
        // A rebound-but-unusable accelerator must not fail the whole menu build,
        // which would leave the tray showing a stale menu.
        assert!(crate::shortcuts::is_valid_accelerator("CmdOrCtrl+G"));
        assert!(!crate::shortcuts::is_valid_accelerator("not a shortcut"));
        assert!(!crate::shortcuts::is_valid_accelerator(""));
    }
}

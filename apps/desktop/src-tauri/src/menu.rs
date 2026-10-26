use serde::{Deserialize, Serialize};
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    Emitter, Manager,
};

#[derive(Deserialize)]
pub struct Shortcut {
    pub id: String,
    pub label: String,
    pub shortcut: String,
    pub accelerator: String,
    pub menu: String,
}
pub fn shortcuts() -> Vec<Shortcut> {
    serde_json::from_str(include_str!("../../../mobile/src/desktop/shortcuts.json"))
        .expect("Shared shortcut table")
}
#[derive(Deserialize, Serialize)]
pub struct Place {
    id: String,
    label: String,
}

pub fn install(app: &tauri::AppHandle, places: &[Place]) -> tauri::Result<()> {
    let menu = Menu::new(app)?;
    let table = shortcuts();
    for (id, title) in [
        ("app", "Greenhouse"),
        ("file", "文件"),
        ("edit", "编辑"),
        ("view", "显示"),
        ("go", "前往"),
        ("window", "窗口"),
        ("help", "帮助"),
    ] {
        let submenu = Submenu::new(app, title, true)?;
        if id == "app" {
            submenu.append(&PredefinedMenuItem::about(app, None, None)?)?;
        }
        for shortcut in table.iter().filter(|s| s.menu == id && id != "go") {
            submenu.append(&MenuItem::with_id(
                app,
                &shortcut.id,
                &shortcut.label,
                true,
                Some(shortcut.accelerator.as_str()),
            )?)?;
        }
        match id {
            "app" => {
                if !option_env!("GREENHOUSE_UPDATER_ENDPOINT")
                    .unwrap_or("")
                    .is_empty()
                {
                    submenu.append(&MenuItem::with_id(
                        app,
                        "update",
                        "检查并安装更新…",
                        true,
                        None::<&str>,
                    )?)?;
                }
                submenu.append(&PredefinedMenuItem::separator(app)?)?;
                submenu.append(&PredefinedMenuItem::hide(app, None)?)?;
                submenu.append(&PredefinedMenuItem::hide_others(app, None)?)?;
                submenu.append(&PredefinedMenuItem::show_all(app, None)?)?;
                submenu.append(&PredefinedMenuItem::quit(app, None)?)?;
            }
            "edit" => {
                submenu.append(&PredefinedMenuItem::undo(app, None)?)?;
                submenu.append(&PredefinedMenuItem::redo(app, None)?)?;
                submenu.append(&PredefinedMenuItem::cut(app, None)?)?;
                submenu.append(&PredefinedMenuItem::copy(app, None)?)?;
                submenu.append(&PredefinedMenuItem::paste(app, None)?)?;
                submenu.append(&PredefinedMenuItem::select_all(app, None)?)?;
            }
            "go" => {
                for (index, place) in places.iter().enumerate() {
                    let key = format!("place-{}", index + 1);
                    let accelerator = table
                        .iter()
                        .find(|s| s.id == key)
                        .map(|s| s.accelerator.as_str());
                    submenu.append(&MenuItem::with_id(
                        app,
                        format!("go:{}", place.id),
                        &place.label,
                        true,
                        accelerator,
                    )?)?;
                }
            }
            "window" => {
                submenu.append(&PredefinedMenuItem::minimize(app, None)?)?;
                submenu.append(&PredefinedMenuItem::maximize(app, None)?)?;
                submenu.append(&PredefinedMenuItem::fullscreen(app, None)?)?;
                submenu.append(&PredefinedMenuItem::bring_all_to_front(app, None)?)?;
            }
            "help" => submenu.append(&MenuItem::with_id(
                app,
                "help",
                "Greenhouse 帮助",
                true,
                None::<&str>,
            )?)?,
            _ => {}
        }
        menu.append(&submenu)?;
    }
    app.set_menu(menu)?;
    Ok(())
}

#[tauri::command]
pub fn sync_places(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    places: Vec<Place>,
) -> Result<(), String> {
    if window.label() != "main" {
        return Err("Only the main window owns navigation".into());
    }
    if places.len() > 64
        || places
            .iter()
            .any(|p| p.id.len() > 200 || p.label.len() > 200)
    {
        return Err("Invalid places".into());
    }
    install(&app, &places).map_err(|e| e.to_string())
}

pub fn dispatch(app: &tauri::AppHandle, id: &str) {
    if id == "settings" {
        let _ = super::open_settings(app.clone());
        return;
    }
    if id == "help" {
        let _ = super::open_external(
            app.clone(),
            "https://github.com/linjiejim/greenhouse#readme".into(),
        );
        return;
    }
    if id.starts_with("go:") || ["new", "search", "secondary"].contains(&id) {
        let _ = super::window(app, "main");
    }
    let window = app
        .webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false));
    if let Some(window) = window {
        if id == "update" {
            let _ = window.emit("desktop:update", ());
        } else if let Some(place) = id.strip_prefix("go:") {
            let _ = app.emit_to("main", "desktop:place", place);
        } else if let Some(shortcut) = shortcuts().iter().find(|s| s.id == id) {
            let _ = window.emit("desktop:shortcut", &shortcut.shortcut);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn every_native_accelerator_matches_the_shared_js_binding() {
        let table = shortcuts();
        let mut ids = std::collections::HashSet::new();
        for row in &table {
            assert!(ids.insert(&row.id));
            assert_eq!(
                row.accelerator.to_lowercase().replace("cmdorctrl", "mod"),
                row.shortcut
            );
        }
        for id in [
            "new",
            "search",
            "secondary",
            "settings",
            "refresh",
            "close",
            "place-1",
            "place-6",
        ] {
            assert!(table.iter().any(|s| s.id == id), "Missing {id}");
        }
    }
}

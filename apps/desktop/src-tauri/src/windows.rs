//! Window management — the main window plus its satellite surfaces.
//!
//! Satellite windows load *routes of the same web app* (`#/desktop/quick` and
//! `#/desktop/selection-bar`) rather than native UI.
//! That's the core bet of this shell: everything the user sees is web, so it ships
//! through hot updates, and the Rust side only owns things a webview genuinely
//! can't do — being always-on-top, not stealing focus, and appearing at an
//! arbitrary screen coordinate.

use serde::Deserialize;
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const MAIN: &str = "main";
pub const QUICK: &str = "quick";
pub const SELECTION_BAR: &str = "selection-bar";

const QUICK_SIZE: (f64, f64) = (500.0, 210.0);
const SELECTION_ICON_SIZE: (f64, f64) = (40.0, 40.0);
const SELECTION_PROFILES_SIZE: (f64, f64) = (320.0, 48.0);
const SELECTION_COMPOSER_SIZE: (f64, f64) = (420.0, 240.0);
const SELECTION_CURSOR_GAP: f64 = 12.0;
const WINDOW_MARGIN: f64 = 8.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SelectionSurfaceMode {
    Icon,
    Profiles,
    Composer,
}

impl SelectionSurfaceMode {
    fn size(self) -> (f64, f64) {
        match self {
            Self::Icon => SELECTION_ICON_SIZE,
            Self::Profiles => SELECTION_PROFILES_SIZE,
            Self::Composer => SELECTION_COMPOSER_SIZE,
        }
    }
}

/// Build the URL for a hash route, matching however the main window was loaded.
///
/// In dev this resolves against `devUrl` (Vite, with HMR); in a packaged build it
/// goes through the `greenhouse://` scheme. See `crate::app_url`.
pub fn route_url(hash: &str) -> WebviewUrl {
    if tauri::is_dev() {
        WebviewUrl::App(format!("index.html#{hash}").into())
    } else {
        let mut url = crate::app_url();
        url.set_fragment(Some(hash));
        WebviewUrl::CustomProtocol(url)
    }
}

/// Show the quick-capture composer, creating it the first time.
///
/// Hidden rather than destroyed on close, so the second invocation is instant — this
/// is on the critical path of a global hotkey, where a cold webview start is felt.
pub fn toggle_quick<R: Runtime>(app: &AppHandle<R>, bootstrap: &str) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(QUICK) {
        if window.is_visible().unwrap_or(false) {
            window.hide()?;
        } else {
            window.show()?;
            window.set_focus()?;
        }
        return Ok(());
    }

    let window = WebviewWindowBuilder::new(app, QUICK, route_url("/desktop/quick"))
        .title("Greenhouse Quick Capture")
        .inner_size(QUICK_SIZE.0, QUICK_SIZE.1)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .center()
        // Not in the taskbar/dock switcher: this is a transient prompt, not a document.
        .skip_taskbar(true)
        .initialization_script(bootstrap)
        .build()?;
    window.set_focus()?;
    Ok(())
}

pub fn hide_quick<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(QUICK) {
        let _ = window.hide();
    }
}

/// Show the floating selection bar at a screen position.
///
/// `focused(false)` is essential: taking focus would collapse the very selection the
/// bar exists to act on.
pub fn show_selection_bar<R: Runtime>(
    app: &AppHandle<R>,
    x: f64,
    y: f64,
    bootstrap: &str,
) -> tauri::Result<WebviewWindow<R>> {
    let (position_x, position_y) = selection_icon_position((x, y));
    let position = tauri::LogicalPosition::new(position_x, position_y);

    if let Some(window) = app.get_webview_window(SELECTION_BAR) {
        window.set_position(position)?;
        window.show()?;
        return Ok(window);
    }

    let window = WebviewWindowBuilder::new(app, SELECTION_BAR, route_url("/desktop/selection-bar"))
        .title("Greenhouse Selection")
        .inner_size(SELECTION_ICON_SIZE.0, SELECTION_ICON_SIZE.1)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .position(position.x, position.y)
        .initialization_script(bootstrap)
        .build()?;
    Ok(window)
}

pub fn hide_selection_bar<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(SELECTION_BAR) {
        let _ = window.hide();
    }
}

/// Switch the reused selection window between its passive icon, Agent choices, and
/// focused composer. The current monitor's work area is the authority: growing a
/// window beside the cursor must not push the actions beyond a screen edge.
pub fn set_selection_surface_mode<R: Runtime>(
    app: &AppHandle<R>,
    mode: SelectionSurfaceMode,
) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(SELECTION_BAR) else {
        return Ok(());
    };
    let size = mode.size();
    window.set_size(tauri::LogicalSize::new(size.0, size.1))?;
    window.set_focusable(mode == SelectionSurfaceMode::Composer)?;
    clamp_to_current_work_area(&window, size)?;
    if mode == SelectionSurfaceMode::Composer {
        window.set_focus()?;
    }
    Ok(())
}

fn clamp_to_current_work_area<R: Runtime>(
    window: &WebviewWindow<R>,
    window_size: (f64, f64),
) -> tauri::Result<()> {
    let Some(monitor) = window.current_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let current = window.outer_position()?.to_logical::<f64>(scale);
    let work = monitor.work_area();
    let work_position = work.position.to_logical::<f64>(scale);
    let work_size = work.size.to_logical::<f64>(scale);
    let (x, y) = clamp_position(
        (current.x, current.y),
        window_size,
        (work_position.x, work_position.y),
        (work_size.width, work_size.height),
    );
    window.set_position(tauri::LogicalPosition::new(x, y))?;
    Ok(())
}

fn clamp_position(
    position: (f64, f64),
    window_size: (f64, f64),
    work_position: (f64, f64),
    work_size: (f64, f64),
) -> (f64, f64) {
    let min_x = work_position.0 + WINDOW_MARGIN;
    let min_y = work_position.1 + WINDOW_MARGIN;
    let max_x = (work_position.0 + work_size.0 - window_size.0 - WINDOW_MARGIN).max(min_x);
    let max_y = (work_position.1 + work_size.1 - window_size.1 - WINDOW_MARGIN).max(min_y);
    (
        position.0.clamp(min_x, max_x),
        position.1.clamp(min_y, max_y),
    )
}

/// Apply the desired upper-right offset before work-area clamping.
///
/// Manual desktop QA still shows a coordinate-space mismatch on some macOS
/// layouts. Keep this arithmetic isolated until monitor origin/scale diagnostics
/// can drive the follow-up normalization work documented in the feature spec.
fn selection_icon_position(cursor: (f64, f64)) -> (f64, f64) {
    (
        cursor.0 + SELECTION_CURSOR_GAP,
        cursor.1 - SELECTION_ICON_SIZE.1 - SELECTION_CURSOR_GAP,
    )
}

/// Present the selection bar after the web bundle has applied its display policy.
///
/// The shell still owns positioning an always-on-top native window, but it no
/// longer decides whether a selection deserves UI. That policy stays hot-updatable.
pub fn present_selection_bar<R: Runtime>(
    app: &AppHandle<R>,
    x: f64,
    y: f64,
    bootstrap: &str,
) -> tauri::Result<()> {
    show_selection_bar(app, x, y, bootstrap)?;
    set_selection_surface_mode(app, SelectionSurfaceMode::Icon)
}

/// Bring the main window back — it may be hidden, minimised, or behind other apps.
pub fn focus_main<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_position, selection_icon_position, SelectionSurfaceMode};

    #[test]
    fn selection_surface_modes_stay_compact_until_composing() {
        assert_eq!(SelectionSurfaceMode::Icon.size(), (40.0, 40.0));
        assert_eq!(SelectionSurfaceMode::Profiles.size(), (320.0, 48.0));
        assert_eq!(SelectionSurfaceMode::Composer.size(), (420.0, 240.0));
    }

    #[test]
    fn anchors_selection_icon_above_and_right_of_pointer() {
        assert_eq!(selection_icon_position((320.0, 240.0)), (332.0, 188.0));
    }

    #[test]
    fn clamps_expanded_surface_inside_positive_work_area() {
        assert_eq!(
            clamp_position(
                (1390.0, 850.0),
                (420.0, 240.0),
                (0.0, 24.0),
                (1440.0, 876.0)
            ),
            (1012.0, 652.0)
        );
    }

    #[test]
    fn preserves_negative_monitor_coordinates() {
        assert_eq!(
            clamp_position(
                (-1500.0, 20.0),
                (420.0, 240.0),
                (-1920.0, 0.0),
                (1920.0, 1080.0)
            ),
            (-1500.0, 20.0)
        );
    }
}

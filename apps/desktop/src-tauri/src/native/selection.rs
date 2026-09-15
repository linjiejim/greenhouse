//! Reading the user's text selection from *any* application.
//!
//! Two strategies, and which one is allowed depends on how we were triggered:
//!
//! - **Accessibility (`AXSelectedText`)** — reads the selection directly. No side
//!   effects. Not every app exposes it (canvas-drawn UIs often don't).
//! - **Simulated ⌘C** — works nearly everywhere, but it *writes to the clipboard*.
//!   We save and restore the previous contents, yet there's still a window where the
//!   user's clipboard isn't theirs.
//!
//! So: the always-on watcher is **Accessibility only**. Doing a simulated copy on
//! every mouse-up would fight the user for their clipboard all day. The explicit
//! hotkey may fall back to ⌘C, because there the user just asked for it.

use super::{Availability, Permission};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelectionSource {
    Accessibility,
    Clipboard,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub text: String,
    pub source: SelectionSource,
    /// Screen coordinates to anchor the floating bar to; absent for hotkey reads.
    pub x: Option<f64>,
    pub y: Option<f64>,
}

pub fn availability() -> Availability {
    #[cfg(target_os = "macos")]
    {
        if super::perms::status().accessibility {
            Availability::Available
        } else {
            Availability::NeedsPermission {
                permission: Permission::Accessibility,
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = Permission::Accessibility;
        Availability::unsupported("Reading selections from other apps is macOS-only in this build")
    }
}

/// Read the current selection, falling back to a simulated copy when allowed.
///
/// `allow_clipboard_fallback` should be true only for user-initiated reads.
pub fn read_selected_text(allow_clipboard_fallback: bool) -> Result<Option<Selection>, String> {
    #[cfg(target_os = "macos")]
    {
        if !super::perms::status().accessibility {
            return Err("Accessibility permission is required to read the selection".into());
        }
        if let Some(text) = mac::accessibility_selected_text() {
            return Ok(Some(Selection {
                text,
                source: SelectionSource::Accessibility,
                x: None,
                y: None,
            }));
        }
        if allow_clipboard_fallback {
            if let Some(text) = mac::clipboard_selected_text()? {
                return Ok(Some(Selection {
                    text,
                    source: SelectionSource::Clipboard,
                    x: None,
                    y: None,
                }));
            }
        }
        Ok(None)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = allow_clipboard_fallback;
        Err("Reading selections from other apps is macOS-only in this build".into())
    }
}

// ─── Global selection watcher ────────────────────────────

static WATCHING: AtomicBool = AtomicBool::new(false);
static WATCHER_STARTED: AtomicBool = AtomicBool::new(false);
/// Last emitted text, so holding a selection and clicking around doesn't re-fire.
static LAST_EMITTED: Mutex<String> = Mutex::new(String::new());

/// What changed after a mouse-up. Keeping this separate from the platform event tap
/// makes the boundary between "same selection", "new selection", and "selection
/// cleared" deterministic and unit-testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SelectionChange {
    Changed,
    Cleared,
    Unchanged,
}

pub enum SelectionWatchEvent {
    Selected(Selection),
    Cleared,
}

pub fn is_watching() -> bool {
    WATCHING.load(Ordering::Relaxed)
}

/// Turn the always-on selection watcher on or off.
///
/// The OS event tap is started once and then left running, gated by a flag: tearing
/// down a CFRunLoop cleanly from another thread is fiddly, and the tap costs nothing
/// while it's ignoring events. `on_selection` is only wired up on the first call.
pub fn set_watching(
    enabled: bool,
    on_event: impl Fn(SelectionWatchEvent) + Send + 'static,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        if enabled && !super::perms::status().accessibility {
            return Err("Accessibility permission is required to watch for selections".into());
        }
        WATCHING.store(enabled, Ordering::Relaxed);
        if enabled && !WATCHER_STARTED.swap(true, Ordering::SeqCst) {
            mac::spawn_watcher(on_event);
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (enabled, on_event);
        Err("The selection watcher is macOS-only in this build".into())
    }
}

/// Classify the current Accessibility selection against the last emitted value.
///
/// An empty read becomes `Cleared` only after a real selection was emitted. This
/// prevents ordinary clicks from generating a stream of meaningless clear events.
fn observe_selection(text: Option<&str>) -> SelectionChange {
    let trimmed = text.unwrap_or_default().trim();
    let mut last = LAST_EMITTED.lock().expect("selection mutex poisoned");
    if trimmed.is_empty() {
        if last.is_empty() {
            return SelectionChange::Unchanged;
        }
        last.clear();
        return SelectionChange::Cleared;
    }
    if *last == trimmed {
        return SelectionChange::Unchanged;
    }
    *last = trimmed.to_string();
    SelectionChange::Changed
}

/// Forget the last emitted selection, so the same text can pop again later.
pub fn reset_dedup() {
    if let Ok(mut last) = LAST_EMITTED.lock() {
        last.clear();
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::{
        observe_selection, Selection, SelectionChange, SelectionSource, SelectionWatchEvent,
        WATCHING,
    };
    use accessibility_sys::{
        kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXSelectedTextAttribute, AXError,
        AXUIElementCopyAttributeValue, AXUIElementCreateSystemWide, AXUIElementRef,
    };
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{
        CGEvent, CGEventFlags, CGEventTap, CGEventTapLocation, CGEventTapOptions,
        CGEventTapPlacement, CGEventType, CallbackResult,
    };
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};
    use std::sync::atomic::Ordering;
    use std::time::Duration;

    /// macOS virtual keycode for the `C` key (`kVK_ANSI_C`).
    const KEYCODE_C: u16 = 8;
    /// How long to wait for the focused app to publish its selection.
    const SETTLE: Duration = Duration::from_millis(120);

    pub fn accessibility_selected_text() -> Option<String> {
        unsafe {
            let system = AXUIElementCreateSystemWide();
            if system.is_null() {
                return None;
            }
            let focused = copy_attr(system, kAXFocusedUIElementAttribute);
            CFRelease(system as CFTypeRef);
            let focused = focused?;

            let value = copy_attr(focused as AXUIElementRef, kAXSelectedTextAttribute);
            CFRelease(focused);
            let value = value?;

            let text = CFString::wrap_under_create_rule(value as CFStringRef).to_string();
            (!text.trim().is_empty()).then_some(text)
        }
    }

    unsafe fn copy_attr(element: AXUIElementRef, attribute: &str) -> Option<CFTypeRef> {
        let attr = CFString::new(attribute);
        let mut out: CFTypeRef = std::ptr::null();
        let err: AXError =
            AXUIElementCopyAttributeValue(element, attr.as_concrete_TypeRef(), &mut out);
        if err != kAXErrorSuccess || out.is_null() {
            return None;
        }
        Some(out)
    }

    /// Simulate ⌘C and read what landed, then put the user's clipboard back.
    pub fn clipboard_selected_text() -> Result<Option<String>, String> {
        let mut clipboard =
            arboard::Clipboard::new().map_err(|e| format!("could not open the clipboard: {e}"))?;
        let previous = clipboard.get_text().ok();

        press_command_c()?;
        std::thread::sleep(SETTLE);

        let copied = clipboard.get_text().ok();

        // Restore before returning, on every path — the clipboard is the user's, and
        // we borrowed it. If they had nothing there, leaving our copy behind is the
        // least surprising option (clearing could destroy a non-text item we can't see).
        if let Some(previous) = previous.as_deref() {
            if Some(previous) != copied.as_deref() {
                let _ = clipboard.set_text(previous);
            }
        }

        Ok(copied.filter(|t| !t.trim().is_empty()))
    }

    fn press_command_c() -> Result<(), String> {
        let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState)
            .map_err(|_| "could not create an event source".to_string())?;
        for down in [true, false] {
            let event = CGEvent::new_keyboard_event(source.clone(), KEYCODE_C, down)
                .map_err(|_| "could not synthesise a key event".to_string())?;
            event.set_flags(CGEventFlags::CGEventFlagCommand);
            event.post(CGEventTapLocation::HID);
        }
        Ok(())
    }

    /// Watch global left-mouse-up and report selections at the cursor.
    pub fn spawn_watcher(on_event: impl Fn(SelectionWatchEvent) + Send + 'static) {
        let (tx, rx) = std::sync::mpsc::channel::<(f64, f64)>();

        // The tap callback runs on the event path — macOS disables a tap that dawdles,
        // so it only forwards coordinates. The Accessibility read (tens of ms) happens
        // on the worker below.
        std::thread::spawn(move || {
            let tap = match CGEventTap::new(
                CGEventTapLocation::Session,
                CGEventTapPlacement::HeadInsertEventTap,
                // ListenOnly — never swallow or alter the user's clicks.
                CGEventTapOptions::ListenOnly,
                vec![CGEventType::LeftMouseUp],
                move |_proxy, _event_type, event| {
                    if WATCHING.load(Ordering::Relaxed) {
                        let point = event.location();
                        let _ = tx.send((point.x, point.y));
                    }
                    CallbackResult::Keep
                },
            ) {
                Ok(tap) => tap,
                Err(_) => {
                    log::warn!("[selection] could not create the event tap");
                    return;
                }
            };

            let Ok(source) = tap.mach_port().create_runloop_source(0) else {
                log::warn!("[selection] could not create a run loop source");
                return;
            };

            // A CGEventTap needs a live CFRunLoop. Tauri owns the main one, so the tap
            // gets its own on this thread — which is also why the tap can never block
            // the UI.
            let run_loop = CFRunLoop::get_current();
            unsafe { run_loop.add_source(&source, kCFRunLoopCommonModes) };
            tap.enable();
            log::info!("[selection] watcher armed");
            CFRunLoop::run_current();
        });

        std::thread::spawn(move || {
            for (x, y) in rx {
                if !WATCHING.load(Ordering::Relaxed) {
                    continue;
                }
                std::thread::sleep(SETTLE);
                // Accessibility only here — a simulated ⌘C on every mouse-up would
                // trample the user's clipboard continuously.
                let text = accessibility_selected_text();
                match observe_selection(text.as_deref()) {
                    SelectionChange::Changed => {
                        let text = text.expect("changed selections always contain text");
                        on_event(SelectionWatchEvent::Selected(Selection {
                            text,
                            source: SelectionSource::Accessibility,
                            x: Some(x),
                            y: Some(y),
                        }));
                    }
                    SelectionChange::Cleared => on_event(SelectionWatchEvent::Cleared),
                    SelectionChange::Unchanged => {}
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selection_observer_reports_changes_repeats_and_clears() {
        reset_dedup();
        assert_eq!(observe_selection(None), SelectionChange::Unchanged);
        assert_eq!(observe_selection(Some("hello")), SelectionChange::Changed);
        // Same selection, user clicked elsewhere — must not pop again.
        assert_eq!(observe_selection(Some("hello")), SelectionChange::Unchanged);
        // Whitespace differences are not a new selection.
        assert_eq!(
            observe_selection(Some("  hello  ")),
            SelectionChange::Unchanged
        );
        assert_eq!(observe_selection(Some("world")), SelectionChange::Changed);
        // Clearing a real selection emits once, then ordinary clicks stay quiet.
        assert_eq!(observe_selection(Some("   \n ")), SelectionChange::Cleared);
        assert_eq!(observe_selection(None), SelectionChange::Unchanged);
        // After a clear the same text can pop again.
        assert_eq!(observe_selection(Some("world")), SelectionChange::Changed);
        reset_dedup();
        assert_eq!(observe_selection(Some("world")), SelectionChange::Changed);
    }
}

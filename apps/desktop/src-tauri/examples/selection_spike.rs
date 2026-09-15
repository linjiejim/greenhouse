//! P0-S2 spike — can we detect a text selection made in *any* app, without
//! hijacking the clipboard?
//!
//! Two questions, answered by running this and dragging over text in Safari, Notes,
//! VS Code, Terminal, …:
//!
//!   1. Can a CGEventTap watch global left-mouse-up from a spawned thread while
//!      Tauri owns the main run loop? (The tap needs its own CFRunLoop.)
//!   2. Does `AXSelectedText` on the focused element return the selection, so we
//!      never have to simulate ⌘C and clobber the user's clipboard?
//!
//! Run: `cargo run --example selection_spike`
//! Requires Accessibility permission for the *terminal* running it.

#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("This spike is macOS-only.");
}

#[cfg(target_os = "macos")]
fn main() {
    use std::sync::mpsc;
    use std::time::Duration;

    let (tx, rx) = mpsc::channel::<(f64, f64)>();

    if !mac::accessibility_trusted() {
        eprintln!(
            "⚠️  Accessibility permission not granted.\n\
             Grant it to this terminal in System Settings → Privacy & Security → Accessibility,\n\
             then re-run. Prompting now..."
        );
        mac::prompt_for_accessibility();
    }

    // Q1: the tap lives on its own thread with its own run loop.
    std::thread::spawn(move || mac::watch_left_mouse_up(tx));

    println!("👀 Watching for text selections. Select text in any app. Ctrl-C to stop.\n");

    // The tap callback must return fast or macOS disables the tap, so the AX read
    // (which can take tens of ms) happens here, off the event path.
    for (x, y) in rx {
        // Let the app commit its selection before we ask for it.
        std::thread::sleep(Duration::from_millis(120));
        match mac::selected_text() {
            Some(text) => {
                let preview: String = text.chars().take(80).collect();
                println!("✅ ({x:.0},{y:.0}) [{}] {preview}", text.chars().count());
            }
            None => println!("—  ({x:.0},{y:.0}) no selection exposed"),
        }
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use accessibility_sys::{
        kAXErrorSuccess, kAXFocusedUIElementAttribute, kAXSelectedTextAttribute, AXError,
        AXIsProcessTrustedWithOptions, AXUIElementCopyAttributeValue, AXUIElementCreateSystemWide,
        AXUIElementRef,
    };
    use core_foundation::base::{CFRelease, CFTypeRef, TCFType};
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::runloop::{kCFRunLoopCommonModes, CFRunLoop};
    use core_foundation::string::{CFString, CFStringRef};
    use core_graphics::event::{
        CGEventTap, CGEventTapLocation, CGEventTapOptions, CGEventTapPlacement, CGEventType,
        CallbackResult,
    };
    use std::sync::mpsc::Sender;

    pub fn accessibility_trusted() -> bool {
        // Passing an empty options dict checks without prompting.
        unsafe { AXIsProcessTrustedWithOptions(std::ptr::null()) }
    }

    pub fn prompt_for_accessibility() {
        let key = CFString::from_static_string("AXTrustedCheckOptionPrompt");
        let options = CFDictionary::from_CFType_pairs(&[(key, CFBoolean::true_value())]);
        unsafe {
            AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef() as *const _);
        }
    }

    /// Read the selection from whatever UI element currently has focus.
    ///
    /// Returns `None` when the app doesn't expose `AXSelectedText` — common for
    /// canvas-drawn UIs. Callers must treat that as "unknown", not "empty".
    pub fn selected_text() -> Option<String> {
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
            if text.trim().is_empty() {
                None
            } else {
                Some(text)
            }
        }
    }

    /// `AXUIElementCopyAttributeValue`, returning an owned (create-rule) CFTypeRef.
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

    /// Block on a CFRunLoop watching global left-mouse-up. Call from a spawned thread.
    pub fn watch_left_mouse_up(tx: Sender<(f64, f64)>) {
        let tap = match CGEventTap::new(
            CGEventTapLocation::Session,
            CGEventTapPlacement::HeadInsertEventTap,
            // ListenOnly: we observe, never modify or swallow the user's clicks.
            CGEventTapOptions::ListenOnly,
            vec![CGEventType::LeftMouseUp],
            move |_proxy, _event_type, event| {
                let p = event.location();
                let _ = tx.send((p.x, p.y));
                CallbackResult::Keep
            },
        ) {
            Ok(tap) => tap,
            Err(_) => {
                eprintln!("❌ CGEventTap::new failed — Accessibility permission is missing.");
                return;
            }
        };

        let source = match tap.mach_port().create_runloop_source(0) {
            Ok(s) => s,
            Err(_) => {
                eprintln!("❌ could not create a run loop source for the tap");
                return;
            }
        };

        let run_loop = CFRunLoop::get_current();
        unsafe { run_loop.add_source(&source, kCFRunLoopCommonModes) };
        tap.enable();
        println!("🎧 event tap armed on a background run loop");
        CFRunLoop::run_current();
    }
}

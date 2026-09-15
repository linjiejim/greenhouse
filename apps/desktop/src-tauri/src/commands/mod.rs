//! Native command surface exposed to the web app.
//!
//! Every capability the web layer can reach is an explicit `#[tauri::command]`
//! listed here — there is deliberately no "run an arbitrary command / read an
//! arbitrary path" escape hatch. The typed mirror of this surface lives in
//! `apps/web/src/lib/desktop/types.ts`; the two must be changed together.

pub mod native;
pub mod settings;
pub mod system;
pub mod tray;
pub mod updates;
pub mod windows;

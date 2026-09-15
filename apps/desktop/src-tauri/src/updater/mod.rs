//! Updates, in two independent lines.
//!
//! | Layer      | What changes                  | Mechanism                        |
//! |------------|-------------------------------|----------------------------------|
//! | web bundle | everything in `apps/web`      | `web_bundle` — signed, frequent  |
//! | shell      | native commands, permissions  | `tauri-plugin-updater` — rare    |
//!
//! Keeping them separate is the point: a UI change costs a ~2 MB signed tarball and
//! a restart, not a full app reinstall.

pub mod web_bundle;

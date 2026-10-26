# Desktop shell (C6)

- This is a macOS Tauri 2 host for the bundled Expo universal client, never a remote server page. UI and domain logic stay in apps/mobile.
- Run `pnpm desktop:check` and `pnpm desktop:build`; the latter emits a local ad-hoc .app and .dmg. Do not launch it in restricted runners.
- Every Cargo command uses `CARGO_HOME=$PWD/.cargo-home` and `CARGO_TARGET_DIR=$PWD/apps/desktop/src-tauri/target` from the repository root; both are ignored. Keep Cargo.lock in version control.
- `apps/mobile/src/desktop/shortcuts.json` is compiled into Rust and imported by useShortcut consumers. Menu navigation is supplied by the authorized rail, including plugin places.
- Only bundled main/settings/quick-ask windows receive native capabilities. Remote plugin frames have no native capabilities; main-frame remote navigation and new windows are denied.
- The local `credentials` Tauri plugin stores station credentials in macOS Keychain. Preferences use a desktop-prefixed localStorage namespace. Never fall back to localStorage for tokens.
- Keep `com.linjiejim.greenhouse` and the existing updater public key. Updates remain disabled without build-time GREENHOUSE_UPDATER_ENDPOINT. Private signing keys are never committed.
- Native window, menu, notification, storage and channel integration belongs in platform bridge files; do not branch business pages on a desktop flag.
- Server changes belong to the backend lane: allow tauri://localhost CORS and X-Greenhouse-Client: desktop, plus the plugin embed frame origin; see README.md here.

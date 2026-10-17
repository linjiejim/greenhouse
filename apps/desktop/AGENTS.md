# apps/desktop: Tauri shell

The desktop app wraps apps/web for macOS and Windows and adds native capture: screenshots, selection, clipboard, global shortcuts and the tray. It is the same product as the web app.

## Where code goes
- Write features in apps/web, including satellite windows (`#/desktop/*`), shortcut behavior, tray menu content and desktop settings; web changes reach installed apps as signed hot updates, shell changes need a new build.
- Add Rust only for a system call the browser cannot make: one named #[tauri::command] in src-tauri/src/commands, mirrored in the command map of apps/web/src/lib/desktop/shell.ts in the same change.
- Never add a generic run-command, read-path or download-any-URL capability.
- Bump nativeApiVersion in apps/desktop/package.json whenever the command surface changes, and only then: web bundles inherit it as minShellVersion. Never gate compatibility on the product version.
- The tray only renders the TrayMenuModel that web pushes with desktop_set_tray_menu and keeps its built-in Open/Quit until then, so it works when the webview is dead.

## Development
- `pnpm desktop:dev` runs web (:3100) and the shell but no API; run `pnpm api` alongside. The window calls http://localhost:3000 directly, not through the Vite proxy.
- `pnpm desktop:build` builds .app, .dmg and nsis; `pnpm desktop:check` runs fmt, clippy -D warnings and the node and cargo tests; `pnpm desktop:verify-web-update` checks a v(N-1) to v(N) hot update on macOS (`-- --local` serves this checkout with a throwaway key, never a live channel).
- Run cargo through the package scripts (scripts/with-shared-target.mjs): they share ~/.cargo-target/greenhouse-desktop across worktrees and ad-hoc sign local macOS bundles. A bare cargo build creates an in-tree target/ that is safe to delete.
- An unsealed local bundle can show Accessibility enabled while AXIsProcessTrusted returns false; build through the wrapper.
- build.rs reads CARGO_MANIFEST_DIR at run time; env! would bake in the worktree that compiled the script, which the shared target then reuses.
- GREENHOUSE_QA_APP_DATA_DIR isolates the shell's data, not WebKit storage: an unbundled debug binary keeps localStorage in ~/Library/WebKit/greenhouse-desktop across runs.
- tauri::is_dev() follows the custom-protocol feature, not the profile; test the packaged path with `cargo run --features tauri/custom-protocol --manifest-path apps/desktop/src-tauri/Cargo.toml`.
- Keep `**/target/` excluded from eslint and prettier; tauri-codegen writes .js there.

## Deployment configuration
- Never edit tauri.conf.json per deployment; set `GREENHOUSE_DESKTOP_*` and `GREENHOUSE_WEB_BUNDLE_*` at build time (read by scripts/tauri-config.mjs and src-tauri/build.rs).
- GREENHOUSE_DESKTOP_API_BASE fixes the server and hides the setting; it must be a bare origin.
- Without it the server is a setting in web (sign-in and 设置 → 桌面端). The base reaches the page only in a new process (a reload re-runs the old bootstrap script), so a switch signs out and restarts the app (apps/web/src/lib/desktop/server.ts).
- The committed CSP is for an unlocked app: connect-src allows any https/wss server and this computer on any port. With GREENHOUSE_DESKTOP_API_BASE the overlay drops https:/wss: from connect-src and names that server. Only tauri dev|build applies the overlay; a plain cargo build uses the committed CSP.
- An installed base must keep its GREENHOUSE_DESKTOP_IDENTIFIER, or every user re-grants permissions and loses staged updates.
- Without GREENHOUSE_WEB_BUNDLE_PUBKEY (or .keys/web-bundle-sign.pub) a build disables hot updates; never accept unsigned bundles.
- The API CORS defaults must keep greenhouse://localhost and http://greenhouse.localhost (DESKTOP_ORIGINS in apps/api/src/config/index.ts), or login spins forever.
- Every web bundle the shell may load must call desktop_mark_boot_ok after it renders (apps/web/src/lib/desktop), or the shell rolls it back on the next launch.

## Hot updates
- The main window loads greenhouse://localhost; keep the custom scheme so the origin, and the token in localStorage, survive hot updates.
- v2 shells read updates/desktop/v2/<channel>; updates/desktop/<channel> belongs to v1.3.x shells. Never publish a v2 bundle there.
- Web-bundle order is the commit count (scripts/desktop/web-bundle-version.mjs); CI computes it once and passes GREENHOUSE_WEB_BUNDLE_VERSION to every job.
- merge-app-release.mjs fails when a platform is missing; use --allow-missing only as an explicit single-platform emergency.
- desktop_prepare_shell_update downloads and never installs; only desktop_install_shell_update swaps the app, because installing replaces the bundle the running process still reads.
- desktop_download_shell_installer takes no URL: it reads downloads.json and accepts only the update source or allowed artifact origins and plain .dmg or -setup.exe names.
- Installer downloads use a read timeout, not a whole-request timeout, and report progress; real update sources are slow.
- Keep boot self-healing: bootPending is set only by the launch that selects a staged bundle, desktop_mark_boot_ok clears it, and a launch that still finds it set rolls back. Never set it in the download path.
- Cleaning old bundles must never remove the directory the running process serves from.
- Web bundles are signed with ed25519 (`node scripts/desktop/gen-web-bundle-key.mjs`, private key in the git-ignored apps/desktop/.keys/), shells with minisign (TAURI_SIGNING_PRIVATE_KEY in CI); rotating either key must ship with a new shell.
- Release pipeline and update layout: RELEASING.md (desktop-release.yml).

## Native capabilities and security
- Screenshot, selection and clipboard are client actions with safety 'confirm' (native-actions.test.ts).
- No tauri-plugin-fs scopes and no native read-file command; files enter through the webview's file input, paste or drop.
- The main window must call disable_drag_drop_handler() (lib.rs) or HTML5 drop never fires; verify by dropping a real file on a real build.
- Read selections through Accessibility only; never simulate Cmd+C on mouse release. Only a user-pressed shortcut may fall back to Cmd+C, and it restores the clipboard.
- Rust only forwards selection and coordinates; whether the selection bar shows and what it does lives in apps/web (lib/desktop/selection-policy.ts, pages/desktop/selection-bar.tsx).
- Accessibility and Screen Recording fail silently: ask AXIsProcessTrusted and CGPreflightScreenCaptureAccess, never infer from errors; capabilities.ts greys out what is missing.
- Windows has no selection read, global mouse listening or interactive region capture; report them unavailable.
- Write menu accelerators as CmdOrCtrl+= never Plus; muda cannot parse Plus, so the app fails to start, and cargo test does not catch it.
- Zoom stays native setZoom (apps/web/src/lib/desktop/zoom.ts); never Tauri zoomHotkeysEnabled, CSS zoom or a root font-size, which break 100vh, position:fixed and getBoundingClientRect.

## Packaging and diagnosis
- Transparent windows need macos-private-api (Cargo feature plus macOSPrivateApi); the Mac App Store is not a channel.
- DMG packaging drives Finder through AppleScript; AppleEvent timed out (-1712) means automation is not authorized, and the .app is fine.
- A browser-downloaded ad-hoc build is quarantined as damaged (`xattr -dr com.apple.quarantine`) and loses TCC grants on every update; only a Developer ID signature avoids both.
- Debug "enabled in System Settings but unauthorized" with `codesign -dv --verbose=4` and `codesign --verify --deep --strict` on the .app.
- Logs live in `~/Library/Logs/<bundle identifier>/Greenhouse.log`; web console errors arrive through apps/web/src/lib/desktop/logging.ts, whose re-entrancy guard is synchronous only, never held across an await.
- Icons come from `python3 scripts/build-brand-assets.py`; an icon change needs a new native build.

# Greenhouse macOS shell

The shell bundles `apps/client`'s universal web export. It supports the phone's multi-station contract. The browser export remains single-station. No server address is baked into a generic desktop build.

From the repository root, with Node/pnpm, Rust and Xcode command-line tools installed:

```sh
pnpm client:install
pnpm desktop:check
pnpm desktop:build
# For a human with a GUI; this rebuilds local assets then starts Tauri:
pnpm desktop:dev
```

The wrapper pins Tauri CLI 2.12.4, keeps its npm cache under `.cargo-home/npm`, exports Expo with `GREENHOUSE_DESKTOP=1`, and sets these for every Cargo command:

```sh
CARGO_HOME=$PWD/.cargo-home CARGO_TARGET_DIR=$PWD/apps/desktop/src-tauri/target cargo test --locked --manifest-path apps/desktop/src-tauri/Cargo.toml
```

`desktop:check` exports the real client, checks the native dependency graph, checks Rust formatting, runs Rust tests and JS bridge/pagination tests. `desktop:build` bundles the app with Tauri, then uses `hdiutil makehybrid -hfs` and `hdiutil convert -format UDZO` to create the DMG without a disk-device mount or Finder. It verifies the image checksum and includes an Applications link. It produces:

- `apps/desktop/src-tauri/target/release/bundle/macos/Greenhouse.app`
- `apps/desktop/src-tauri/target/release/bundle/dmg/Greenhouse_4.0.0-rc.1_aarch64.dmg` (version and architecture follow the build).

Local builds use ad-hoc signing (`-`) and no notarisation. The desktop script does not publish iOS/Android builds, change native Expo configuration, or run the application during check/build. Dev also loads bundled assets; restart it after changing the client.

Native behavior:

- Overlay title bar, traffic lights at (18,18), 760×560 minimum main window, remembered size/position, sidebar vibrancy exposed through transparent rail and secondary column. Settings has its own window.
- Menus consume the same shortcut JSON as the universal client. Go follows the current member's rail and plugin places. Closing the main window hides it; Dock reopen shows it again. Cmd+W dismisses an inspector first.
- Ctrl+Alt+Space opens a 560-pixel borderless Quick ask window. It creates an ordinary conversation, streams through the existing chat transport, shows four reply lines and offers Open in main window. Sign in and station management happen in the main window.
- The active station's authenticated WebSocket supplies For me notifications and unread badges. Rust suppresses system banners when the main window is focused. Reconnects back off and identity changes dispose old sockets.
- Tokens use the `credentials` Tauri plugin and macOS Keychain, scoped by station. Web Locks serialize rotating refresh tokens across windows; preferences and session changes are synchronized without storing tokens in localStorage.
- `greenhouse://chat?session=<id>`, `greenhouse://sheet/doc?id=<id>` and `greenhouse://sheet/task?id=<id>&project=<project-id>` open existing routes. Friendly aliases `conversations/<id>`, `documents/<id>` and `tasks/<id>?project=…` are accepted. Existing widget links (`knowledge/doc`, `projects/task`) retain their station guard.
- API calls send `X-Greenhouse-Client: desktop` to the selected station only, including retries.

## Backend integration required

The server allows exactly `tauri://localhost` by default and permits `X-Greenhouse-Client` in preflight headers. Its `desktop` value attributes counters and paid calls to the desktop app. `CORS_ALLOWED_ORIGINS` still adds deployment-specific origins. HTTP and WS calls use the selected station and its own bearer token.

Plugin embeds use `frame-ancestors 'self' tauri://localhost` without a conflicting X-Frame-Options header. The frame URL carries `host_origin=tauri://localhost`; the plugin helper must explicitly trust this origin. Its host obtains a ten-minute `/api/ext-ui/token` credential across the allowed desktop origin. Keep native Tauri capabilities restricted to bundled windows; remote plugin frames need none.

## Updater, signing and notarisation (release operator)

The old bundle id and public updater key are retained. No feed is checked unless `GREENHOUSE_UPDATER_ENDPOINT` is supplied at build time. A configured feed must use HTTPS and Tauri's signed `latest.json` format, for example a GitHub Release asset. The menu then exposes Check and install updates. Selecting it checks, verifies, installs and restarts; this phase never enables an automatic background install.

Build a signed update using the existing updater private key and Jim's Developer ID credentials (paths are examples; do not copy private keys into the worktree):

```sh
export GREENHOUSE_UPDATER_ENDPOINT='https://github.com/linjiejim/greenhouse/releases/latest/download/latest.json'
export TAURI_SIGNING_PRIVATE_KEY="$(cat /absolute/private/path/updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD='' # use the actual key password if set
export GREENHOUSE_DESKTOP_SIGNING_IDENTITY='Developer ID Application: YOUR NAME (3SKAS5BNK9)'
export APPLE_ID='your-apple-id@example.com'
export APPLE_PASSWORD='your-app-specific-password'
export APPLE_TEAM_ID='3SKAS5BNK9'
pnpm desktop:build
```

Tauri uses the Developer ID and Apple variables to sign/notarize the app and create the updater archive/signature. The wrapper signs the final DMG when an identity is provided. Submit and staple that DMG explicitly with notarytool (omit APPLE_ID/APPLE_PASSWORD during the build if doing all notarisation manually):

```sh
xcrun notarytool store-credentials greenhouse --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_PASSWORD"
xcrun notarytool submit apps/desktop/src-tauri/target/release/bundle/dmg/Greenhouse_4.0.0-rc.1_aarch64.dmg --keychain-profile greenhouse --wait
xcrun stapler staple apps/desktop/src-tauri/target/release/bundle/dmg/Greenhouse_4.0.0-rc.1_aarch64.dmg
codesign --verify --deep --strict apps/desktop/src-tauri/target/release/bundle/macos/Greenhouse.app
spctl --assess --type execute --verbose apps/desktop/src-tauri/target/release/bundle/macos/Greenhouse.app
```

Upload the updater `.app.tar.gz`, its `.sig`, and a `latest.json` containing this build's version, per-platform HTTPS URL and the exact signature. Never rotate the public key for the old installed base. Resuming updates from retired 2.2.x feeds requires the release operator to publish a final compatible feed at the old location; this lane does not publish it.

## Human acceptance

The restricted runner builds without launching. On a Mac, verify: titlebar drag/traffic lights; light/dark vibrancy; resize/move/relaunch; every menu shortcut and role-gated Go place; multi-station sign-in/switch/sign-out in all windows; inactive-window notification and Dock unread count; global hotkey/Quick ask streaming/main-window handoff; cold/warm deep links; Keychain denial/retry; a signed test feed upgrading the previous installed version. The shared browser client is covered separately by `pnpm test:e2e:client`.

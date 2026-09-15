# Desktop (Tauri shell)

`@greenhouse/desktop` wraps `apps/web` into a macOS / Windows application and adds the native
context capture a browser cannot offer (screenshots, text selection, clipboard, global
shortcuts, a tray menu). It is the same product as the web app, delivered two ways.

## The one rule that matters

**Features are written in `apps/web`, not here.**

This crate only grows when a new *native* capability is needed. Web changes reach installed
apps as a signed hot update (a sub-megabyte tarball, applied on the next launch); shell
changes need a new application build (tens of MB, installed by the updater or by hand). So:

- A new page, a new interaction, a changed shortcut behaviour, a restyled floating bar → `apps/web`.
- A system call the browser cannot make → one named `#[tauri::command]` here, mirrored in
  `apps/web/src/lib/desktop/types.ts`. **The two must change together**; `ActiveBundle`'s
  wire shape is pinned by `bundle::tests::active_bundle_serializes_to_the_shape_typescript_expects`.

The satellite windows (quick capture, the selection bar) are web routes (`#/desktop/*`) and
hot-update like everything else. The tray menu follows the same split: the web layer
assembles a `TrayMenuModel` and pushes it with `desktop_set_tray_menu`; `tray.rs` only
renders it, and clicks come back as typed `TrayAction` events. Before the first push the
menu is a built-in Open/Quit — the tray is the escape hatch and never depends on the webview
being alive. The main window likewise: macOS keeps the traffic lights via
`TitleBarStyle::Overlay`; the real top bar and its drag region live in `apps/web`. Do not
move product settings UI into Rust.

## Development

```bash
pnpm desktop:dev                 # web (:3100) + Tauri window, HMR as in the browser
pnpm desktop:build               # .app / .dmg / nsis (runs `pnpm web:build` first)
pnpm desktop:check               # cargo fmt --check, clippy -D warnings, node + cargo tests
pnpm desktop:verify-web-update   # isolated data dir, beta v(N-1) → v(N), three launches (macOS)
```

`desktop:dev` does **not** start a local API. The window is injected with the API base like
a packaged build (default `http://localhost:3000`, so `pnpm dev` alongside is enough) and
talks to it directly, not through the Vite proxy.

**The Rust target dir is shared across worktrees** at `~/.cargo-target/greenhouse-desktop`:
dev/build/tauri/clippy/test all go through `scripts/with-shared-target.mjs`, which injects
`CARGO_TARGET_DIR` so the machine keeps one incremental cache (a single one is 4–6 GB). CI is
not redirected (`CI` set → no injection) and an explicit `CARGO_TARGET_DIR` wins. A bare
`cargo run/build` bypasses the wrapper and grows an in-tree `src-tauri/target/` — local
garbage, safe to delete.

The same wrapper keeps **local macOS bundles properly signed**: without a Developer ID it
injects `APPLE_SIGNING_IDENTITY=-` so Tauri ad-hoc signs the whole `.app` rather than leaving
only Cargo's Mach-O linker signature — an unsealed bundle can show Accessibility as enabled in
System Settings while `AXIsProcessTrusted` still returns false. Without
`TAURI_SIGNING_PRIVATE_KEY` a local build also turns updater artifacts off and only produces
an installable `.app`/`.dmg`.

**`tauri::is_dev()` tracks the `custom-protocol` cargo feature, not the build profile.** A
bare `cargo run` is a "dev" build that expects Vite on :3100 (the webview appears to die if
Vite is not running). To exercise the packaged path — custom scheme, embedded assets —
without a full bundle:

```bash
cargo run --features tauri/custom-protocol --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Deployment configuration — environment, never edits

The committed `tauri.conf.json` is deployment-neutral: the open-source identity
(`com.linjiejim.greenhouse`), no baked-in server, no update feed, a CSP that only knows the
local dev servers. A deployment that builds its own shell — the public release pipeline, a
company's private fork — sets these at **build time** (`apps/desktop/scripts/tauri-config.mjs`
turns them into the `--config` overlay the wrapper appends; `build.rs` bakes the URL ones into
the binary):

| Variable | Baked where | Effect |
|---|---|---|
| `GREENHOUSE_DESKTOP_API_BASE` | binary (`settings.rs`) + CSP | The server every install talks to. **Set → the server is fixed, no setting, no first-run prompt** (`api_base_locked()`); a shipped internal app pointing somewhere unexpected is a support problem. Unset → the server is a setting in every build, default `http://localhost:3000`. |
| `GREENHOUSE_DESKTOP_UPDATE_BASE` | binary + CSP | Where manifests live: `<base>/<channel>/web/manifest.json`, `<base>/<channel>/app/{latest,downloads}.json`. Unset → `<API base>/updates/desktop`, i.e. the API server hosts them. |
| `GREENHOUSE_DESKTOP_ARTIFACT_ORIGINS` | binary | Comma-separated extra URL prefixes an installer may be downloaded from (a GitHub Release host, object storage). The update source itself is always allowed; anything else in a release index is treated as tampering. |
| `GREENHOUSE_DESKTOP_IDENTIFIER` | tauri.conf | Bundle identifier = app-data dir + macOS permission identity. **An installed base must keep its own** or every user re-grants permissions and loses staged updates. |
| `GREENHOUSE_DESKTOP_PRODUCT_NAME` | tauri.conf | Window / bundle name (default `Greenhouse`). |
| `GREENHOUSE_DESKTOP_UPDATER_PUBKEY` | tauri.conf | minisign public key matching `TAURI_SIGNING_PRIVATE_KEY`; without it the shell cannot verify shell updates. |
| `GREENHOUSE_DESKTOP_CSP_EXTRA_ORIGINS` | CSP | Extra origins for `connect/img/media-src` (an object-storage CDN, an avatar service). |
| `GREENHOUSE_WEB_BUNDLE_PUBKEY` | binary (`build.rs`) | ed25519 public key for web-bundle hot updates (falls back to `.keys/web-bundle-sign.pub`). **Absent → hot updates are disabled in that build** (fail closed, never unsigned). |
| `GREENHOUSE_WEB_BUNDLE_VERSION` | binary (`build.rs`) | The bundle version stamped as this build's baseline. Default: the checkout's commit count. |

`build.rs` rejects a malformed `GREENHOUSE_DESKTOP_API_BASE` (it must be a bare origin) at
build time; `settings::normalize_api_base` enforces the same shape on user input.

## Assets and hot updates

The main window loads `greenhouse://localhost/index.html`. `protocol.rs` decides what is
served, `assets.rs` where it comes from: staged bundle → built-in baseline → `index.html`
(SPA fallback). A custom scheme rather than `file://` keeps the origin constant, so the token
in localStorage survives a hot update and nobody is logged out.

### One product version, two technical lines

| Purpose | Field | Rule |
|---|---|---|
| Version users see | root `package.json#version` | Shared by web and shell; the Tauri config reads the root file |
| Web-bundle ordering | `git rev-list --count HEAD` (`scripts/desktop/web-bundle-version.mjs`) | Monotonic per branch; CI computes it once and passes `GREENHOUSE_WEB_BUNDLE_VERSION` to every job so they agree |
| Native compatibility | `apps/desktop/package.json#nativeApiVersion` | Bumped only when the command surface changes; a web bundle's `minShellVersion` defaults to it |

Old shells skip a bundle whose `minShellVersion` they do not meet instead of going blank,
and pick up the shell update from `latest.json` instead. Never use the product version for
compatibility — every routine release would force a reinstall.

### The update layout (what a client trusts)

```
<update base>/<channel>/web/manifest.json     webBundleVersion, minShellVersion, url, sha256, sig
<update base>/<channel>/app/latest.json       tauri-plugin-updater feed (all platforms)
<update base>/<channel>/app/downloads.json    installer index for the settings download card
```

`url` fields may be relative (served beside the manifest) or absolute (a release host).
Channels are `stable` and `beta`; a tester opts into beta at launch with
`GREENHOUSE_UPDATE_CHANNEL=beta`, no separate build. The open-source pipeline
(`.github/workflows/desktop-release.yml`, see `RELEASING.md`) parks the big files on the
GitHub Release and publishes the three manifests to the project site; a self-hosted
deployment serves everything from its own origin. The scripts are shared:
`make-web-bundle.mjs` (sign the web bundle), `make-app-release.mjs` (collect one platform's
shell artifacts into a fragment) + `merge-app-release.mjs` (assemble the manifests from every
fragment — a missing platform fails the merge, because a half-populated manifest lies to the
missing platform; `--allow-missing` is the explicit single-platform emergency hatch).

### Who checks, and when

`apps/web/src/lib/desktop/updates.ts` (`startUpdateChecks()`, called by `initDesktop()`):
20 s after launch, then every 4 h, both lines — the web bundle first (frequent, seconds),
then the shell (rare, minutes). Downloads are silent; a finished one shows as one line above
the user block in the sidebar ("restart to update"). Settings and the user menu both offer a
manual check; the user menu also opens the release notes.

Shell updates run on the same cadence: `desktop_prepare_shell_update` checks and downloads,
**but does not install** — the payload stays in memory (`PREPARED_SHELL_UPDATE`, ~8 MB) until
`desktop_install_shell_update` swaps the `.app` and restarts. Installing replaces the bundle
under the running process while `assets.rs` may still read baseline assets from it; keeping
the payload in memory is what closes that window. When both lines are ready only the shell
card shows: one restart applies both. `desktop_install_shell_update` keeps a
check+download+install fallback for a click that beats the background pass. minisign
verification happens inside the updater plugin on both paths, and a failed install leaves the
old shell intact.

The second route to a shell update is **Settings → Desktop → App & updates**: when
`downloads.json` lists a newer version, "download installer" (`desktop_download_shell_installer`)
saves this platform's installer to Downloads and reveals it. **The command takes no URL**: it
reads the same `downloads.json`, accepts only URLs under the update source or an allowed
artifact origin, derives the file name from the URL and refuses anything that is not a plain
`.dmg` / `-setup.exe` name — a named capability, not a "download any URL to any path" hatch.
It writes `.partial` first and deletes it on a size mismatch. The dmg is not verified here; it
is notarized and Gatekeeper checks it.

**Measured against a real update source this is slow** (7.6 MB in 5 min 47 s, ~22 KB/s), so the
HTTP client uses a *read* timeout (60 s without bytes = stalled), not a whole-request one, and
progress is emitted at ~1 % steps (`desktop://installer-progress`) — a spinner for six minutes
reads as broken.

### Boot self-healing (do not remove)

A signature proves the bundle is ours, not that it runs. A downloaded bundle is staged with
`bootPending=false`; the next launch selects it and sets `bootPending=true` *before* opening
the window; the web layer clears it with `desktop_mark_boot_ok` once mounted. If a launch
finds it still `true`, the previous launch failed: roll back to the baseline and drop the
pointer. Never set it `true` in the download process — the first real attempt would be
misjudged as a failure. Cleaning old bundles must protect the directory the running process
reads from.

### Signing keys

- **Web bundle**: ed25519. Public key baked in by `build.rs` from `GREENHOUSE_WEB_BUNDLE_PUBKEY`
  or `.keys/web-bundle-sign.pub`; private key `.keys/web-bundle-sign.pem` (git-ignored).
  Generate with `node scripts/desktop/gen-web-bundle-key.mjs`.
- **Shell**: minisign, `tauri signer generate`; private key in CI (`TAURI_SIGNING_PRIVATE_KEY`),
  public key via `GREENHOUSE_DESKTOP_UPDATER_PUBKEY`.
- Rotating either key invalidates every published manifest for installed shells, so a
  rotation must ship together with a new shell.

## Native capabilities

Commands live in `src/commands/`, platform code in `src/native/`. **There is no "run an
arbitrary command / read an arbitrary path" hatch**; adding a capability means adding one
named command. Global shortcuts: Rust registers and emits `desktop://shortcut`; what happens
(show main window, quick capture, screenshot, selection) is `apps/web/src/lib/desktop/shortcuts.ts`.
Page zoom (⌘+/⌘-/⌘0): the shell only grants `core:webview:allow-set-webview-zoom` and, on macOS,
a `View ▸ Zoom` menu emitting `desktop://zoom`; steps, keyboard fallback and persistence are
`apps/web/src/lib/desktop/zoom.ts`. Three things not to change there: do not switch to Tauri's
`zoomHotkeysEnabled` (its level lives in an injected script and resets on every reload, and on
Windows it is a different WebView2 switch); write menu accelerators as `CmdOrCtrl+=` never
`Plus` (muda cannot parse `+`, `app_menu::install` fails and the app does not start — cargo
test cannot catch it); do not replace native `setZoom` with CSS `zoom` / root `font-size` (they
skew `100vh`, `position:fixed` and `getBoundingClientRect`, which sticky headers, split panes
and drag sensors rely on).

The resident selection watcher only forwards selection + coordinates; whether the bar shows,
when it is suppressed and what its buttons do is `selection-policy.ts` /
`pages/desktop/selection-bar.tsx`. Rust keeps cross-app listening, the always-on-top window,
screen work-area positioning and three named window states (launcher / profiles: unfocusable;
composer: focusable). The menubar icon is `icons/menubar-template.png`, a template icon so
macOS inverts it with the menu bar.

### Security posture

- Screenshot / selection / clipboard are registered as agent client actions with
  `safety: 'confirm'` (`native-actions.test.ts` pins it).
- File access does **not** open `tauri-plugin-fs` scopes and there is no native read-file
  command: files enter the composer through the webview's own `<input type="file">`, paste or
  drag, exactly as in the browser.
- **The main window must `disable_drag_drop_handler()`** (`lib.rs`). Tauri's handler is on by
  default and returns `true` unconditionally, so wry marks the drop consumed and HTML5
  `ondrop` never fires — on both platforms. It *looks* fine (the cursor shows the drop
  affordance) until nothing happens. Synthetic drag events cannot verify this; drag a real
  file onto the composer on a real build.
- The selection watcher reads through Accessibility only — never a simulated ⌘C on every mouse
  release. Only a user-pressed shortcut may fall back to ⌘C, restoring the clipboard after.

### macOS permissions

Accessibility (selection, global listening) and Screen Recording (screenshots) **fail
silently**: without the grant the event tap is created but delivers nothing and screenshots
return the wallpaper. Availability must be asked (`AXIsProcessTrusted`,
`CGPreflightScreenCaptureAccess`), never inferred from errors; `capabilities.ts` greys out and
explains. Debugging "enabled in System Settings, still unauthorized": `codesign -dv --verbose=4`
and `codesign --verify --deep --strict` on the `.app` — the identifier must match the build's
and the sealed resources must verify. After installing a differently-signed local build, macOS
may need the old permission entry removed and re-added.

### Platform differences (documented honestly)

| Capability | macOS | Windows |
|---|---|---|
| Screenshot full / window | `screencapture` ✅ | `xcap` ✅ |
| Interactive region capture | ✅ | ❌ full screen + web-side crop |
| Selection read | `AXSelectedText` ✅ | ❌ not implemented (UI Automation TODO) |
| Global mouse listening | CGEventTap ✅ | ❌ not implemented (`WH_MOUSE_LL` TODO) |
| Global shortcuts / clipboard / tray | ✅ | ✅ |
| Drag files into the composer | ✅ | ✅ |

## Diagnosing a user's problem

Logs: `~/Library/Logs/<bundle identifier>/Greenhouse.log` (macOS). Release builds have no
devtools, so the webview's `console.warn` / `console.error`, uncaught errors and unhandled
rejections are forwarded into that file (`apps/web/src/lib/desktop/logging.ts` →
`desktop_log`, prefixed `[web]`). Forwarding is re-entrancy guarded only synchronously, never
across an await: errors come in bursts (an error and its rejection, React logging twice) and
dropping the second one would make the log describe the wrong problem. `tao`/`wry`/`reqwest`
are capped at warn, so a launch is a dozen useful lines rather than hundreds of resize events.

## Known pitfalls

- **DMG packaging depends on Finder automation** (`bundle_dmg.sh` arranges icons via
  AppleScript); an unauthorized environment fails with `AppleEvent timed out (-1712)`. The
  `.app` is unaffected.
- **Gatekeeper**: an ad-hoc signed build runs on the machine that built it; on another
  machine it is reported as damaged (`xattr -dr com.apple.quarantine` is the only way past).
  Distribute Developer-ID-signed and notarized builds only.
- **`target/` must stay out of eslint/prettier**: `tauri-codegen` writes embedded web output
  back as `.js`; the root `eslint.config.js` and `.prettierignore` exclude `**/target/`.
- **Transparent windows need `macos-private-api`** (Cargo feature + `macOSPrivateApi` in the
  config); it rules out the Mac App Store, which is not a distribution channel here.
- **The API's CORS allow-list must include the desktop origins** (`greenhouse://localhost`,
  `http://greenhouse.localhost` — `DEFAULT_CORS_ORIGINS` in `apps/api/src/security/security.ts`),
  or the app loads but every request fails preflight and login spins forever.

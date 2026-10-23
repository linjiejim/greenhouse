# apps/mobile: the team-hub app (Expo SDK 57; iOS system UI first, Material 3 on Android)

## Scope

- The app is the team's Agent hub on the phone: Home (notifications), Knowledge, Files, Projects, Tables, Settings, and later what my agents wrote and a light assistant chat. It is not a web wrapper and not an agent console.
- Places not on the phone yet are listed in src/shell/modules.ts with `ready: false` and open app/module/[id].tsx ("Coming soon"); give a place its own route when it lands and drop it from the placeholder (Knowledge and Files have theirs).
- Experience bar: content within 1.5 s of a cold start (cache first, refresh in background), 60 fps lists, haptics and optimistic updates, offline reading of recent items, dark mode, Dynamic Type, VoiceOver.

## Install and tests

- apps/mobile is outside the pnpm workspace with its own lockfile: install with `pnpm mobile:install`, and run `pnpm typecheck` and `pnpm lint` inside apps/mobile, because root checks skip it.
- Never run `npx expo install`; it writes apps/mobile into the root pnpm-lock.yaml. Pin versions by hand (SDK 57 packages are ~57.x), then run `pnpm mobile:install`.
- apps/mobile/pnpm-workspace.yaml is the isolation barrier; pnpm 11 ignores .npmrc, so never put pnpm settings there.
- If packages get relinked into the root store (metro.config.js blocks it: red screen "Unable to resolve" or a native "version mismatch"), delete node_modules, run `pnpm mobile:install`, then `expo start --clear`.
- Never add `@react-navigation/*` (expo-router vendors it; import from `expo-router/react-navigation`); keep react-native-drawer-layout and babel-preset-expo as direct dependencies.
- Never import `@greenhouse/*` packages. Files headed VENDORED are verbatim copies (src/shared/push.ts ← packages/types/src/push.ts); re-copy instead of editing. src/shared/greenhouse-types.ts is the hand-kept subset of v1 server shapes; declarations marked verbatim are checked by src/shared/vendor.parity.test.ts.
- The root vitest runs mobile tests without a mobile install: tests must not import react, react-native or `expo-*`, even transitively (mock them, as src/startup/startup.test.ts does); keep logic in React-free modules (src/data, src/push/model.ts, src/api/compat.ts).
- Tests and the modules they import sit in folders with a stub tsconfig.json (copy src/api/tsconfig.json), or CI fails with TSConfckParseError.

## Server contract (v1 API)

- Sign-in: `POST /api/auth/login` → `{ accessToken, refreshToken, user }`; refresh: `POST /api/auth/refresh` with `{ refreshToken }` (single use, one refresh at a time per station); member: `GET /api/auth/me` → `{ user }`; language: `PUT /api/auth/me/preferences`. There is no logout endpoint: sign-out forgets the pair.
- Errors are `{ error: '<words>' }`; src/api/client.ts maps the status to a stable `code` and keeps the words as `message`.
- `/api/bootstrap` (public) gives branding and `mobile_api`. `MOBILE_API` (src/api/compat.ts) is the level this build needs; a server below it shows the mismatch screen ("needs an update"), a v2 server (`api_version`) is unsupported. Raise `MOBILE_API` together with the server's `MOBILE_API_LEVEL` when the app starts calling a new endpoint.
- Notifications: `GET /api/notifications` (cursor pages), `/summary`, `POST /:id/read` (answers with the notification; it is also how a notification missing from the list is fetched), `POST /read-all`.
- Push devices: `/api/auth/me/push-devices` (src/api/push.ts).
- Knowledge: `/api/knowledge/docs?visibility=`, `/docs/id/:id`, `/search`, `/docs/:id/comments`; folders are drive folders of scope `kb` (`/api/drive/folders?scope=kb&visibility=&parent_id=all`). The server caps a docs page at 100.
- Files: `/api/drive` scope `kb` (team = `visibility=team`, mine = `private`): folders, files, search, breadcrumb, `files/:id/content` (authenticated; 302 to a signed URL on COS), and upload init → bytes (presigned PUT, or PUT to the API in proxy mode) → complete.
- Feishu sign-in: `/api/feishu/login-available`, then `start-login?app_redirect=greenhouse://auth/feishu` (the server allow-lists exactly that address) in the system auth session, then `/api/feishu/oauth/exchange`. Keep `FEISHU_APP_REDIRECT` (src/login/feishu.ts) equal to the server's `APP_LOGIN_REDIRECT`; a test compares them.
- API reads and writes answer an `ApiResult` and never throw; resolve the base with getApiBase() at call time; api() sends tokens only to the active station's origin; switch stations only with useAuth.switchStation.

## Data

- Cache first: useAuth opens on the member cached for the station (loading drops before the network answers) and revalidates; a refused session signs out when it comes back; offline the cached member stays.
- Per-member offline copies live in the documents directory (src/data/disk-cache.ts, one JSON per station + member + kind). Sign-out, a server-ended session and removing a station delete them.
- Stores that hold member data reset on any station or member change (module-scope subscriptions, see src/store/notifications.ts) and drop late answers with captureIdentity().
- Read marks and similar writes are optimistic and roll back on failure, with alertError for the failure.
- Hermes rejects Postgres timestamps; parse them with parseMs() (src/data/time.ts).
- Opened knowledge documents keep a saved copy and the recently opened list per station + member (src/store/knowledge.ts, rules in src/data/recent-docs.ts). A 403 / 404 deletes the copy and stops showing it; only an unreachable station (no answer, 502/503/504) falls back to it (`docMiss`).
- The top of a knowledge shelf lists the recently opened documents even when the shelf fails, so they open offline on a cold launch (src/data/kb-rows.ts).
- Offset-paginated lists are read to the end with collectPages() (src/data/paging.ts), bound to the identity they started on; never stop at the first page.
- Every multi-step write (a Files upload: init, bytes, complete, later batch items) checks the identity captured before its first step and stops on a change (src/api/drive.ts).
- Links go through src/lib/deep-links.ts (pure) and src/shell/open-target.ts: document and file routes open natively, other station pages in the in-app Safari view at the active station, other sites in Safari. A notification opens the document or file it names, else its page, which offers the web page (src/shell/open-notification.ts).

## Push

- The server pushes every notification-center fact through the Expo Push Service; the phone's switches (needs you / done / other / preview) only narrow it. Pushes carry ids only (`PushData`: station ref, member, category, notification id, `/notification?id=`); previews (the notification title) are off by default.
- Registration (src/push/register.ts) runs after sign-in, on foreground and on a new Expo token, per station; it never prompts. The soft ask (src/push/soft-ask.ts) comes once notifications are on screen, at most every 14 days; only "allow" raises the system prompt.
- A tap opens /notification on the station that sent it (switching first); a push for another member or a removed station only opens the app (src/push/model.ts, pure and tested).
- Never commit development: true in getExpoPushTokenAsync; simulator push payloads put PushData under the top-level body key.

## Share extension

- targets/share ("存到 Greenhouse", @bacons/apple-targets type `share`, SwiftUI) uploads shared photos, videos and files into Files on the active station: shelf and folder picker, then init → bytes → complete.
- It reads only the station and a short-lived access token from the App Group keychain item `greenhouse.share.session` (src/share/session.ts writes it on every token change; src/share/payload.ts is the shape). Never put the refresh token there: a single-use refresh in the extension would sign the app out. An expired token tells the member to open the app.
- Keep the keychain key, service and App Group in payload.ts and ShareModel.swift identical; the extension's Info.plist activation rule caps what it accepts.
- The session carries the app's language; the extension speaks it (else the phone's) and uses the V1 green from ShareLogic.swift `Brand`, kept equal to src/theme/palette.ts.
- Logic the extension needs goes in Foundation-only targets/share/ShareLogic.swift; src/share/share-logic.test.ts compiles it with src/share/ShareLogicCheck.swift and runs the checks (skipped without swiftc). A retry uploads only the attachments not saved yet.
- The camera captures photos only: the app has no microphone permission (src/files/picker-options.ts).

## Native builds and release

- **Do not publish before the 3.0 release**: no `eas build`, `eas update` or `eas submit` from this line, and never point .github/workflows/mobile.yml at `v1`. The EAS project, bundle id and update URL are shared with the store app that ships from v2. See RELEASING.md.
- ios/ and android/ are generated by `pnpm mobile:prebuild` and git-ignored; rerun it after changing app.json, plugins or entitlements, then restore sdk.dir (or ANDROID_HOME), since --clean deletes android/local.properties.
- If prebuild cannot find CocoaPods, run pod install in ios/ yourself with Homebrew's pod and GEM_HOME/GEM_PATH unset; confirm "Building from source: false" (a silent fallback to building React Native from source crashes at launch on React.framework).
- After pod install, stale .last_build_configuration flavor markers cause Debug link errors or a launch SIGSEGV in Props::Props(); write the opposite configuration into the markers so the next build re-extracts.
- Expo Go cannot run the app; use a dev client (`pnpm mobile:ios`, `pnpm mobile:android`) on a dedicated simulator and judge UI there, never on Expo web.
- Releases follow the native fingerprint (`runtimeVersion.policy: fingerprint`): JS-only changes ship as OTA; native changes (new native modules, ICONS entries, app icon, fonts, entitlements, app.json) need a build.
- Never hand-edit the version in app.json or package.json; release-please bumps it and fingerprint.config.js keeps it out of the fingerprint.
- The app icon (assets/icon.png, adaptive-icon.png) is rendered from logos/greenhouse-mark.svg's paths on V1 green with rsvg-convert; regenerate both together.
- iOS status bars are owned by native controllers (`UIViewControllerBasedStatusBarAppearance=true`); all stacks pass the app theme to stackDefaults. Expo StatusBar is Android-only.

## UI

- Use system components: the expo-router native Stack, @expo/ui/swift-ui and NativeMenu (src/ui/menu.tsx); never JS-drawn headers, bottom sheets, action sheets, calendars or switches.
- Brand: V1 green (#2E8B3D, src/theme/palette.ts from apps/web/src/app.css) and Nunito; dark content surfaces mirror UIKit's; native controls keep system styling with the accent as tint. Palette contrast is tested (src/theme/palette.test.ts).
- `colors.*` are opaque ColorValues: never concatenate or compute alpha on them; use `hex.*` for strings and alpha() for transparency.
- Text and icons on the accent use onAccent, on other solid fills onTint; no hex literals except data colors.
- Take typo, weight, radius (with squircle) and HIT from src/theme.ts; never disable allowFontScaling.
- Register icons as [SF Symbol, Material] pairs in ICONS (src/ui/core.tsx) and run `python3 scripts/android-icons.py` in apps/mobile; toolbar icons go through toolbarIcon().
- Give every icon-only button an accessibilityLabel; Icon is hidden from VoiceOver unless it stands alone.
- Declare presentation only in app/_layout.tsx with the src/ui/nav.ts presets; screens set their own title and toolbar; the back button is always the system's.
- Glass (src/ui/glass.tsx) is for the control layer only; content sits on solid system colors.
- A failed user action shows alertError; toast is for success only; a failed load shows EmptyState with retry; login errors stay inline.
- Forms use NativeForm with FormNavRow; content buttons use NativeButton, never Pressable plus Text.
- Every SwiftUI Host you create gets the useLocaleEnv() modifier, and inline hosts in RN content get ignoreSafeArea="all".
- Lists use src/ui/list.tsx; virtualized rows pass position instead of sitting in ListSection; show LoadingState and EmptyState.
- Use react-native-keyboard-controller; never KeyboardAvoidingView.

## Native pitfalls

- RN overlays render below native sheets: UI that must cover them (toast) uses FullWindowOverlay, mounted only while shown.
- The root Stack starts at (drawer) (home): go home with router.dismissTo('/') (src/shell/nav.ts), never `<Redirect>` or router.replace.
- Mount a SwiftUI Form on the first frame and swap its children when data arrives, or its first untitled Section slides under the nav bar.
- Never remove a Form section while one of its inputs has focus (UIKit crash); call Keyboard.dismiss() in beforeRemove.
- Changing the system font size at runtime does not relayout (RN 0.86 bug): key stateless text containers with useFontScaleKey(), never screens, lists, navigators or forms.
- Only the root layout's auth gate navigates on sign-in and sign-out (routes reachable signed out go in SIGNED_OUT_ROUTES); startup readiness may hold the splash but never block route mounting.

## Android

- Rendering @expo/ui/swift-ui crashes on Android: every module that renders it needs a `*.android.tsx` sibling with the same extension as its base file, with behavior in a shared hook.
- Android files import platform siblings with the explicit .android suffix; restart Metro after adding a platform file.
- Compose islands use M3Host (src/ui/m3.tsx), never a bare Host; never wrap list rows in Compose hosts.
- Offset content with useHeaderInset(), never useHeaderHeight().
- Android gets an Expo push token only once the build has Firebase credentials (google-services.json); until then registration fails quietly.

## i18n

- en.ts is the key source and zh must match; delete unused keys after searching dynamic uses (`t(module.title)`, notification kind labels).
- Words follow the web: 动态 (Home), 知识库, 档案库, 项目, 表格, 通知, 工作站.

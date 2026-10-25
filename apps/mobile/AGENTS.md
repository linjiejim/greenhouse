# apps/mobile: the team-hub app (Expo SDK 57; iOS system UI first, Material 3 on Android)

## Scope

- The app is the team's Agent hub on the phone: 首页 (greeting, recent conversations, a composer; search and the bell in its bar), 知识库, 云盘 (with Tables), 项目, search, the conversation page, 通知 and 「我」 (account, station, text size, My Agents, settings). It is not a web wrapper and not an agent console.
- The root is NativeTabs (app/(tabs)/_layout.tsx); Tables is a segment of 云盘 only with the `tables` feature (src/shell/modules.ts `hasTables`, supers always). There are no placeholder screens.
- Page, sheet, type, color and state rules live in DESIGN.md; read it before adding a screen.
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
- Projects: `/api/projects` (offset pages; `POST` `{ title }` makes one), `/:id` (project with its task tree, members, stats), `/gantt` (every readable project with its tasks; the source of "my tasks": open tasks assigned to me, src/data/tasks.ts), `PATCH /tasks/:id` (status changes are optimistic, one save in flight, the last choice sent last, every save bound to the identity that chose, src/data/latest-choice.ts), `/tasks/:id/comments`. There is no task by id; read it from its project's tree. `tags` may be a JSON string.
- Tables (feature `tables`): `/api/tables/bases` (`POST` `{ name }` makes a private base with one table), `/bases/:id` (tables and my role), `/tables/:id/schema`, `POST /tables/:id/records/query` (cursor pages), `/records/:id`, `POST /records` with `{ values }` keyed by field id. Only text, number, date, single select and boolean are written from the phone (src/data/table-fields.ts); editors and up may add. Select values are option ids; formula and rollup results are in `computed_values`.
- My Agents: `/api/agent-access/writes` (mine, newest 50; a write's detail comes from that list), `/api/usage/spend` (my month, USD micros, src/data/money.ts), `/api/agent-access/gateway` (my keys, never a secret; created on the web).
- Assistant: `/api/sessions` (mine, `page_meta` pages of 50; `pinned`/`pin_sort`; `last_message`, absent on older stations; `POST`/`DELETE /:id/pin`; `PATCH /:id` `{ title }`; `DELETE /:id`, 409 while a reply is written), `/api/sessions/:id/messages` (latest page first, `before_seq` for older; `pipeline`, `images`, `references_` are JSON text, src/chat/parts.ts), `POST /api/chat` and `GET /api/chat/runs/:id/stream` stream NDJSON (src/data/chat-stream.ts) through Expo's fetch (`api(path, init, via)`), `POST /api/chat/runs/:id/stop`; Regenerate posts `regenerate_assistant_message_id` (latest reply only, else 409). src/data/conversation.ts owns the rules: the latest page replaces its range and keeps older history, keep the live exchange until the saved transcript holds a new reply id, follow a reply in progress on open and refocus, give the draft back on any refused send, report an unreachable station as `offline` (the outbox queues it).
- Every chat turn sends `rich_blocks` (src/markdown/rich.ts `MOBILE_RICH_BLOCKS`); rendering never depends on the station reading it.
- Chat files: pictures `POST /api/upload` (multipart `file`, ≤ 5 MB, scaled to 1600 px JPEG first) ride as `messages[].images`; other files `POST /api/chat-files/upload` (`file` + `session_id`) ride as an ```attachments fence (src/api/chat-files.ts). Multipart goes through Expo's fetch with an expo-file-system File.
- Card actions: task capture `POST /api/prompts`, table plans `POST /api/tables/schema-plan/apply`, both with the action id `artifact:<message>:<step>:<tool>`; receipts `GET /api/artifact-actions/:id` (src/api/artifacts.ts). An ask_user answer is a normal message in the web's English words (src/chat/parts.ts `askUserAnswer`); my bubble renders inline Markdown, as the web's does.
- Link titles: `POST /api/refs/resolve` `{ urls }` → `{ items: [{ url, type, id, title|null, meta? }] }` (src/store/refs.ts); a 404 means the station predates it and chips keep the link's words.
- Text size: `GET`/`PATCH /api/me/preferences` `{ fontScale }` (src/settings/text-size.ts); a 404 keeps it on the phone. Older stations refuse 0.8 and 0.85 (400): the phone keeps them.
- Feedback: `POST /api/me/feedback` `{ message, context }` (src/feedback); a 404 says the station is too old.
- Search: `GET /api/search?q=&kind=` (conversations, projects, documents) and `/api/drive/search`; my tasks are matched from the saved copy. Runs: `GET /api/runtime/runs/:id`. My agents: `/api/agent-access/connections`.
- Folders and files: `POST /api/drive/folders`, `PUT /folders/:id` `{ name?, parent_id? }`, `DELETE /folders/:id` (409 when not empty), `PUT /files/:id` `{ name?, folder_id? }`, `DELETE /files/:id`; documents `POST /api/knowledge/docs`, `PUT /docs/:id` `{ title?, folder_id? }`. Moves never cross shelves.
- Access: a 403 means a role, feature or capability gate (EmptyState without retry); a 404 means gone or not visible to this member (src/data/access.ts).
- Feishu sign-in: `/api/feishu/login-available`, then `start-login?app_redirect=greenhouse://auth/feishu` (the server allow-lists exactly that address) in the system auth session, then `/api/feishu/oauth/exchange`. Keep `FEISHU_APP_REDIRECT` (src/login/feishu.ts) equal to the server's `APP_LOGIN_REDIRECT`; a test compares them.
- API reads and writes answer an `ApiResult` and never throw; resolve the base with getApiBase() at call time; api() sends tokens only to the active station's origin; switch stations only with useAuth.switchStation.

## Data

- Cache first: useAuth opens on the member cached for the station (loading drops before the network answers) and revalidates; a refused session signs out when it comes back; offline the cached member stays.
- Per-member offline copies live in the documents directory (src/data/disk-cache.ts, one JSON per station + member + kind). Sign-out, a server-ended session and removing a station delete them.
- Stores that hold member data reset on any station or member change (module-scope subscriptions, see src/store/notifications.ts) and drop late answers with captureIdentity().
- Read marks and similar writes are optimistic and roll back on failure, with alertError for the failure.
- Hermes rejects Postgres timestamps; parse them with parseMs() (src/data/time.ts).
- Object ids are text (a prefixed ULID, or a 1.x id as a decimal string): parse route params, links and saved copies with objectId() (src/lib/object-id.ts, the rule of packages/types/src/object-refs.ts), compare as strings, never Number() an id; copies saved before 3.0 hold numbers, so their parsers coerce them.
- My tasks, the last 20 records opened (with the names of the people they name) and the details of the last 20 files opened read offline too: useOfflineResource (src/data/offline-view.ts rules: saved copy first, kept and marked 离线中 when unreachable, deleted on 403 / 404) and src/store/offline.ts.
- My conversations (src/store/sessions.ts), each knowledge shelf without bodies (src/data/kb-shelf.ts) and the latest page of the 12 conversations opened last (src/store/chat-copies.ts) open from the phone's copy and refresh behind it.
- A message the station cannot take waits in the outbox (src/store/outbox.ts): a conversation on screen sends its own once a page read reaches the station; the root flusher sends the rest on foreground and every 20 s. A chat send gives up waiting for headers after CONNECTION_TIMEOUT_MS and aborts the request.
- Every queued send goes through `deliverQueued`: one in-flight claim per message, recheck it is still queued, dequeue only on acceptance. Every chat send carries `client_turn_id` (the outbox id, reused on retry; a composer send that falls back to the queue keeps its id); 409 `duplicate_turn` means already saved = delivered. Status 0 is delivery unknown (`status: 'unknown'`) and simply retries. 408/409/429/5xx retry with backoff, for `createSession` of a first message too; other refusals stay `failed` in the conversation with retry/remove, or (no conversation yet) ask remove/keep. A full outbox refuses and the composer keeps the words. A late send result after a station/member switch is dropped (src/chat/direct-send.ts).
- Opened knowledge documents keep a saved copy and the recently opened list per station + member (src/store/knowledge.ts, rules in src/data/recent-docs.ts). A 403 / 404 deletes the copy and stops showing it; only an unreachable station (no answer, 502/503/504) falls back to it (`docMiss`).
- The top of a knowledge shelf lists the recently opened documents even when the shelf fails, so they open offline on a cold launch (src/data/kb-rows.ts).
- Offset-paginated lists are read to the end with collectPages() (src/data/paging.ts), bound to the identity they started on; never stop at the first page.
- Every multi-step write (a Files upload: init, bytes, complete, later batch items) checks the identity captured before its first step and stops on a change (src/api/drive.ts).
- Links go through src/lib/deep-links.ts (pure), src/shell/object-ref.ts (pure) and src/shell/open-object.ts: documents, files, folders, projects and tasks (`#/projects/<id>?task=`), records (`#/tables/<base>/table/<table>?record=`), runs (`#/activity/…`) open as sheets, conversations (`#/chat?session=`) as the page, tables and My Agents as places; other station pages in the in-app Safari view, other sites in Safari. A notification opens what it points at, else its sheet (src/shell/open-notification.ts).
- Links in Markdown are chips (src/lib/link-chip.ts): an object shows type and title, a file name and size, anything else its domain; never a raw URL.

## Widgets and iPad

- iPad gets the tab bar as a sidebar (`sidebarAdaptable`); there is no hand-made split view.
- targets/widget holds the 我的任务 and 最近文档 widgets; they read only the App Group snapshot src/widget/publish.ts writes through modules/widget-bridge (shape: src/widget/model.ts, a parity test checks the Swift decoder). Never put a token or private body text in it.
- The widget works due buckets out per timeline entry (targets/widget/DueBuckets.swift, the rule of src/data/tasks.ts `dueBucket`); src/widget/swift.test.ts compiles it with swiftc against the JS rule (on a Mac also under Buddhist and Japanese calendar settings) wherever swiftc exists, and typechecks the widget where the iOS simulator SDK is installed.
- Widget links carry `station=`; it stays on the route until checked, and the item's screen (src/widget/station-gate.tsx) waits for the stations to load, then opens only on that station.
- Colorsets do not reach Color.accentColor in an extension: spell the V1 green out in Swift.
- Object sheets render their title, actions and ✕ through SheetScreen (src/ui/screen.tsx); toolbar buttons must be direct children of Stack.Toolbar.
- Widget links keep their `greenhouse://knowledge/doc` and `greenhouse://projects/task` addresses; src/widget/model.ts `widgetLinkPath` maps them to the sheets.

## Push

- The server pushes every notification-center fact through the Expo Push Service; the phone's switches (needs you / done / other / preview) only narrow it. Pushes carry ids only (`PushData`: station ref, member, category, notification id, `/notification?id=`); previews (the notification title) are off by default.
- Registration (src/push/register.ts) runs after sign-in, on foreground and on a new Expo token, per station; it never prompts. The soft ask (src/push/soft-ask.ts) comes once notifications are on screen, at most every 14 days; only "allow" raises the system prompt.
- A tap opens /notification on the station that sent it (switching first); a push for another member or a removed station only opens the app (src/push/model.ts, pure and tested).
- Never commit development: true in getExpoPushTokenAsync; simulator push payloads put PushData under the top-level body key.

## Share extension

- Not in store builds yet: EAS cannot turn on App Groups for app.greenhouse.mobile.share through the App Store Connect API. Enable App Groups (group.app.greenhouse.mobile) for that identifier in the Apple developer console, then put the share entry back in app.json (`@bacons/apple-targets` match and `extra.eas.build.experimental.ios.appExtensions`).

- targets/share ("存到 Greenhouse", @bacons/apple-targets type `share`, SwiftUI) uploads shared photos, videos and files into Files on the active station: shelf and folder picker, then init → bytes → complete.
- It reads only the station and a short-lived access token from the App Group keychain item `greenhouse.share.session` (src/share/session.ts writes it on every token change; src/share/payload.ts is the shape). Never put the refresh token there: a single-use refresh in the extension would sign the app out. An expired token tells the member to open the app.
- Keep the keychain key, service and App Group in payload.ts and ShareModel.swift identical; the extension's Info.plist activation rule caps what it accepts.
- The session carries the app's language; the extension speaks it (else the phone's) and uses the V1 green from ShareLogic.swift `Brand`, kept equal to src/theme/palette.ts.
- Logic the extension needs goes in Foundation-only targets/share/ShareLogic.swift; src/share/share-logic.test.ts compiles it with src/share/ShareLogicCheck.swift and runs the checks (skipped without swiftc). A retry uploads only attachments that failed for a passing reason (no answer, 408, 429, 5xx); other 4xx refusals are listed with their reason and only another folder tries them again.
- The camera captures photos only (src/files/picker-options.ts); the app has no voice input (members use the keyboard's dictation), so expo-image-picker's `microphonePermission` stays false and nothing may record sound.

## Native builds and release

- **Do not publish before the 3.0 release**: no `eas build`, `eas update` or `eas submit` from this line, and never point .github/workflows/mobile.yml at `v1`. The EAS project, bundle id and update URL are shared with the store app that ships from v2. See RELEASING.md.
- ios/ and android/ are generated by `pnpm mobile:prebuild` and git-ignored; rerun it after changing app.json, plugins or entitlements, then restore sdk.dir (or ANDROID_HOME), since --clean deletes android/local.properties.
- If prebuild cannot find CocoaPods, run pod install in ios/ yourself with Homebrew's pod and GEM_HOME/GEM_PATH unset; confirm "Building from source: false" (a silent fallback to building React Native from source crashes at launch on React.framework).
- After pod install, stale .last_build_configuration flavor markers cause Debug link errors or a launch SIGSEGV in Props::Props(); write the opposite configuration into the markers so the next build re-extracts.
- Expo Go cannot run the app; use a dev client (`pnpm mobile:ios`, `pnpm mobile:android`) on a dedicated simulator and judge UI there, never on Expo web.
- Releases follow the native fingerprint (`runtimeVersion.policy: fingerprint`): JS-only changes ship as OTA; native changes (new native modules, ICONS entries, app icon, fonts, entitlements, app.json) need a build.
- Never hand-edit the version in app.json or package.json; release-please bumps it and fingerprint.config.js keeps it out of the fingerprint.
- The app icon (assets/icon.png, adaptive-icon.png) is rendered from logos/greenhouse-mark.svg's paths on V1 green with rsvg-convert; regenerate both together.
- Mermaid ships as assets/web/mermaid.min.txt (copied from node_modules/mermaid/dist, version in MERMAID_VERSION) and is injected into the diagram WebView; there is no CDN fallback.
- A dev client on a simulator opens Metro without the "Open in" prompt with `xcrun simctl launch <udid> app.greenhouse.mobile --initialUrl http://localhost:<port>`.
- iOS status bars are owned by native controllers (`UIViewControllerBasedStatusBarAppearance=true`); all stacks pass the app theme to stackDefaults. Expo StatusBar is Android-only.

## UI

- Objects open only through useOpenObject / useOpenHref (src/shell/open-object.ts); never push a detail route by hand.
- A sheet's list or ScrollView is its root element (after SheetScreen); a ScrollView wrapped in a flex View renders nothing in a form sheet.
- Zustand selectors return stored values; derive filtered arrays with useMemo (a fresh array from a selector loops forever).
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
- Lists use src/ui/list.tsx; virtualized rows pass rowPosition() instead of sitting in a Section; show Skeleton or LoadingState and EmptyState.
- Use react-native-keyboard-controller; never KeyboardAvoidingView. A list under a sticky composer scrolls in KeyboardChatScrollView (`renderScrollComponent`, `offset` = the bottom safe area) so the keyboard joins its bottom inset; scroll to its end with the native scroll view's scrollToEnd, never VirtualizedList's (it ignores padding and insets).

## Native pitfalls

- RN overlays render below native sheets: UI that must cover them (toast) uses FullWindowOverlay, mounted only while shown.
- The root Stack starts at (tabs): go home with goHome (src/shell/nav.ts), never `<Redirect>` or router.replace; open a page from a sheet only after dismissing the sheets (openObject does).
- A large-title page's list or ScrollView is the screen's root element (a fragment, the background on the list's own style); inside a wrapping View the title sticks over the rows instead of collapsing.
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
- Words: 首页, 知识库, 云盘 (never 档案库), 项目, 表格, 通知, 工作站, 「我」.

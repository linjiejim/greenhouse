# Universal client (Expo SDK 57; web, iOS, Android and macOS shell)

## Scope

- The app is the team Agent hub on web/iOS/Android and inside the macOS shell; core owns chat/Files/automations/account and station manifests gate optional plugin places.
- The root sidebar drawer gives each place its own stack; chat lives in home. Station v2 navigation selects optional plugin places; legacy stations use src/shell/modules.ts fallback rules.
- Drawer edge swipes open only at a place root; placeDepth reads partial nested states and home root permits a full-width right swipe. Regular-width iPad keeps the sidebar permanent.
- Page, sheet, type, color and state rules live in DESIGN.md; read it before adding a screen.
- Experience bar: content within 1.5 s of a cold start (cache first, refresh in background), 60 fps lists, haptics and optimistic updates, offline reading of recent items, dark mode, Dynamic Type, VoiceOver.

## Install and tests

- apps/client is outside the pnpm workspace with its own lockfile: install with `pnpm client:install`, and run `pnpm typecheck` and `pnpm lint` inside apps/client, because root checks skip it.
- Never run `npx expo install`; it writes apps/client into the root pnpm-lock.yaml. Pin versions by hand (SDK 57 packages are ~57.x), then run `pnpm client:install`.
- apps/client/pnpm-workspace.yaml is the isolation barrier; pnpm 11 ignores .npmrc, so never put pnpm settings there.
- If packages get relinked into the root store (metro.config.js blocks it: red screen "Unable to resolve" or a native "version mismatch"), delete node_modules, run `pnpm client:install`, then `expo start --clear`.
- Never add `@react-navigation/*` (expo-router vendors it; import from `expo-router/react-navigation`); keep react-native-drawer-layout and babel-preset-expo as direct dependencies.
- Never import `@greenhouse/*` packages. Files headed VENDORED are verbatim copies (src/shared/push.ts ← packages/types/src/push.ts); re-copy instead of editing. src/shared/greenhouse-types.ts is the hand-kept subset of v1 server shapes; declarations marked verbatim are checked by src/shared/vendor.parity.test.ts.
- The root vitest runs mobile tests without a mobile install: tests must not import react, react-native or `expo-*`, even transitively (mock them, as src/startup/startup.test.ts does); keep logic in React-free modules (src/data, src/push/model.ts, src/api/compat.ts).
- Tests and the modules they import sit in folders with a stub tsconfig.json (copy src/api/tsconfig.json), or CI fails with TSConfckParseError.

## HTTP contract

- Sign-in: `POST /api/auth/login` → `{ accessToken, refreshToken, user }`; refresh: `POST /api/auth/refresh` with `{ refreshToken }` (single use, one refresh at a time per station); member: `GET /api/auth/me` → `{ user }`; language: `PUT /api/auth/me/preferences`. There is no logout endpoint: sign-out forgets the pair.
- Errors are `{ error: '<words>' }`; src/api/client.ts maps the status to a stable `code` and keeps the words as `message`.
- `/api/bootstrap` (public) gives branding and `mobile_api`. `MOBILE_API` (src/api/compat.ts) is the minimum this build needs (currently 3); the server advertises CLIENT_API_LEVEL 4 for plugin discovery; a server below it shows the mismatch screen ("needs an update"), a v2 server (`api_version`) is unsupported. Raise `MOBILE_API` together with the server's `MOBILE_API_LEVEL` when the app starts calling a new endpoint.
- Notifications: `GET /api/notifications` (cursor pages), `/summary`, `POST /:id/read` (answers with the notification; it is also how a notification missing from the list is fetched), `POST /read-all`.
- Team activity: `GET /api/activity/recent` (14 days, `before` = last item's `at`, answers `next_before`); the bell sheet's second segment, rows open via src/notifications/activity.ts.
- Push devices: `/api/auth/me/push-devices` (src/api/push.ts).
- Knowledge: `/api/knowledge/docs?visibility=`, `/docs/id/:id`, `/search` (documents have no comments in 3.0); folders are drive folders of scope `kb` (`/api/drive/folders?scope=kb&visibility=&parent_id=all`). The server caps a docs page at 100.
- Files: `/api/drive` scope `kb` (team = `visibility=team`, mine = `private`): folders, files, search, breadcrumb, `files/:id/content` (authenticated; 302 to a signed URL on COS), and upload init → bytes (presigned PUT, or PUT to the API in proxy mode) → complete.
- Projects: `/api/projects` (offset pages; `POST` `{ title }` makes one), `/:id` (project with its task tree, members, stats), `/gantt` (every readable project with its tasks; the source of "my tasks": open tasks assigned to me, src/data/tasks.ts), `PATCH /tasks/:id` (status changes are optimistic, one save in flight, the last choice sent last, every save bound to the identity that chose, src/data/latest-choice.ts; assignee and priority from menus, title and due day from the task form app/task-form.tsx, patching only what changed, src/projects/task-draft.ts), `POST /:id/tasks` (the task form's secondary path; asking Sprouty is the common one), `/meta/users` (whom to assign), `/tasks/:id/comments`. There is no task by id; read it from its project's tree. `tags` may be a JSON string.
- Tables (feature `tables`): `/api/tables/bases` (`POST` `{ name }` makes a private base with one table), `/bases/:id` (tables and my role), `/tables/:id/schema`, `POST /tables/:id/records/query` (cursor pages), `/records/:id`, `POST /records` with `{ values }` keyed by field id. Only text, number, date, single select and boolean are written from the phone (src/data/table-fields.ts); editors and up may add. Select values are option ids; formula and rollup results are in `computed_values`.
- My Agents: `/api/agent-access/writes` (mine, newest 50; a write's detail comes from that list), `/api/usage/spend` (my month, USD micros, src/data/money.ts), `/api/agent-access/gateway` (my keys, never a secret; created on the web).
- Assistant: `/api/sessions` (mine, `page_meta` pages of 50; `pinned`/`pin_sort`; `last_message`, absent on older stations; `POST`/`DELETE /:id/pin`; `PATCH /:id` `{ title }`; `DELETE /:id`, 409 while a reply is written), `/api/sessions/:id/messages` (latest page first, `before_seq` for older; `pipeline`, `images`, `references_` are JSON text, src/chat/parts.ts), `POST /api/chat` and `GET /api/chat/runs/:id/stream` stream NDJSON (src/data/chat-stream.ts) through Expo's fetch (`api(path, init, via)`), `POST /api/chat/runs/:id/stop`; Regenerate posts `regenerate_assistant_message_id` (latest reply only, else 409). src/data/conversation.ts owns the rules: the latest page replaces its range and keeps older history, keep the live exchange until the saved transcript holds a new reply id, follow a reply in progress on open and refocus, give the draft back on any refused send, report an unreachable station as `offline` (the outbox queues it).
- Every chat turn sends `rich_blocks` (src/markdown/rich.ts `MOBILE_RICH_BLOCKS`); rendering never depends on the station reading it.
- Chat files: pictures `POST /api/upload` (multipart `file`, ≤ 5 MB, scaled to 1600 px JPEG first) ride as `messages[].images`; other files `POST /api/chat-files/upload` (`file` + `session_id`) ride as an ```attachments fence (src/api/chat-files.ts). Multipart goes through Expo's fetch with an expo-file-system File.
- Card actions: task capture `POST /api/prompts`, table plans `POST /api/tables/schema-plan/apply`, both with the action id `artifact:<message>:<step>:<tool>`; receipts `GET /api/artifact-actions/:id` (src/api/artifacts.ts). An ask_user answer is a normal message in the web's English words (src/chat/parts.ts `askUserAnswer`); my bubble renders inline Markdown, as the web's does.
- Link titles: `POST /api/refs/resolve` `{ urls }` → `{ items: [{ url, type, id, title|null, meta? }] }` (src/store/refs.ts); a 404 means the station predates it and chips keep the link's words.
- Member names in plugin `user` fields: `POST /api/people/resolve` `{ ids }` → `{ people: [{ id, name }] }` (src/store/people.ts, `usePeopleNames(peopleIds(fields, rows))` then pass the map to fieldText); a 404 means the station predates it and the field shows the id.
- Text size: `GET`/`PATCH /api/me/preferences` `{ fontScale }` (src/settings/text-size.ts); a 404 keeps it on the phone. Older stations refuse 0.8 and 0.85 (400): the phone keeps them.
- Shared with me: `GET /api/shares` (the 全部对话 sheet's 共享给我 segment; one row per conversation, src/data/shares.ts), `PATCH /api/shares/:id/read` on open. A conversation whose `/api/sessions/:id` says `is_owner: false` opens read-only (`share_info.shared_by_nickname` names the sharer): no composer, no ⋯ menu, no regenerate.
- Automations (定时任务): `/api/tasks` (a super's list holds every member's; the phone shows mine, src/automations/model.ts), `/:id`, `PUT /:id` `{ enabled }` (pause / resume), `POST /:id/run` (answers `session_id`, opened as the conversation), `/:id/runs` (a run opens its run sheet), `DELETE /:id`. New ones and changes are asked of the assistant in a conversation with a drafted message (`useStartChat`, src/shell/open-object.ts); there is no cron form. The run profile's name comes from `/api/profiles`.
- Feedback: `POST /api/me/feedback` `{ message, context }` (src/feedback); a 404 can mean the Feedback plugin is disabled or the station lacks the endpoint.
- Search: `GET /api/search?q=&kind=` (conversations, projects, documents) and `/api/drive/search`; my tasks are matched from the saved copy. Runs: `GET /api/runtime/runs/:id`. My agents: `/api/agent-access/connections`.
- Folders and files: `POST /api/drive/folders`, `PUT /folders/:id` `{ name?, parent_id? }`, `DELETE /folders/:id` (409 when not empty), `PUT /files/:id` `{ name?, folder_id? }`, `DELETE /files/:id`; documents `POST /api/knowledge/docs`, `PUT /docs/:id` `{ title?, folder_id? }`. Moves never cross shelves.
- Access: a 403 means a role, feature or capability gate (EmptyState without retry); a 404 means gone or not visible to this member (src/data/access.ts).
- Connectors (「我」 → 连接, app/me/connectors.tsx): `GET /api/me/connectors` (`{ team, personal }`; 403 = no `mcp_call`, 404 = older station, both an EmptyState), `PUT /:id/key`, `POST /:id/oauth/start` `{ client: 'mobile' }` → the system auth session returning to `greenhouse://connectors/oauth-finish` (src/connectors/model.ts, equal to the server's `CONNECTOR_APP_REDIRECT`; a test compares) → `POST /oauth/finish`, `POST /:id/test`, `DELETE /:id/connection`. Adding connectors (team or personal) happens on the web. `mcp_call`'s `needs_connection` answer is the chat's ConnectCard (src/chat/parts.ts).
- Feishu sign-in: wait for bootstrap; API 4+ discovers `feishu` via public `/api/auth/providers`, API 3 uses `/api/feishu/login-available`. Then `start-login?app_redirect=greenhouse://auth/feishu` (the server allow-lists exactly that address) in the system auth session, then `/api/feishu/oauth/exchange`. Keep `FEISHU_APP_REDIRECT` (src/login/feishu.ts) equal to the server's `APP_LOGIN_REDIRECT`; a test compares them.
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
- 知识库 opens on 最近, its first segment: the documents this member opened on this phone (the local list above; the station has no recent-documents endpoint), so they open offline on a cold launch (src/data/kb-rows.ts). Document rows are one line: title, then the date at the trailing edge.
- Offset-paginated lists are read to the end with collectPages() (src/data/paging.ts), bound to the identity they started on; never stop at the first page.
- Every multi-step write (a Files upload: init, bytes, complete, later batch items) checks the identity captured before its first step and stops on a change (src/api/drive.ts).
- Links go through src/lib/deep-links.ts (pure), src/shell/object-ref.ts (pure) and src/shell/open-object.ts: documents (by id, or by slug when the link has none: the chip opens the id refs/resolve answered, else the sheet looks the slug up), files, folders, projects and tasks (`#/projects/<id>?task=`), records (`#/tables/<base>/table/<table>?record=`), runs (`#/activity/…`) open as sheets, conversations (`#/chat?session=`) as the page, tables and My Agents as places; other station pages in the in-app Safari view, other sites in Safari. A notification opens what it points at, else its sheet (src/shell/open-notification.ts).
- Links in Markdown are chips (src/lib/link-chip.ts): an object shows type and title, a file name and size, anything else its domain; never a raw URL.

## Widgets and iPad

- iPad at regular width gets the sidebar as a permanent column (the split view); never embed object views in panes or draw pane headers: objects stay form sheets and every bar is a native stack's.
- targets/widget holds the 我的任务 and 最近文档 widgets; they read only the App Group snapshot src/widget/publish.ts writes through modules/widget-bridge (shape: src/widget/model.ts, a parity test checks the Swift decoder). Never put a token or private body text in it.
- Widget task refresh waits for station discovery, skips web, and clears `my-tasks` when v2 lacks Projects. Discovered legacy stations retain the ten-minute native refresh.
- The widget works due buckets out per timeline entry (targets/widget/DueBuckets.swift, the rule of src/data/tasks.ts `dueBucket`); src/widget/swift.test.ts compiles it with swiftc against the JS rule (on a Mac also under Buddhist and Japanese calendar settings) wherever swiftc exists, and typechecks the widget where the iOS simulator SDK is installed.
- Widget links carry `station=`; it stays on the route until checked, and the item's screen (src/widget/station-gate.tsx) waits for the stations to load, then opens only on that station.
- Colorsets do not reach Color.accentColor in an extension: spell the Haven accent out in Swift.
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
- The session carries the app's language; the extension speaks it (else the phone's) and uses the Haven accent from ShareLogic.swift `Brand`, kept equal to src/theme/palette.ts.
- Logic the extension needs goes in Foundation-only targets/share/ShareLogic.swift; src/share/share-logic.test.ts compiles it with src/share/ShareLogicCheck.swift and runs the checks (skipped without swiftc). A retry uploads only attachments that failed for a passing reason (no answer, 408, 429, 5xx); other 4xx refusals are listed with their reason and only another folder tries them again.
- The camera captures photos only (src/files/picker-options.ts); the app has no voice input (members use the keyboard's dictation), so expo-image-picker's `microphonePermission` stays false and nothing may record sound.

## Native builds and release

- EAS publication requires an explicit release task; main changes can trigger production fingerprint CD when EXPO_TOKEN exists. Preserve the shared project, identifiers and update URL; review RELEASING.md before landing candidate versions.
- ios/ and android/ are generated by `pnpm client:prebuild` and git-ignored; rerun it after changing app.json, plugins or entitlements, then restore sdk.dir (or ANDROID_HOME), since --clean deletes android/local.properties.
- If prebuild cannot find CocoaPods, run pod install in ios/ yourself with Homebrew's pod and GEM_HOME/GEM_PATH unset; confirm "Building from source: false" (a silent fallback to building React Native from source crashes at launch on React.framework).
- After pod install, stale .last_build_configuration flavor markers cause Debug link errors or a launch SIGSEGV in Props::Props(); write the opposite configuration into the markers so the next build re-extracts.
- Expo Go cannot run the app; judge native UI in a dev client (`pnpm client:ios`, `pnpm client:android`) on a dedicated simulator and browser UI through the universal web export.
- Releases follow the native fingerprint (`runtimeVersion.policy: fingerprint`): JS-only changes ship as OTA; native changes (new native modules, ICONS entries, app icon, fonts, entitlements, app.json) need a build.
- Product versions in app.json/package.json follow release-please extra-files; change them only for an authorized release cut. Fingerprint excludes version fields; store build numbers remain separately incremented.
- The mark is Haven (logos/README.md): src/ui/logo.tsx draws src/ui/brand.generated.ts, body in the palette's `mark`, seed in its own colour. The app icon (assets/icon.png, adaptive-icon.png on #235D4D) and brand.generated.ts are exports of main's scripts/build-brand-assets.py; copy them from main together, never redraw them.
- Mermaid ships as assets/web/mermaid.min.txt (copied from node_modules/mermaid/dist, version in MERMAID_VERSION) and is injected into the diagram WebView; there is no CDN fallback.
- A dev client on a simulator opens Metro without the "Open in" prompt with `xcrun simctl launch <udid> app.greenhouse.mobile --initialUrl http://localhost:<port>`.
- iOS status bars are owned by native controllers (`UIViewControllerBasedStatusBarAppearance=true`); all stacks pass the app theme to stackDefaults. Expo StatusBar is Android-only.

## UI

- Objects open only through useOpenObject / useOpenHref (src/shell/open-object.ts); never push a detail route by hand.
- The composer's band is opaque through the bottom safe area: place it in a KeyboardStickyView at bottom 0 and pass `bottomInset` (src/chat/composer.tsx); never leave the inset under it see-through.
- Home's recent list length is the phone's `homeRecent` pref (0/3/5/10, default 3, src/data/home.ts); rows there are `compact` (title and short age, no snippet).
- On native, Sprouty has one presence per screen: the header face in a conversation, the greeting sprout on home; never put an avatar on message rows.
- A sheet's list or ScrollView is its root element (after SheetScreen); a ScrollView wrapped in a flex View renders nothing in a form sheet.
- Zustand selectors return stored values; derive filtered arrays with useMemo (a fresh array from a selector loops forever).
- Native UI uses system components: the expo-router native Stack, @expo/ui/swift-ui and NativeMenu (src/ui/menu.tsx); never JS-drawn headers, bottom sheets, action sheets, calendars or switches.
- Brand: Haven forest #235D4D / pale sage #B1D2BF in dark, the seed lime #B6CA68 never as text; Nunito. Colours come from the shared token module (packages/ui/src/tokens/tokens.ts) through the generated src/theme/tokens.generated.ts — run `pnpm tokens:build` at the repo root, never edit a hex in src/theme/palette.ts; dark content surfaces keep UIKit's system base; native controls keep system styling with the accent as tint. Contrast and web parity are tested (src/theme/palette.test.ts, packages/ui/src/tokens/platform-parity.test.ts).
- A user-chosen colour (project, tag) draws through categoricalFor() (src/theme/palette.ts) as its categorical fg/fill pair, never the raw hex.
- `colors.*` are opaque ColorValues: never concatenate or compute alpha on them; use `hex.*` for strings and alpha() for transparency.
- Text and icons on the accent use onAccent, on other solid fills onTint; no hex literals except data colors.
- Take typo, weight, radius (with squircle) and HIT from src/theme.ts; never disable allowFontScaling.
- Register icons as [SF Symbol, Material] pairs in ICONS (src/ui/core.tsx) and run `python3 scripts/android-icons.py` in apps/client; toolbar icons go through toolbarIcon().
- Give every icon-only button an accessibilityLabel; Icon is hidden from VoiceOver unless it stands alone.
- Declare presentation only in app/\_layout platform layouts with the src/ui/nav presets; screens declare their own title and actions; native back buttons stay system-owned.
- Glass (src/ui/glass.tsx) is for the control layer only; content sits on solid system colors.
- A failed user action shows alertError; toast is for success only; a failed load shows EmptyState with retry; login errors stay inline.
- Forms use NativeForm with FormNavRow; content buttons use NativeButton, never Pressable plus Text.
- Every SwiftUI Host you create gets the useLocaleEnv() modifier, and inline hosts in RN content get ignoreSafeArea="all".
- Lists use src/ui/list.tsx; virtualized rows pass rowPosition() instead of sitting in a Section; show Skeleton or LoadingState and EmptyState.
- Use react-native-keyboard-controller; never KeyboardAvoidingView. A list under a sticky composer adds the keyboard's height (useKeyboardState, minus the bottom safe area) to its bottom padding so its end stays reachable; scroll to its end with the native scroll view's scrollToEnd, never VirtualizedList's (it ignores padding). Follow a streaming reply on every change at the end, not only on content-size events, and let only a drag release the follow.

## Native pitfalls

- RN overlays render below native sheets: UI that must cover them (toast) uses FullWindowOverlay, mounted only while shown.
- The root Stack starts at (drawer): go home with goHome (src/shell/nav.ts), never `<Redirect>` or router.replace; open a page from a sheet only after dismissing the sheets (openObject does).
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
- Words: 首页, 知识库, 云盘 (never 档案库), 项目, 定时任务, 表格, 通知, 工作站, 「我」.

## Universal client

- Platform primitives use `.ios.tsx`, `.android.tsx` and `.web.tsx`; base re-exports keep TypeScript and Expo Router route discovery working.
- SwiftUI, Compose and native view factories never load in browser implementations.
- Screens declare actions with `useScreenActions` or `ScreenActions`; only the iOS adapter owns `Stack.Toolbar` items, which remain its direct children.
- Browser menus, dialogs, tooltips and success toasts share `src/ui/overlay.web.tsx` for focus, Escape and portals; centered dialogs take a fixed `size` (DESIGN.md Surfaces), menus go through `MenuPanel`.
- Web frames use an opaque-origin sandbox and accept messages only from their own iframe window.
- Browser builds are single-station and use their own origin unless `EXPO_PUBLIC_API_BASE_URL` explicitly overrides it for development.
- Browser station ids include the API origin; hosted builds share the classic localStorage token keys, while development overrides keep origin-scoped keys.
- The optional `/api/extensions` v2 manifest gates built-in plugin places and supplies app navigation (primary and `more` entries); v1 or 404 means legacy navigation.
- `src/shared/plugins.ts` is a verbatim copy of `packages/types/src/plugins.ts`, checked by the React-free manifest tests; optional v2 does not raise `MOBILE_API`.
- `/p/[plugin]/[page]` renders entity-list/detail, settings-form and trusted embed surfaces; unknown pages use a validated browser fallback.
- Browser legacy links are mapped before auth routing and retained across sign-in; unmapped hashes open `/classic/` on the station.
- `pnpm test:e2e:client` owns ports 18920 and 18921 and the isolated `gh4_client` database on port 55450; its screenshots and auth state are ignored.
- Run Expo dev servers with `CI=1` in restricted environments to disable file watchers; keep native configuration and fingerprint changes deliberate.
- Metro redirects native route-context entries only for web; verify source maps with `node scripts/check-web-bundle.mjs <export-dir>` after an export with `--source-maps`.

## Wide chat and inspector

- Keep the Drawer and the keyed main navigator mounted across browser breakpoints; reflow chrome without replacing navigators.
- Match the base file's extension in platform siblings (`nav.ts` → `nav.web.ts`); a `.web.tsx` sibling of a `.ts` file can lose to the base in Metro resolution.
- Shared chat screens retain the conversation engine, upload queue, rich renderers, ask_user and ownership checks; browser adapters own only layout and controls.
- Wide replies add an avatar and copy/regenerate/fork/export controls; native replies keep their existing compact author row.
- Forks call `/api/sessions/:id/fork` with `message_id`; a branch is a copied transcript, not a prefilled draft.
- Browser drops and native pickers enter `useComposerFiles.acceptFiles`; release browser object URLs when their draft or preview ends.
- Authenticated browser file previews download through `api()`; pass only the resulting Blob URL to the sandboxed frame, and revoke it on close.
- The root router owns inspector history (three objects maximum); promotion retains the current route key, removes inspector history and replaces an earlier promoted main object.
- Inspector widths stay within 360–520 px, remembered per place; below 1440 they float without squeezing the main column.
- Escape dismisses the top interactive overlay, then the inspector, then a live generation; closing an inspector above a promoted object retains that main object.
- Search and commands, the Activity dialog and the account menu live in `src/shell/desktop-tools.web.tsx`; notifications reuse `src/notifications/center.tsx` on every platform.
- Browser settings use the existing `me` stack in a fullscreen overlay; the single browser station is shown as identity information without a station switcher.
- Web startup uses native readiness and grace deadlines with a bounded CSS fade; fix DOM warnings at their source instead of suppressing console errors or forwarding them to product toasts.
- `tests/client-e2e/p2.e2e.ts` exercises separated NDJSON chunks with a browser ReadableStream and writes design-number screenshots at 1440/1280/1024/390; restricted runners collect tests only and leave Chromium execution to the reviewer.

- Conversation-row previews use `/sheet/conversation` with the shared chat screen forced read-only, including its outbox guards; normal conversation navigation still opens the main stack.

## Places and plugin surfaces

- Wide web place routes portal their secondary controls into `PlaceSecondary`; they reuse API helpers, library actions and the root inspector stack. Phone screens remain in `src/<domain>/phone-screen.tsx` and the shared routes re-export them.
- The desktop knowledge editor vendors `packages/knowledge-editor` schema, Markdown parser and serializer verbatim (parity-tested), behind a `use dom` boundary. Markdown stays canonical, including when `content_json` is empty.
- Classic UI components depend on workspace packages, stores, routing and CSS that the isolated Expo app cannot import. Reuse their editor schema and existing mobile domain hooks; keep browser grid/board adapters behind DOM components, without a second API or permissions layer.
- Native Metro resolution redirects web-only route-context dependencies to shared routes; browser editors/grids/boards must not add DOM bundles to the iOS export.
- Official native screen descriptors and nav glue live under `src/plugins/<id>/`; `native-registry.ts` only aggregates them. A v2 place requires an actual native nav entry, not just an installed plugin id; legacy stations retain their original navigation.
- Entity surfaces follow the CRUD `skip/limit/sort/filter` protocol, deduplicate infinite pages and invalidate pending reads on identity/query changes. Detail actions are limited to manifest actions and writable fields; deletion confirms first.
- Plugin record sheets use `sheet/plugin` and the same three-level inspector stack and promotion rules as built-in objects.
- Plugin settings use `GET/PUT /api/admin/settings`, submit only changed declared keys, preserve masked secrets and display server errors. Unknown keys never create speculative controls.
- Trusted plugin frames use `WebFrame` with a real origin and the plugin bridge; check both source window and exact origin. They receive only `/api/ext-ui/token` credentials (404 means an empty token). Chat/document previews retain their opaque sandbox and never receive credentials.
- Real-origin plugin frames permit scripts and same-origin access for the protocol; they have the same code trust as their installed plugin. Do not use that bridge for arbitrary user HTML.
- Embed navigation accepts client routes; `sendPrompt` opens a chat draft and never submits it. Theme changes preserve the frame, token refresh is identity-bound, and late frame replies are discarded.
- Browser settings use the existing settings routes in the centered `xl` settings window with a column of personal settings only (preferences, account, agents, connections, station); apps live in the rail. The column owns its footer actions and the window owns close (`SettingsWindowContext`).
- The wide rail lists core places, a divider, then More (`ui/rail-more.web.tsx`), whose flyout holds every app entry; `usePlaces()` is the one source for the rail, ⌘K go-to commands and the native Go menu. Rail entries are `ui/rail-item.web.tsx` with short `client.rail*` labels.
- App icons come from `pluginIcon()` (src/plugins/icons.ts): the manifest's lucide name mapped to an `IconName`, then the official screen icon, then `apps`. Add a lucide mapping (and an `IconName` with `scripts/android-icons.py`) rather than drawing `open` for apps.
- Places use `PlaceEmpty` with `title` (icon, line, create action) for "nothing yet" and without it only for empty search/filter results. Toolbar buttons are icons or words, never text glyphs.
- One-page apps render no secondary column (an empty `PlaceSecondary` host is hidden); plugin read surfaces without a screen use `resource-screen.web.tsx` (rows or facts from `resource-model.ts`).
- `tests/client-e2e/p3.e2e.ts` and `plugins.e2e.ts` cover places and declarative surfaces; the latter serves its static embed fixture through Playwright routing. Restricted runners collect these specs; the reviewer runs Chromium and generates the design/plugin screenshots.

## Client polish

- Ask-user drafts are scoped to the conversation and user-turn sequence, so live-to-saved row replacement retains answers without sharing them across repeated questions. Submission waits for generation to finish.
- Table rows use the primary field as their accessible name even when a saved view orders another field first; Enter and Space open the same record inspector as a click.
- Record and task details reuse their domain loaders and mutations; `ui/detail-fields` adapts only the wide inspector layout, retaining native sections below 760 px.
- Browser entity filters and sorting use the shared Menu; `ui/field-value.web` supplies field icons and enum Chips for both entity lists and table grids.
- Browser place CSS uses semantic web tokens for fills, selected rows, urgency, and callouts in both appearances.
- Client fixtures use valid object ids; never loosen route id validation to accept test placeholders.

## Browser regressions

- Web Touchable maps accessibility state to explicit ARIA props; RN-web does not translate native `accessibilityState`.
- Passive Touchables render a View, so enum Chips do not consume their record row's click or add a tab stop.
- The web route frame adapts NativeStack's `aria-hidden` on the visible main screen while a wide inspector is open; covered routes and phone sheets retain stack semantics.
- Screenshot tests wait for the startup cover and expected content after reload; dark chat captures reopen the chat before its inspector, and embed fixtures apply received theme tokens.

## macOS shell

- `src/desktop` contains native shell bridges. Metro's desktop source extensions are enabled only by GREENHOUSE_DESKTOP=1; UI pages never branch on desktop detection.
- Desktop bundles use the phone's station configuration, Keychain token storage through a scoped Tauri plugin, and X-Greenhouse-Client: desktop. Browser configuration and token storage remain unchanged.
- `src/desktop/shortcuts.json` is the shared menu/useShortcut table; native Go items follow the authorized rail, including primary plugin places.
- Quick ask reuses the ordinary session API, send transport and stream reducer. Settings reuses the me routes in a native window.
- Desktop windows synchronize station/session changes without localStorage tokens and use Web Locks around one-use refresh-token rotation.
- Entity lists keep pages and scroll when covered by an inspector; only query/identity changes and explicit refresh reload them. Pending replies from previous queries remain invalidated.
- Browser Playwright specs are collected in restricted runners; desktop native behavior is accepted by the reviewer after a successful local build.

## Hosted browser export

- Declarative entity edits use only manifest fields with `writable === true` and PATCH only values changed from the loaded row; preserve untouched nulls, JSON and timestamp strings. Refreshing a list keeps its rows and total until the next page arrives; identity/query changes still invalidate old data.
- `pnpm app:build` at the repository root exports this isolated workspace to `dist-hosted`, then copies it to `public/app`. Hosted exports clear desktop and developer station overrides and disable dotenv loading; browser requests use their own origin. Native/store configuration stays unchanged.
- Trusted desktop plugin frames append `host_origin=tauri://localhost`; plugins explicitly allow that parent origin. Browser frames retain their normal same-origin contract. The host allows scripts/same-origin/forms/popups only for installed plugin bridges.

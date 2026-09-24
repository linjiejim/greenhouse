# apps/browser — Chrome extension (MV3)

Thin client of **self-hosted Greenhouse instances**: the user saves one or more
**stations** (server URL + email/password sign-in) in the options page; the
agent brain, tools and knowledge stay server-side. The extension only captures
context, calls the active station's API and renders.

## Layout

```
public/manifest.json   # static MV3 manifest, copied verbatim into dist/
public/icons/          # app icons (16/32/48/128/512) rendered from assets/icon.svg
assets/icon.svg        # icon source — re-render PNGs with rsvg-convert on change
PRIVACY.md             # privacy policy (store listing requires a hosted copy)
sidepanel.html         # side panel entry (React)
options.html           # options page entry (React)
src/
├── config.ts          # build-time clients.stations from the root greenhouse.config.ts
├── background/        # service worker — owns refresh-token rotation (single-flight)
├── lib/               # storage (chrome.storage.local slot), auth client, hooks
├── i18n/              # en/zh catalogs, registered into @greenhouse/ui's i18n mechanism
├── options/           # connect + sign-in + preferences UI
├── sidepanel/         # main panel UI
└── styles.css         # tailwind v4 + @greenhouse/ui tokens.css
```

Product name is **Greenhouse Bridge** (manifest `name`, i18n `options.title`,
page `<title>`s — keep in sync). Re-render icons with
`for s in 16 32 48 128 512; do rsvg-convert -w $s -h $s assets/icon.svg -o public/icons/icon-$s.png; done`.

## Rules

- **Build**: `pnpm -F @greenhouse/browser build` → `dist/`, then Chrome →
  Extensions → Load unpacked → `apps/browser/dist`. `pnpm dev` = watch build +
  manual extension reload (no HMR).
- **UI comes from `@greenhouse/ui`** (atoms, markdown, tool-call cards, tokens,
  i18n mechanism). Same discipline as the package itself: no zustand, no
  router. Extension-local state lives in `chrome.storage` + React state.
- **Stations & auth** (spec: `docs/specs/20260707-multi-station-workspaces.md`):
  `src/lib/storage.ts` keeps a **station registry** in `chrome.storage.local`
  (`stations` slot: `{stations: [{id, baseUrl, name, auth}], activeId}`); the
  legacy single `auth` slot migrates lazily on first read (deterministic
  origin-derived ids so concurrent migrations converge). Origins are unique —
  adding a duplicate switches to it. Never store the password — only each
  station's `/api/auth/login` token pair. All token refreshes go through the
  background worker (`{type:'auth:refresh', stationId}` runtime message,
  **single-flight per station**, written back by id) so rotation can't race
  between contexts or leak across a mid-refresh switch. `authFetch()` resolves
  the **active** station per call and retries once after a 401-triggered
  refresh; a dead refresh token clears only that station's `auth` (entry kept)
  and pages fall back to the sign-in flow via `storage.onChanged`. The panel
  header's status dot is the station switcher (`sidepanel/station-menu.tsx`);
  `ChatView` is keyed by station id so switching remounts chat state. Removing
  a station best-effort revokes its origin permission (`forgetStation`).
- **Client stations config** (`src/config.ts`): the `clients.stations` section
  of the repository's `greenhouse.config.ts` is bundled at build time —
  `mode: 'multi' | 'single'`, `defaults: [{id, name, url}]` (OSS default:
  `multi`, `[]`). `defaults` are seeded, signed out, on the first read of a
  fresh install (no `stations` slot and no legacy `auth`), first one active;
  a registry the user emptied is not re-seeded. `single` locks the build to
  `defaults[0]`: `getStations()` re-locks the registry on every read (the
  entry with that origin keeps its session, anything else is dropped),
  `addStation` throws for any other origin, `removeStation` /
  `setActiveStation` are no-ops, and the options page / station menu hide
  add, remove and switch (the menu collapses to the station name, which opens
  the options page). A `single` config without exactly one default throws at
  module load — fail closed, same rule as the server-side schema.
- **Permissions**: keep the static permission set minimal (`storage`,
  `sidePanel`, `scripting`, `activeTab`, `tabs` — the last one powers
  `browser_list_tabs`/automation tab metadata). Host access is requested at
  connect time via `optional_host_permissions` — never add `<all_urls>` to
  `host_permissions`.
- **No resident content scripts.** Page context is read on demand with
  `chrome.scripting.executeScript` (`src/lib/page-context.ts`): the user's
  selection is the context (selection-as-context), full-page text only on the
  explicit "summarize page" quick action. It rides in `/api/chat`'s per-turn
  `ambient_context` envelope (`buildPageAmbientContext`: title → label, URL →
  route, selection or page text → hint), sized to the shared
  `AMBIENT_CONTEXT_LIMITS` so nothing is cut server-side, and never stored in
  the conversation.
- **The chat request has one builder and one contract.** `src/lib/chat-request.ts`
  (pure data) builds the body as the shared `ChatRequestBody` from
  `@greenhouse/types/api`; each turn gets a fresh scope id that the ambient
  context and the Client Actions share. `tests/browser/chat-contract.test.ts`
  runs these builders against the server's own admission code — change the
  shared types, never hand-write a field or a path. (The panel once kept
  sending `context_hint` / `omit_write_tools` and posting results to a renamed
  route for two months after the server contract changed; nothing errored.)
- **Sessions are server-side on the `'browser'` channel** (`src/lib/sessions.ts`):
  created lazily on first send via `POST /api/sessions {channel:'browser'}` (the
  only channel a client may ask for), listed with
  `GET /api/sessions?scope=mine&channel=browser` — the caller's own panel
  conversations, nothing from the sidebar folded in. The web app can continue
  them, read-only (see the write-back rule below).
- **Chat rendering reuses the shared kit** (`src/sidepanel/messages.tsx`):
  `StreamingMessageBubble` for the in-flight turn, `RichMarkdown` +
  `ToolCallRenderer` + `BodyArtifacts` for committed turns, with
  `MessageAttachments` below the prose for file and image results (file cards
  download through `src/lib/files.ts`, which attaches the station token and
  only fetches `/api/chat-files/`), stream accumulation via `handleStreamEvent`
  from `@greenhouse/types` (`src/sidepanel/use-chat.ts`).
- **i18n**: extension keys live in `src/i18n/{en,zh}.ts` (keep both in sync);
  they register through `registerCoreLocaleMessages` — same fallback chain as
  the web app.
- **Browser automation = client actions.** Every chat turn advertises the
  `browser_*` tool descriptors (`src/lib/browser-actions.ts`, pure data —
  descriptor-contract tests in `browser-actions.test.ts`) via `/api/chat`'s
  `client_actions` + `client_action_scope_id` (without the scope id the server
  registers none of them); the server pauses the agent step on a
  `local-tool-request` stream event stamped with that scope, the panel executes
  it (`src/lib/browser-tools.ts`, refusing a request from another turn's scope)
  then POSTs the result to `CLIENT_ACTION_RESULT_PATH`. Conventions:
  - Read/navigate actions (`list_tabs`, `open_tab`, `read_page`,
    `get_elements`, `scroll`, `wait`) run automatically. Write actions
    (`browser_click` / `browser_type`, the `CONFIRM_ACTIONS` set) go through
    the permission policy in `lib/automation-prefs.ts` — never route a write
    around it. The executor ALWAYS gathers danger signals + highlights the
    target, then calls the panel gate; the gate decides confirm vs auto-run:
    - **Ask** (default): confirm every write.
    - **Auto**: auto-run ordinary writes; still confirm DANGEROUS ones
      (password/payment field, form submit, sensitive-domain host — signals
      computed in `browser-tools.ts` + `isSensitiveHost`).
    - **per-site YOLO**: a host the user opted into runs everything without
      asking (overrides mode). Toggled from the header automation menu.
    - "Allow, don't ask again this site" grants are conversation-scoped (memory
      ref in `use-chat.ts`, cleared on new chat) — never persisted; only global
      mode + YOLO host set persist in `chrome.storage.local`.
    - `decideAction` is pure — keep the policy there and unit-tested
      (`automation-prefs.test.ts`), not scattered across UI.
  - Injected functions are serialized by `chrome.scripting` — they must be
    fully self-contained (no captured module scope). The element indexer pins
    live nodes on `window.__ghAgentElements`; navigation invalidates indices
    and executors return a stale-index error the model recovers from by
    re-listing. Top frame only (no iframe/shadow-DOM piercing) — known limit.
  - Element-list approach inspired by nanobrowser (Apache-2.0); independent
    implementation, no vendored code.
- **Knowledge write-back = a confirm-gated client action.** `save_to_knowledge`
  (`lib/knowledge-actions.ts`) is advertised alongside the browser actions, but
  it does NOT run in the page — its executor (`lib/knowledge-tools.ts`) POSTs to
  the confirm-gated agent proxy `/api/agent/tools/knowledge_mutation/call` with
  `confirm:true`. Every save shows a `KnowledgeConfirmCard` first (writes are
  never silent). It is the single write path: the server gives a
  `browser`-channel session no inline writer at all — only declared reads plus
  `ask_user` / `export_data` (`filterBrowserSessionToolIds` in
  `apps/api/src/agent-runtime/tool-resolution.ts`) — keyed on
  the session's channel, never on a flag the panel sends. Don't reintroduce a
  client-side "omit write tools" switch; a server that stops reading it hands
  every writer back silently, which is exactly what happened to the old
  `omit_write_tools`.

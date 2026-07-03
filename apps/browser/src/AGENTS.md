# apps/browser — Chrome extension (MV3)

Thin client of a **self-hosted Greenhouse instance**: the user supplies a base
URL + email/password in the options page; the agent brain, tools and knowledge
stay server-side. The extension only captures context, calls the API and
renders.

## Layout

```
public/manifest.json   # static MV3 manifest, copied verbatim into dist/
public/icons/          # app icons (16/32/48/128/512) rendered from assets/icon.svg
assets/icon.svg        # icon source — re-render PNGs with rsvg-convert on change
PRIVACY.md             # privacy policy (store listing requires a hosted copy)
sidepanel.html         # side panel entry (React)
options.html           # options page entry (React)
src/
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
- **Auth**: never store the password — only the `/api/auth/login` token pair in
  `chrome.storage.local` (`src/lib/storage.ts`, single `auth` slot). All token
  refreshes go through the background worker (`auth:refresh` runtime message)
  so rotation can't race between contexts. `authFetch()` retries once after a
  401-triggered refresh; on a dead refresh token the background clears the slot
  and every page falls back to the login flow via `storage.onChanged`.
- **Permissions**: keep the static permission set minimal (`storage`,
  `sidePanel`, `scripting`, `activeTab`, `tabs` — the last one powers
  `browser_list_tabs`/automation tab metadata). Host access is requested at
  connect time via `optional_host_permissions` — never add `<all_urls>` to
  `host_permissions`.
- **No resident content scripts.** Page context is read on demand with
  `chrome.scripting.executeScript` (`src/lib/page-context.ts`): the user's
  selection is the context (selection-as-context), full-page text only on the
  explicit "summarize page" quick action. Context rides in `/api/chat`'s
  per-turn `context_hint` — it is never stored in the conversation.
- **Sessions are server-side on the `'browser'` channel** (`src/lib/sessions.ts`):
  created lazily on first send via `POST /api/sessions {channel:'browser'}`,
  listed with `GET /api/sessions?channel=browser`. The web app can continue
  them; the panel's history list shows only this channel.
- **Chat rendering reuses the shared kit** (`src/sidepanel/messages.tsx`):
  `StreamingMessageBubble` for the in-flight turn, `RichMarkdown` +
  `ToolCallRenderer` + `BodyArtifacts` for committed turns, stream accumulation
  via `handleStreamEvent` from `@greenhouse/types` (`src/sidepanel/use-chat.ts`).
- **i18n**: extension keys live in `src/i18n/{en,zh}.ts` (keep both in sync);
  they register through `registerCoreLocaleMessages` — same fallback chain as
  the web app.
- **Browser automation = client actions.** Every chat turn advertises the
  `browser_*` tool descriptors (`src/lib/browser-actions.ts`, pure data —
  descriptor-contract tests in `browser-actions.test.ts`) via `/api/chat`'s
  `client_actions`; the server pauses the agent step on a `local-tool-request`
  stream event and the panel executes it (`src/lib/browser-tools.ts`) then
  POSTs `/api/client-tools/result`. Conventions:
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
  never silent). The chat request sends `omit_write_tools: true` so the inline
  `knowledge_mutation` (and other `MUTATING_PROXY_ALLOWLIST` tools) are stripped
  server-side — this client action is the single, always-confirmed write path.
  Do not remove `omit_write_tools`, or the model could write without a card.

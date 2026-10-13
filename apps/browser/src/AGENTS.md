# apps/browser: Chrome MV3 extension (Greenhouse Bridge)

A thin client: the side panel captures page context, calls the active station's API and renders the reply. Agent logic, tools and knowledge stay on the server.

## Build
- `pnpm browser:build` writes apps/browser/dist (load it unpacked in Chrome); `pnpm -F @greenhouse/browser dev` is a watch build with manual reload, no HMR; `pnpm browser:package` makes the release zip.
- Keep the product name identical in the manifest name, the options.title i18n key and options.html.
- Icons come from `python3 scripts/build-brand-assets.py`; never edit public/icons by hand.

## UI
- Take UI from @greenhouse/ui (atoms, markdown, blocks, tool cards, tokens, i18n); no zustand, no router; state lives in chrome.storage and React state.
- Add every string to both src/i18n/en.ts and src/i18n/zh.ts.

## Stations and auth
- The station registry lives in chrome.storage.local (src/lib/storage.ts); resolve the active station on every call, never cache it.
- Never store the password; keep only each station's token pair.
- Refresh tokens only in the background worker (the `auth:refresh` message), single-flight per station, so rotation cannot race between contexts.
- A dead refresh token clears only that station's auth and keeps the entry.
- Key chat state by station id so switching stations remounts it.
- Single-station builds (clients.stations in the root greenhouse.config.ts, bundled by src/config.ts) are locked inside storage.ts, not only in the UI; a single config without exactly one default must throw at load.
- Probe a server with the public GET /api/bootstrap; the API no longer serves /api/auth/status, which checkServer in src/lib/auth.ts still calls.

## Permissions and page context
- Keep static permissions to storage, sidePanel, scripting, activeTab and tabs; request hosts through optional_host_permissions and never add `<all_urls>` to host_permissions.
- No resident content scripts: read the page on demand with chrome.scripting.executeScript (src/lib/page-context.ts).
- Send the selection as context; send full page text only for the explicit summarize action.
- Page context rides in the per-turn ambient_context, sized to AMBIENT_CONTEXT_LIMITS, and is never stored in the conversation.

## Chat contract
- Build /api/chat bodies only in src/lib/chat-request.ts as the shared ChatRequestBody and post action results to CLIENT_ACTION_RESULT_PATH; never hand-write a field or path. tests/browser/chat-contract.test.ts runs them against the server's admission code.
- Declare rich_blocks as RICH_BLOCKS_DRAWN; never declare a block the panel cannot draw.
- Panel sessions use channel 'browser' and list with scope=mine.
- Download files only through src/lib/files.ts, which attaches the station token and fetches nothing but /api/chat-files/.
- Cards and in-app links open in the active station's web app (AppLinkOriginContext); never navigate the panel itself.

## Browser automation
- Browser actions are client actions: descriptors in src/lib/browser-actions.ts, executors in src/lib/browser-tools.ts; refuse a request from another turn's scope.
- Read actions run automatically; click and type (CONFIRM_ACTIONS) always pass through decideAction in src/lib/automation-prefs.ts. Never route a write around it.
- Keep the permission policy in decideAction, pure and unit-tested.
- Per-site "don't ask again" grants last for the conversation only; persist only the global mode and the YOLO host list.
- Functions passed to chrome.scripting are serialized: keep them self-contained, with no captured module scope.
- Automation reaches the top frame only; no iframe or shadow DOM piercing.

## Knowledge write-back
- save_to_knowledge is the only write path: show the confirm card, then call the confirm-gated agent proxy (src/lib/knowledge-tools.ts).
- The server gives 'browser' channel sessions no inline write tools, keyed on the stored channel; never add a client-side flag to omit write tools.

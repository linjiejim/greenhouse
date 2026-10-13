# apps/web rules

The v2 web app. Product scope is docs/product/prd.md §6–7; layout and components follow docs/design-system/. Components come from the kit (@greenhouse/ui/kit); this app only composes pages.

## Layout
- src/app: the session (tokens, the signed-in member, realtime, theme, language), sign-in gate and toasts.
- src/lib: the API client instance, the browser token store, hash routes (router.ts is the route table of PRD §6.4), the dictionary, times, media queries.
- src/data: TanStack Query hooks per domain, query keys (query.ts), realtime events into the cache (realtime.ts) and the store for replies being written (streams.ts).
- src/shell: rail, directory, page frame, ⌘K, drawers opened by request (overlays.tsx). src/conversation: thread, messages, composer, cards. src/pages: one folder per module.
- src/i18n: zh.ts is the source dictionary; en.ts must have the same keys. Every word on screen comes from there.

## Rules
- Server state lives in the query cache; realtime events patch it (messages, conversation flags) or mark queries stale. Never keep a second copy in component state.
- Streaming text never goes through the cache: streams.ts holds it per message and joins it to the saved partial text by offset.
- The API client (@greenhouse/contract/client) is the only way to the server. Its errors are ApiClientError; branch on `code`, show the dictionary's words.
- Hide what this member cannot use: modules from me.modules, configured capabilities from me.capabilities (no computer entries without sandbox, no voice without STT).
- Styles: src/styles/app.css for app layout only, tokens only. Anything reusable belongs in the kit.
- Status words and tones follow docs/design-system/content.md; pass `tone` to StatusBadge (the kit only knows the Chinese words).
- A mutation whose callback navigates or closes an overlay uses mutateAsync or runs in a component that stays mounted: useMutation callbacks are dropped after unmount.
- The workspace remounts when the page or the object it shows changes (the Shell's ErrorBoundary key is page and id), not when only its query parameters change; tab and scope changes re-render the page with new props.

## Tests
- Unit tests next to the code in __tests__ (vitest unit project).
- Browser tests are e2e/*.e2e.ts (not *.spec.ts, which vitest would collect): `pnpm test:web-e2e`. They reset the database named by E2E_DATABASE_URL (default greenhouse_v2_e2e on 127.0.0.1:55432; names must end in _e2e), start e2e/fake-llm.mjs, the API and Vite on 4590–4592, and sign people in once (e2e/auth.setup.ts) because sign-in is rate limited. When another run holds those ports, E2E_WEB_PORT, E2E_API_PORT and E2E_LLM_PORT with another E2E_DATABASE_URL run beside it.
- e2e/fake-llm.mjs answers by the member's words: "slow …" streams for seconds, "ask me …" asks a question, "remember X" stores a memory, "need a human …" asks for a take-over, "show chart|table|…" sends a rich block, anything else echoes.
- The same server is the connectors' MCP servers (e2e/fake-mcp.mjs, allowed because the e2e API runs in development): /mcp/open needs nothing, /mcp/key wants X-Api-Key e2e-good-key, /mcp/signin wants a sign-in at /fake-oauth, which approves at once. e2e/api.ts calls the API as a saved person and plays an outside app (register, authorize, trade a code, call /api/mcp).
- In browser tests computers are on but their image cannot be pulled, so none starts; uploads go to a temp folder.
- `sh apps/web/e2e/stack.sh` starts the same stack on 4580–4582 for looking at the app by hand (the "web-v2" preview). STACK_SANDBOX_IMAGE=greenhouse/bot-computer:latest gives it real computers ("web-v2-computer"); remove their containers and volumes (gh-cmp-*) afterwards, since every start reseeds the database.

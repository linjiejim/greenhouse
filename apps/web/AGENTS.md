# apps/web rules

The v2 web app. Product scope is docs/product/prd.md §6–7; layout and components follow docs/design-system/. Components come from the kit (@greenhouse/ui/kit); this app only composes pages.

## Layout
- src/app: the session (tokens, the signed-in member, realtime, theme, language), sign-in gate and toasts.
- src/lib: the API client instance, the browser token store, hash routes (router.ts is the route table of PRD §6.4), the dictionary, times, media queries.
- src/data: TanStack Query hooks per domain, query keys (query.ts), realtime events into the cache (realtime.ts) and the store for replies being written (streams.ts).
- src/shell: rail, directory, page frame, ⌘K, drawers opened by request (overlays.tsx). src/conversation: thread, messages, composer, cards. src/pages: one folder per module.
- src/pages/knowledge: the 知识库 module. Its directory tree (scope and open folders in scope.ts), folder and doc pages, the editor around @greenhouse/knowledge-editor/editor, item menus (actions.tsx: one list for a row's right-click and the page's "⋯"), dialogs, drag and drop (dnd.ts) and plain rules (helpers.ts).
- src/i18n: zh.ts is the source dictionary; en.ts must have the same keys. Every word on screen comes from there. A large module keeps its words in <module>.zh.ts and <module>.en.ts, spread into both (tables and mail do).
- src/styles: app.css for the app's layout; a module's own styles in <module>*.css, imported by its pages (tables.css, tables-boards.css, tables-timeline.css).

## Rules
- Server state lives in the query cache; realtime events patch it (messages, conversation flags) or mark queries stale. Never keep a second copy in component state.
- message.resumed clears the live suffix and truncates a streaming cached reply to its completed offset before continuation. The small event crosses replicas even when the full prefix needs resync; never truncate an already complete reply.
- Streaming text never goes through the cache: streams.ts holds it per message and joins it to the saved partial text by offset.
- A conversation that missed events catches up with `?after=` (realtime.ts `catchUp`): on `conversation.resync`, and after a reconnect for the conversations on screen. A reconnect refetches only those conversations' own queries and the notification unread badge, and marks every other query stale; never refetch everything at once (a server restart reconnects every client together).
- Catching up never removes what arrived after the answer it got, and never takes a finished reply back to a partial one.
- The API client (@greenhouse/contract/client) is the only way to the server. Its errors are ApiClientError; branch on `code`, show the dictionary's words.
- In the desktop app (lib/desktop) the API is cross-origin: fetch and src/href/poster attributes are rewritten for you, but a URL handed to a detached link or window.open goes through apiUrl first.
- An unlocked desktop app asks for its server on first launch or when it cannot reach it, and 设置 → 桌面端 changes it: check /api/bootstrap first, then switchServer signs out and restarts. Show none of it when apiBaseLocked.
- Hide what this member cannot use: modules from me.modules, configured capabilities from me.capabilities (no computer entries without sandbox). Voice falls back first: the microphone uses the STT service when me.capabilities.stt, else the browser's recognition, else it is hidden; read-aloud uses TTS, else speechSynthesis, else it is hidden.
- Voice input (conversation/voiceInput.ts) puts the words where the caret was and never sends them; Esc cancels. Read-aloud (conversation/readAloud.ts) reads one reply at a time and stops when the conversation is left; it speaks speechText (lib/speech.ts), never raw Markdown, in parts of at most SPEECH_TEXT_MAX.
- Styles: src/styles/app.css for app layout only, tokens only. Anything reusable belongs in the kit.
- Status words and tones follow docs/design-system/content.md; pass `tone` to StatusBadge (the kit only knows the Chinese words).
- A mutation whose callback navigates or closes an overlay uses mutateAsync or runs in a component that stays mounted: useMutation callbacks are dropped after unmount.
- The workspace remounts when the page or the object it shows changes (the Shell's ErrorBoundary key is page and id), not when only its query parameters change; tab and scope changes re-render the page with new props.
- Doc Markdown outside the editor (doc page, versions, comments) renders only through pages/knowledge/render.ts: its own DOMPurify instance; links open only http(s), mailto and `#/` routes; pictures only from /api/files or the web; no styles, classes or ids.
- Mail HTML renders only through sanitizeMail (conversation/MailDrawer.tsx): its own DOMPurify instance; no styles, forms, frames or media; links only http(s) and mailto, opened outside; remote images only after the member asks; `cid:` images through their signed file links.
- A doc save sends the version the edit started from, and the body only when the editor changed it. On 409 `stale_version` the page says who saved and when and lets the member reload or save anyway; never retry with the new version on its own. A refresh that fails keeps the doc and the draft on screen.
- A page with unsaved work calls holdNavigation (lib/router.ts): links, navigate(), Back, Forward and closing the tab ask it first. It leaves with leaveTo(attempt), which goes back through history after Back or Forward.
- The knowledge lists live under the `knowledge` query key: `knowledge.changed` refetches them all. A doc and what hangs off it live under `docs`. Folders, space roots and the archive come a page at a time (useFolder, useKnowledgeRoots, useArchived are infinite queries); lists end with 显示更多 while there is a next page, and cached folders are read with cachedFolder.
- Put kit pickers (Select, MultiSelect) in a FieldGroup, not a Field: Field's <label> re-activates the trigger after a pointer pick and the list opens again.
- A button that becomes another button in place (编辑 → 保存) gets its own key: React reuses the element, and one that turns into a submit while its click runs submits the form.
- Tables: a view's records are one query per view settings (useViewRecords, every page up to MAX_VIEW_RECORDS); writes put the server's records into every cached view of the table (putRecords) and records.changed refetches only views that are behind. Grid and timeline draw only the rows in view: 1000 records must scroll smoothly.
- Apps: src/pages/apps composes the kit and table fields/charts. Runtime queries and actions go through client.apps with the published version, never direct record writes; builder drafts hold navigation and save with their original revision.
- Tables: computed fields use the contract catalog and references; never send them in record edits, paste or clear. Compare both revision and computed_revision in realtime and cached writes. Custom readers edit only tables with access=edit; render only the fields/records the API returns. Owners manage custom roles with the existing filter editor. Non-builders can create personal dashboards from tabs. URL cells link only http(s); encode the entire email address in mailto.
- Tables: draft overlays use useDraftNavigation over holdNavigation; Back, Forward and links ask before discarding.
- Tables: a view's save queue holds pending configs as drafts against base refetches. Start with the viewed revision, then each save's returned revision; on conflict abandon that view's remaining queue.
- Tables: what a view works out (columns, groups, spans, days) lives in model.ts, boards-model.ts and timeline-model.ts with unit tests; components draw and handle input.

## Always-on
- Write receipts render from write_receipt message events; only their acting member sees Undo. Server conflicts preserve later edits.
- Standing scopes are chosen on tier2 cards only, listed by name/actions in Abilities and revoked through the contract client. Disable approval while batch_ready is false.
- Run proposals show declared computer/domain access and optional completion follow-up. Schedule quiet defaults off; event messages remain quiet thread lines.

## Tests
- Unit tests next to the code in __tests__ (vitest unit project).
- Browser tests are e2e/*.e2e.ts (not *.spec.ts, which vitest would collect): `pnpm test:web-e2e`. They reset the database named by E2E_DATABASE_URL (default greenhouse_v2_e2e on 127.0.0.1:55432; names must end in _e2e), start e2e/fake-llm.mjs, the API and Vite on 4590–4592, and sign people in once (e2e/auth.setup.ts) because sign-in is rate limited. When another run holds those ports, E2E_WEB_PORT, E2E_API_PORT and E2E_LLM_PORT with another E2E_DATABASE_URL run beside it.
- e2e/fake-llm.mjs answers by the member's words: "slow …" streams for seconds, "ask me …" asks a question, "remember X" stores a memory, "need a human …" asks for a take-over, "look up …" searches the knowledge base and links the first doc, "keep a note …" writes a doc into the Agent's own folder, "show chart|table|…" sends a rich block, "reply to the mail …" replies to the newest mail in the thread, "check my mailbox …" searches the member's mailbox connector, anything else echoes. Woken by mail, it reads the mail and says its subject.
- The same server is the connectors' MCP servers (e2e/fake-mcp.mjs, allowed because the e2e API runs in development): /mcp/open needs nothing, /mcp/key wants X-Api-Key e2e-good-key, /mcp/signin wants a sign-in at /fake-oauth, which approves at once. e2e/api.ts calls the API as a saved person and plays an outside app (register, authorize, trade a code, call /api/mcp).
- It is also Resend and a member's mailbox (e2e/fake-mail.mjs): Resend under /resend with key re_e2e_0123456789, /resend/_inbound to "receive" a mail and /resend/_sent for what went out; an IMAP and SMTP mailbox (e2e/fake-mailbox.mjs) on the ports /mailbox/_ports gives. e2e/mail.e2e.ts signs Resend's notices itself and removes the mail service when done.
- In browser tests computers are on but their image cannot be pulled, so none starts; uploads go to a temp folder.
- The fake model rejects tool parameters without a root object and properties, or with root anyOf/oneOf/allOf, like strict real providers. Keep this gate when adding scripted replies.
- `sh apps/web/e2e/stack.sh` starts the same stack on 4580–4582 for looking at the app by hand (the "web-v2" preview). STACK_SANDBOX_IMAGE=greenhouse/bot-computer:latest gives it real computers ("web-v2-computer"); remove their containers and volumes (gh-cmp-*) afterwards, since every start reseeds the database.

- Publish knowledge grants with the owner's personal folder tree, excluding Agent reference folders. Helper runs render inside their parent process card; completion logs have a separate group on the Agent memory page.

- Tables: record handoffs select an owned Agent and brief; automation editors use the shared filter editor and hold navigation. Run history opens the linked Agent run; both record and automation runs are labelled Tables.

- ⌘J/Ctrl+J opens PageConversation with a server-resolved page reference. Reuse ConversationPage and the kit Overlay; chats remain in the conversation list.

- Artifact result cards use signed file URLs, fetch before counting a successful download, and save through client.media to knowledge. Hide Save when knowledge is disabled. Video progress and files come from the run detail.
- Admin usage shows count-only UTC weekly metrics; zero denominators are unknown, not zero. Interjection event state labels are server-owned.

- A message-page fetch preserves realtime rows that arrived after its snapshot and completed replies, and takes on updates and deletions of its own rows that arrived while it was on its way. Receive events while that query is fetching, even before its first page exists.

- Published Agent budgets use the shared usage facts and UTC month; owners edit them on Publish, admins on Public Agents.
- Directory filters stay local to a module and filter loaded entries; arrows move between results, Enter opens and Escape clears then closes.
- A page takes focus on open only when lib/focus focusUnclaimed allows it: never from where the member moved while it loaded. Directory rows carry data-row-key (href, else title); a refresh that moves or remounts the focused row gives focus back to the same key.
- Extension pages/sections/panels render only when the authenticated manifest declares them; only extensions/index.ts imports concrete extensions.
- Computer fullscreen reuses the mounted viewer in pages and drawers. Only control canvases capture keys; host shortcuts and drawer Escape do not receive those keys. Queued computers poll their position.
- Custom app frames use the platform double srcdoc wrapper, sandbox=allow-scripts only, source-checked JSON-RPC and declared read bindings. Unapproved versions show a placeholder; external card results render as text/chart data. Admin code review is in the app center.
- Lists own their create action; do not repeat it in both the directory and header/empty state. Knowledge's directory keeps the secondary creation menu because it also creates folders.
- Base refetches compare view revisions at response time so a delayed response cannot replace saved settings. Floating panels containing fixed pickers use opacity-only entry animations.
- `node --import tsx apps/web/e2e/capture-v2.mts` seeds a Chinese product launch through the local fake stack and captures focused light/dark components at 2× device scale (conversation and tables keep their window); STACK_WEB_PORT selects it. Published WebP pairs go to docs/assets/v2; the review manifest and full PNGs go to artifacts/t10. It refuses remote model endpoints, placeholders and incorrect Han/Latin/digit spacing, and requires cwebp.

- Route pages and rich charts/diagrams/computer viewers load through Suspense with kit skeletons that preserve their frame. Keep heavy modules out of the entry static graph; after `pnpm web:build`, run `node scripts/check-web-bundle.mjs` (entry budget 350 KB).

- Approval details render server-owned human text. format=markdown uses the text-only MarkdownPreview allowlist (no images, links or controls), with a short clamp and Expand. chips carry option labels; preserve the same words as value for native readers. Run step labels use summary, never tool ids.
- Same-turn/table receipts list writes in one card; their step_id undo endpoint handles the full batch. Hide repeated base/table subtitles when there is one same-name table.

- Consume only the submitted composer snapshot; serialize subsequent sends and retain newer drafts. Enter selects mentions or waits for candidates, including before the popup loads. Room faces come from the permission-checked roster. Rich object headers may wrap; inspect 390 px screenshots.

- Empty active runs use the server recent_finished preview, ordered by actual completion time, rather than slicing the newest-created finished page.

- Realtime debounce timers belong to each QueryClient. Dictionary interpolation uses @greenhouse/utils/i18n (the canonical helper also vendored by mobile): add one space at Han/Latin-or-digit boundaries even without template spaces, join adjacent Han runs, and retain deliberate separators between two values. Upload inputs mount only when their destination is loaded and editable. Header geometry uses the canonical header-height token, including Suspense frames.

- Operational pause errors use errorText with details.switch so computer, background-run and outbound-mail reasons follow the member's language.

- Memory rule refusals keep stable codes (memory_background_read_only / memory_untrusted_content); run-step errors use the dictionary mapping and never suggest retrying the refused write.

- Conversation identity: Agent author rows are room-only; place avatar/name above full-width text. Reply actions use one accessible Menu, named message.actions. Single-field ask_user choices (1–6 options) answer inline with the original answers payload; other question forms use a guarded Overlay with OverlayActions.
- Overlay portals mount at the nearest whole-frame floating boundary, so page positioning never limits the scrim. Use the shared lib/useDraftNavigation for form guards. Segmented changes views (up to four short choices); Tabs changes page sections.
- Reactions are chips under member messages from message.updated; todo blocks reuse the process card and run detail. Generated files use existing signed attachment downloads.

- Notifications have one list. notification.removed drops a request pointer immediately; request.updated refreshes its conversation badge and cards. Superseded/withdrawn cards collapse; replacements link to the new card.

- Browser approval checks use sendForRequest to await a committed pending-request response before asserting its rendered details; receipt checks await the turn settling. Keep UI assertions independent of backend execution latency.

- Form overlays reuse lib/useOverlayDraft for close, Escape, scrim and route guards. Call saved() before a successful save navigates; cancellation asks before discarding. Inline app and table forms hold navigation until submission succeeds.
- Process tone follows the containing reply/run outcome; a successful reply may retain neutral failed steps. Agent capability lists use dictionary action names; never render tool ids. Schedule copy comes from @greenhouse/utils/cron.

- Settled request cards default to one expandable header; answered inline choices keep their selected label in that summary. Read old previews and answers by expanding it. Dangerous approvals use the server danger marker and human action copy.

- Screenshot capture also publishes approvals, receipts, populated rooms, schedules, connections and services. SCREENSHOT_COMPUTER=1 opts into a real local computer image; capture opens a Chinese release checklist in its real browser and waits for the screen. Set FAKE_LLM_CAPTURE_FIXTURE to the same local JSON path for stack.sh and capture-v2.mts; the capture writes fixed replies there, leaving normal browser tests unchanged. SCREENSHOT_REVIEW_DIR holds PNGs and manifests together (default artifacts/t10/after); restart the sample stack before rerunning.

- Plant avatars use the shared V2 controller and stateForWork mapping. Keep directory rows animate=false and one-to-one replies avatar-free; live state belongs in the header and existing room author row.

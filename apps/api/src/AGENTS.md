# Backend API rules

## Scope

- Covers `apps/api/src` (Hono core, runtime, CLI); shared rules: [root AGENTS.md](../../../AGENTS.md); plugin contract: [EXTENDING.md](../../../EXTENDING.md).
- DB rules: [packages/db/src/AGENTS.md](../../../packages/db/src/AGENTS.md); profiles: [profiles/AGENTS.md](./profiles/AGENTS.md) and [agent-profiles.md](./profiles/agent-profiles.md).
- Plugin internals live in `plugins/<id>/AGENTS.md` (e.g. [memory](../../../plugins/memory/AGENTS.md), [computer](../../../plugins/computer/AGENTS.md)); core consumes their registries only.
- Never import plugin source from core, branch on a plugin id or describe plugin internals in this file.

## Routes, typing and logging

- Server code logs with `logger.info/warn/error` (`@greenhouse/utils/logger`) plus an optional data object; never `console.*` outside CLI output in `cli/`.
- Each route file starts with an endpoint comment block (method, path, purpose); one resource per file under `routes/`.
- Define routes as one chain, `new Hono<AppEnv>().get(...).post(...)`; statement-style `x.get(...)` drops endpoints from `AppType`, and factories never declare a `: Hono` return type (it erases the schema).
- Responses never contain `any`: one `any` field collapses the inferred response to `never`; give raw SQL rows a shape before `c.json()`.
- `mountRoutes()` in `index.ts` is the single mount chain and its order has security meaning (OAuth first, public callbacks before wildcard role guards); never reorder.
- `export type AppType` (`index.ts`) is the typed route contract; no client consumes it through a contract package today, but keep it compiling rather than adding parallel types.
- `/api/x/*` does not match the bare `/api/x`: guard both, mount writes on a sub-path, or put `.use('*', requireInternal())` inside the router (search, refs, people, activity do).
- Public paths are `PUBLIC_PATHS`/`isPublicPath` (`auth/middleware.ts`) plus plugin `publicPaths`, each with a reason; `/api/mcp…` and `/api/gateway…` are owned prefixes no other route may use.

## Async safety and streaming

- WS and timer callbacks never leave unhandled rejections (`@hono/node-server` does not await `onOpen/onMessage/onClose`, nor does `setInterval(() => void x())`): try/catch and `logger.warn` inside, or Node exits.
- `/api/ws` closes with 1011 when the account lookup fails (clients back off and reconnect); 4001/4002/4003 are reserved for auth and terminal states.
- Long streams need heartbeat and upstream limits: `chat/turn.ts` pings every `STREAM_KEEPALIVE_MS` (15s) with `X-Accel-Buffering: no`; agent-core `CHAT_STREAM_TIMEOUT` bounds total, step and chunk time.
- The no-chunk timeout also covers local tools, so it stays above slow ones such as image generation (30–100s).
- Pings are per-connection filler outside the run buffer: never buffered, replayed or persisted. AI SDK timeouts arrive as `abort` parts, not `error`; both take the interrupted path.
- On interruption strip unclosed chart/confirm/datatable fences, persist the safe partial text plus a retry hint, then end the response; a refresh never erases the turn.
- Interruption copy is a generic retry notice except budget refusals (`usageBudgetNotice`, walking the `cause` chain), whose text goes to both the stream and the persisted message.

## Chat runs

- One generation = one in-memory `ChatRun` (`chat/runs.ts`); `pumpChatTurn` (`chat/turn.ts`) runs detached and the POST response is subscriber 0; multi-instance deployment needs a redesign first.
- Layers are fixed: `routes/chat.ts` adapts (auth → tools → start run → subscribe), `chat/turn.ts` pumps, `chat/persist.ts` persists; never move the loop into the route.
- Reconnect via `GET /api/chat/runs/:sessionId/stream?after=seq` (replays carry `replayed: true`); the envelope and `ChatRunStatus` live only in `@greenhouse/types/api`.
- One turn per session: claim before persisting the user message (duplicate POST → 409), release the claim if a later precheck fails, and persist before `finish(run)` (stream close means "safe to refetch").
- Server stop and SIGINT/SIGTERM (`chatRunRegistry.shutdown()` before `db.close`) take abort → interrupted persistence; WS `chat:run` pushes ids and status only, to the owner.
- In `RATE_LIMITS` `/api/chat/runs` stays above `/api/chat` (first prefix match wins), or reconnects and probes eat the message budget.
- `client_turn_id` (8–64 `[A-Za-z0-9_-]`) dedupes resends: a known id is 409 `duplicate_turn` + `message_id`, nothing saved or run (`sessions.addUserTurn`, `uq_messages_session_client_turn`).
- `routes/chat.ts` never imports `tools/registry.ts` (it loads every active plugin's tools at import; chat route tests mock `agent-runtime/tool-resolution`); tool-metadata logic lives in `tool-resolution.ts`.

## Chat request and ambient context

- `ChatRequestBody` (`@greenhouse/types/api`, exhaustive `CHAT_REQUEST_BODY_KEYS`) is the only body definition; delete fields the server stops reading so stale clients fail to compile.
- Admission lives in `chat/turn-environment.ts` (`admitTurnEnvironment`) with shared `AMBIENT_CONTEXT_LIMITS`; Client Action results use `CLIENT_ACTION_RESULT_PATH` under `CLIENT_ACTIONS_API_PREFIX`.
- `ambient_context` is an optional per-turn page reference: never persisted, not user intent, no profile/tool/platform/record/field grant; `chat/ambient-context.ts` validates it and drops invalid context silently.
- Its fixed prompt says it may be stale or irrelevant and is not a request or authorization; use it only when it relates to the message, ask when ambiguous.
- Client Actions require `client_action_scope_id` (must equal the context scope, else no UI tools; the client fails closed); they only read, navigate and fill, while data writes stay on server tools and confirm gates.
- `channel='browser'` history sessions get a fail-closed face (`filterBrowserSessionToolIds`: proxy-read tools plus `ask_user`/`export_data`, never `mcp_call`), keyed on the stored channel, never a request flag.

## Chat context and digest

- `windowMessagesByBudget` drops the oldest whole messages before the call (newest kept, transcript untouched); budget = `resolveHistoryBudget(model)` = `context_window` × `compaction_threshold` (0.5 default, ≤0.9).
- Declare the smallest `context_window` in the provider chain; undeclared models get `HISTORY_TOKEN_BUDGET` (80k); a sliding window breaks the prefix cache, so fold into the digest rather than widen it.
- The system prompt holds only session-stable content (profile, user notes, plugin prompt context, tool guidance, language, digest); `buildSystemPromptWithUserNotes` is the only assembler.
- `routes/__tests__/chat-prompt-cache.test.ts` pins a byte-identical system prompt across turns; never add per-turn content to it.
- Per-turn content (time, ambient context, image and UI-action notes) is a tail block on the last user message (`chat/turn-context.ts`), sent to the model, never persisted.
- History rendering is a pure function of the transcript (`injectTimeContext` uses each message's own `created_at`; image hints on every image message); traces record exactly what the provider received.
- `chat/digest.ts` folds everything before the last two exchanges once unfolded history passes `resolveDigestTriggerTokens(model)`: ≤24k tokens/pass, nothing under 4k, ≤3 passes, owner's budget, warn-only failures.
- Digest: headings Goals / Decisions / Facts / Open items / Artifacts, ≤6000 chars, `sanitizeForPrompt` before injection; messages with `seq ≤ digest_upto_seq` leave the prompt; list reads exclude `digest`.
- `db.sessions.advanceDigest` only moves forward by compare-and-set; editing, truncating or rewriting folded messages clears the digest in the same transaction; forks inherit it only when the copy covers the folded range.
- `session_query` `conversation_search` retrieves folded details by jieba-segmented substring match (AND first, OR fill, single-char terms not in OR).

## Sessions and personal scopes

- `GET /api/sessions` without `scope` keeps the default view (super all, team own + shared backfill), pages ≤200; `scope=team` is 403 for non-super, never an empty list.
- `scope=shared` and unscoped backfill share `db.sessions.listSharedWith()` (EXISTS, not join); `exclude_channel` stacks on the default `workflow` exclusion; pin backfill only for `mine`/unscoped.
- `excludeUserId` uses `IS DISTINCT FROM` (`conversations.user_id` is nullable); `owner_nickname` attaches whenever owner ≠ requester (`withOwnerNicknames`), never per scope.
- `POST /api/sessions` ignores a client `channel`; channel-filtered lists return only the caller's sessions; retired `mission`/`workflow` sessions are read-only (`/api/chat` 409).
- `conversations.sharing` (greenhouse.config.ts, default true) false disables share mutations and routes, returns empty share lists and ignores stored shares without deleting them.
- Personal assets use exclusive Mine / Shared / Team tabs, Team super-only (`/api/prompts?scope=team` 403 for members); admin cross-user views are not "shared"; automations have no Shared set.

## Auth, accounts and preferences

- Auth code lives in `auth/`; internal CLI/server self-calls use a real current team/super access token, never a synthesized `internal` user or skipped DB check.
- `assertAuthEnv()` at startup requires `TOKEN_SIGNING_KEY` (64 hex chars, no fallback) everywhere; `authMiddleware` always requires a named internal account's Bearer, with no dev or anonymous bypass.
- Every request rereads status, role and `auth_version` (deleted, disabled, `external`, pre-reset tokens fail); refresh tokens are versioned and single-use; resets bump and revoke in one transaction.
- Those contracts are pinned by `tests/api/token.test.ts`, `auth/__tests__/internal-only.test.ts` and `routes/__tests__/auth-version.test.ts`.
- Only super issues invite/reset links; the public surface is exactly `POST /api/auth/password-link/{inspect,complete}` with 4KB bodies, IP + token-hash limits, one invalid error and `no-store`.
- Link tokens match by hash; inspect never consumes; complete consumes once under a DB lock; a reset sets `reset_required` and `suspendUserRuntime` stops chat, WS and automations (cleanup failures only log).
- Feature gates use `userHasFeature` (role, defaults, grants), never a raw `user_features` read.
- `/api/me/preferences` writes `users.preferences` (`FONT_SCALES`, unknown keys 400) via `db.users.mutatePreferences()`; per-Agent plant avatars live in `oauth_grants.avatar`.

## Security and network

- Model-bound user input passes `sanitizeForPrompt()` (`security/security.ts`, 8000 chars), the shared floor for every prompt string: never give it an opt-out mode; log injection attempts with `checkPromptInjection()`.
- Rate-limit only via `checkRateLimit(key, windowMs, max)` (epoch windows in `rate_limits`, atomic upsert, shared across restarts/instances); `matchRateLimit` checks plugin `rateLimits` first; `/api/auth/me*` is unthrottled.
- Rate limiting is fail-open on purpose (allow and warn ≤1/min); never make it fail-closed or wrap it in route try/catch.
- Client IPs come only from `security/request-ip.ts`: the socket peer; `X-Forwarded-For`/`X-Real-IP` count only from loopback or `TRUSTED_PROXY_IPS`.
- Uploads verify MIME with `validateMagicBytes()`; never `fetch()` a model-supplied URL directly.
- Images via `fetchPublicImage()` (`security/network.ts`): public HTTPS, connect-time DNS check, per-hop redirect check, size cap, magic bytes.
- Pages via `fetchPublicPage()`: http(s), no credentials or non-public literals, connect-time DNS check, manual per-hop redirects, streamed truncation; `assertSafePublicPageUrl()` prechecks without fetching.
- With an undici `dispatcher`, import `fetch` from the same `undici` package (Node's built-in fetch rejects it as an opaque `fetch failed`); tests mock undici's `fetch` or `fetchPublicImage`.
- CSP `connect-src` allows `https://*.myqcloud.com` because authenticated downloads 302 to presigned URLs (`security/headers.test.ts`; the Expo dev server sends no CSP, so only a deployed API reproduces it).

## Uploads and storage

- `storage/uploads.ts` is the only storage layer (chat and generated images, Files objects); never touch disk or the object store directly. `storage/s3-lite.ts` is a standalone signer that uploads do not use.
- Backend: Tencent COS when `TENCENT_CLOUD_COS_SECRET_ID/SECRET_KEY/BUCKET/REGION` are all set, else local `data/uploads` (single host only); `getUpload` falls back to disk on a COS 404.
- `putUpload/getUpload` accept only server-made flat image ids (`timestamp + full UUID`; legacy 8-hex ids read-only) and check path, size and magic bytes; tools never join `UPLOADS_DIR`.
- `TENCENT_CLOUD_COS_PREFIX`/`_DRIVE_PREFIX` pass `normalizeKeyPrefix()` at module load (bad values fail boot); never make them lazy. Generated images use the fixed `generate/` prefix.
- Changing a prefix orphans every object (key = prefix + id): inventory `messages.content`, `messages.parts` and plugin rows embedding `/api/upload/<id>` first.
- `GET /api/upload/:id` is the public read proxy (`<img>` sends no Bearer); `POST /api/upload` stays internal and the exemption never covers list or delete.

## Files and attachments

- Files (`/api/drive`, `files_*`) is core; `cabinetDriveScope()` uses a plugin cabinet (Knowledge `kb`) when active, else core scope `drive`; `drive/kb-cabinet.ts` is the agent-facing implementation.
- Every node passes `resolveDriveAccess`; moves stay in one cabinet (`sameDriveCabinet`); renames rerun `validateDriveUpload`; agent uploads ≤5MB; download links only with an object store.
- Drive writes record platform audit after success (`drive/audit.ts`, `app_id='drive'`); audit failure only warns.
- `POST /api/chat-files/upload` takes any type (≤100MB, 5GB per member); only the session owner uploads; share recipients read through `GET /api/chat-files/:id/content` (presigned 302, `no-store`).
- Only images use the public `/api/upload` exemption (`routes/__tests__/attachment-boundary.test.ts`); the chat-files upload sits at `/upload` because `/api/chat-files/*` misses the bare path.
- The attachments fence is sanitized apart from the body (`sanitizeUserMessageForPrompt`: `splitAttachments()`, normal body truncation, fence reprojected to its three contract fields).
- `read_attachment` is session-scoped (the session is the authorization); it reads text/CSV/JSON/xlsx/docx and text-layer PDFs; images, media, archives and >10MB files get an explicit error.
- `files/conversation-files.ts` resolves both stores (session `files` rows, then images in this transcript); file bytes via `getObjectAtKey`, image bytes via `getUpload`; never add `files` rows for images.
- `normalizeFileRef` normalizes every model-written image ref; `analyze_image` checks flat storage first (`isValidUploadId`), then session files, returning `not_an_image` for files.
- `files/extract-text.ts` is the only bytes→text path: reasons only (`unsupported`/`encrypted`/`no_text_layer`/`extract_failed`), UTF-16 aware, never NUL; callers add hints that name real exits.
- Dynamic `import()` of a CJS package uses `default` (`resolveWorkbookCtor()`); vitest interop hides this, so check with real Node. PDFs use `unpdf` text layers only, never rendering or scripts.

## Saved prompts

- Saved prompts are core (`prompts`, `db.userPrompts`, `/api/prompts`); `task_capture` only drafts (in `DISPATCH_TOOL_IDS`) and the card's Create calls `POST /api/prompts` with the member's Bearer.
- Cards save exactly once: `artifact_action_id` + `artifact_session_id` claim `card_action_receipts` (one without the other is 400); `expected_tools` comes from real calls (`toolsUsedIn`) and grants nothing.
- Declared variables must match `{{placeholders}}` in the body being saved (`validateVariables`, create and update); unfilled placeholders stay literal.

## Automations

- Definitions live in `automations` (`db.scheduledTasks`); delivery is the `notify` object `{webhook, email, wecom, feishu}`; `unattended_tools` is a string array.
- Each occurrence is persisted as a `kind='automation'` Runtime run, claimed by the worker and run by `scheduler/executor.ts` in a `channel='task'` session through `runAgentInSession`; croner only triggers.
- `scheduler/task-center.ts` is the only validator (cron/tz, 10 per member, `MIN_INTERVAL_MINUTES`, prompt 10–4000, `max_steps` ≤20, hidden profiles on create and update, `sanitizeForPrompt`), returning `{ok,code,error}`.
- `routes/tasks.ts` and `tools/automation-*.ts` are thin shells; admission lives only in `scheduler/runtime-driver.ts`; `TaskActor.scope` is `'any'` for the HTTP console and `'own'` for agent tools.
- `listTaskRuns` spines on `channel='task'` sessions joined to runs (`run:null` = pre-Runtime); enqueue failures surface via `surfaceEnqueueFailure`, never stderr only.
- The scheduler rereads the owner at start, reload, each run and before the model call; only active team/super owners run.
- Run tools = `scheduledToolBase(effectiveTools)` through `filterUnattendedToolIds` (`unattendedReplaySafe` reads only), plus opt-ins.
- Opt-ins run only as ticked ∩ catalog (`@greenhouse/types/automation-tools` + plugin `automationTools`) ∩ effective tools recomputed per run, so ticking never widens permissions.
- `filterUnattendedToolIds(ids, optIn?)` takes opt-in explicitly (only the executor passes it); only the owner writes `unattended_tools` (HTTP console, or `humanChat` → `canGrantTools` in a `channel='web'` chat).
- Results return `unattended_tools` and `run_tools` (`resolveScheduledRunToolIds`); the model promises only `run_tools`.
- The catalog lives in types to avoid a registry ↔ task-center TDZ cycle; `scheduler/__tests__/automation-opt-in-catalog.test.ts` keeps its ids real and disjoint.
- `UNATTENDED_TOOL_DENYLIST` (`agent-runtime/tool-policy.ts`) = `automation_mutation` + plugin tools with `surface.unattendedDenied`, overriding opt-in.
- Writes join the delivery summary (`notifyTaskResult` reads non-`r0` `db.runtime.listToolCalls`, `formatWriteReceipt`); a failed read only warns.
- Occurrence id = `taskId + scheduledFor` (manual: UUID); one active run per task (advisory lock); boot catch-up runs only the latest miss within 24h and marks older ones `missed`.
- `max_attempts=1`: a lost lease ends `interrupted / runtime_outcome_unknown` (`outcomeUnknownKinds`), running calls become `uncertain`, one `runtime_failed` notification lists in-flight writes; never replayed.
- Only Cancel is offered (queued settles at once, running sets `desired_state=cancel`); `quiet_when_empty` with exactly `NO_UPDATE` after ≥1 tool call succeeds with `no_update:true` and sends nothing.
- Delivery is system behavior, never an agent tool: webhooks must be https and accepted by an enabled transport (`validateNotifyWebhook`); other channels are booleans; delivery failure never fails a run.

## Notifications and push

- Producers use `notify()` (`notifications/publish.ts`, kit `notify`) for inbox, push queue and WS; direct `createWithStatus()` callers also call `queueMobilePush()`; `notifications/delivery-worker.ts` owns external I/O.
- Bodies go through `notifications/render.ts` (`flattenRichOutput()` then `renderNotificationEmail()`), truncated after flattening (600 cards, 20000 email); payloads keep the raw `summary`.
- `marked` passes raw HTML, so the `renderer.html` escape is load-bearing; only `http(s)`/`mailto` links survive (relative → `PUBLIC_BASE_URL`); overrides are plain objects (`Marked.use()` skips prototype methods).
- Push category comes from `pushCategoryOf` and per-device switches only narrow; pushes carry no content by default and `data` holds ids only (`PushData`).
- The worker claims `mobile_push` only with `MOBILE_PUSH_ENABLED`, rechecks before sending (→ `suppressed`), disables `DeviceNotRegistered` devices and retries only transient errors.
- Device routes are internal and own-device only (tokens write-only, test push once per 10s); `/api/bootstrap` `mobile_api` = `MOBILE_API_LEVEL` = `CLIENT_API_LEVEL`, bumped when clients need a new API.

## Tool catalog and proxy

- Metadata is co-located (`defineTool({ meta, kind, create? | createLazy? })`); `tools/registry.ts` lists `CORE_TOOL_MODULES` + active plugin tools and derives every set; never hand-maintain an allowlist.
- A core lazy tool also needs a branch in `buildLazyServerTools` (session-bound under `if (sessionId)`); only plugin tools use generic `createLazy`; `tools/__tests__/surface-derivation.test.ts` pins every derived set.
- No `surface` means neither proxied nor on MCP; MCP exposure names a group in `meta.surface.mcp`; external-only tools are built only by `agent-runtime/service-tools.ts` and hidden from in-app lists.
- `resolveUserTools` is the only "which tools may this member use" (flag-owned tools included), used by profile create/update/fork and `GET /api/tools`; `resolveEffectiveTools` only narrows.
- `meta.builtin` tools (`BUILTIN_AGENT_TOOL_IDS`) join the profile filter, never the effective result (`agent-runtime/__tests__/builtin-tools.db.test.ts`); a builtin has no own permission, cost or outbound channel.
- Forking a system Agent seeds the member's allow-set, a custom Agent its declared tools; prompts never list tools dynamically and YAML names only guaranteed tools.
- `/api/agent` (`routes/agent-tools.ts`, `agentBearerAuthMiddleware`): tools = effective ∩ proxy sets; writes need `MUTATING_PROXY_ALLOWLIST`, write scope and `confirm:true` per call (else 400), each audited.
- `call_llm` is lazy and session-scoped (never proxy/MCP): one-shot, no tools, 2-minute timeout, logged as `usage_events kind='audit'`, never fed back into context.
- Bad tool-argument JSON is repaired deterministically (`createToolCallRepair`, loose then strict pass, strict only if it parses); tool names are never repaired; repairs warn.
- DeepSeek-only `withFinalAnswerGuarantee` (≤3 tool-free retries, usage summed and budgeted) is removable by deleting `dsml-interceptor.ts` and the wrapper.
- Tool errors are prompt text: quote interpolated values (`"${id}"`) so friction mining groups them, and name the next step; search tools tell an empty corpus from a miss.
- Openable rows carry `url` from `entityUrl()` (`@greenhouse/types/entity-links`); never hand-write link templates; descriptions cite with `CITE_URL_INSTRUCTION` (`tools/cite-url.ts`).
- New description text must fit `tools/__tests__/description-budget.test.ts`; remove duplication before raising the budget.

## MCP server, OAuth and team context

- `routes/mcp.ts` is a thin adapter (`buildProxyManifest`, `executeProxyTool`) over stateless WebStandard Streamable HTTP; OAuth helpers live in `agent-access/oauth.ts`.
- OAuth only: Authorization Code + PKCE S256, or super-created `client_credentials` machine clients (bound least-privilege user, scope cap, 1-hour tokens, no refresh); DCR stays public-only.
- Public clients use `token_endpoint_auth_method=none`, redirect URIs match exactly, and tokens, codes and secrets are stored only as SHA-256 hashes (machine secrets `lpoa_cs_` shown once).
- `mcpCredentialMiddleware` checks token hash, audience, scope and grant/client/user per request; non-`lpoa_at_` Bearers get 401 + RFC 9728 challenge advertising all `OAUTH_SUPPORTED_SCOPES`.
- Scope = action (`mcp:read`/`mcp:write`) × resource group (`mcp:<group>`); reachable tools = group ∩ tier ∩ the bound member's permissions; bind integrations to dedicated users, never super.
- `normalizeOAuthScopes` (request) expands "no group" to all groups; `parseStoredOAuthScopes` (storage) never expands; reversing them escalates stored grants (`agent-access/__tests__/oauth.test.ts`).
- An empty group set is invalid (consent disabled, approve 400); `allowedTools: undefined` is unnarrowed but `[]` is zero tools.
- Every call and refresh intersects token scopes with current grant scopes; a grant scope change revokes old tokens and unused codes in one transaction.
- Tools, platform visibility and OAuth state are never cached across requests (`CONTEXT_TTL_MS` caches only registry assembly); revocation applies on the next request.
- Member filtering lives only in `agent-runtime/mcp-tool-visibility.ts`; protocol tools `team_context`, `data_catalog`, `tool_output_read` are outside the registry and bounded by `boundReplyText`.
- MCP writes run at once as the member (no approval queue) as `kind='agent_write'` runs with full evidence (`governProxyWrite`), listed at `GET /api/agent-access/writes`.
- Risk (`agent-access/risk.ts`): delete-like verbs are r3 for every tool; r3 without `confirm:true` returns `needs_confirmation` + preview and no run; only deleting write tools expose `confirm`.
- Annotations: `readOnlyHint` for reads, `destructiveHint` unless `additiveOnly`, `openWorldHint` from `openWorld`; results end `Recorded in Greenhouse as write <id>.`
- Unrecorded outcomes are `outcome_unknown`; writes running at boot become `interrupted`, never replayed; only failures and unknown outcomes notify.
- Replies >12,000 chars become a handle + ≤8,000-char preview paged by `tool_output_read`, stored at `drive/mcp-output/<sha256(member+client)>/` for 24h (no table; the key is the authorization).
- Tools whose safety needs a person reading a draft card, or that self-replicate (`automation_mutation`), get no MCP group; never revive them through approval leases.
- Retired group `image` (`RETIRED_MCP_RESOURCE_GROUP_IDS`) reaches only `generate_image` (`LEGACY_MCP_GROUP_TOOLS`) and still needs `mcp:write`.
- Each `tools/call` is audited by `recordMcpAudit` (`request_log`, `channel='a2a'`); machine clients live at `/api/admin/platform/oauth/machine-clients` (super), UI `apps/client/src/admin/mcp-keys.web.tsx`.
- Team context is Markdown `team_context.{overview,conventions,glossary}_markdown` + timezone; resources, prompts (`prompt-<id>`, plugin `ext-<id>-<name>`) and catalog are cut to the grant's reachable tools.
- Plugins add `teamContextSources`, `mcpResources`, `catalogSources` and `agentContext`, each rechecking access; `PUT /api/admin/team-context` preserves omitted fields and fires `workspaceTimeZoneChanged`.

## Connectors

- One `mcp_call` tool (list/describe/call) reaches every connector; never one model tool per remote tool; routes are `/api/me/connectors`, `/api/admin/connectors` and the public OAuth callback (stored state only).
- Remote servers only, never a local process; every connect goes through `connectors/network.ts` (public addresses unless `private_network`; loopback only in dev/test).
- Secrets are sealed, write-only and never logged (`redactSecrets`); changing a connector's url or auth wipes member credentials in the same transaction (`connectors/manage.ts`).
- `connectors/directory.ts` is an in-memory snapshot reloaded after each write; `connectorDirectoryVersion()` is in the MCP cache key; an Agent's `connectors` (null = all) apply via `connectorsForUser`.
- Read tools default on, others off; destructive tools always preview → `confirm`; automations never run them; `/api/agent` and `channel='browser'` sessions never get `mcp_call`.
- On MCP (group `connectors`) writes need `mcp:write`, and team-credential connectors also `allow_external_writes`; calls audit without arguments, writes add a `connector_write` run.
- Tests use `connectors/__tests__/fixture-server.ts`, never a real third-party endpoint.

## Platform kernel

- `runtime.dispatch()` (`plugin-host/runtime.ts`) is the only protected-action entry (capability → record/field policy → handler → audit); transports only adapt; unauthorized records are 404.
- `plugin-host/bootstrap.ts` keeps protected `super/team` roles and baseline grants; unbound members resolve to `users.role`; `orgId` is always `PLATFORM_ORG_ID`; no per-person exceptions.
- Projection keeps only manifest-declared fields, so computed fields are declared with a version bump and the owning plugin's golden hash test updated.
- `/api/admin/platform` (super) policy writes validate against the manifest; handler `audit` hints (`PlatformAuditHint`) carry titles only, never content or secrets.
- Admin config writes audit key names only (`updateWorkspaceSettings`, `setUserFeature`; `routes/__tests__/admin-config-audit.db.test.ts`).

## Runtime and kill switches

- `trusted-execution/kill-switches.ts` is the only parser: default on, invalid values fail closed, `/health.trusted_execution.invalid_env` names them; no switch edits `user_grants` or stops Chat.
- Switches stay independent: `RUNTIME_CHAT_ADAPTER_ENABLED`, `RUNTIME_WORKER_ENABLED`, `RUNTIME_AUTOMATION_DRIVER_ENABLED`, `RUNTIME_NOTIFICATION_PROJECTOR_ENABLED`, `TASK_CENTER_ENABLED`, `RUNTIME_APPROVAL_INBOX_ENABLED`.
- `/api/runtime` is a read model, not authorization: chat runs super-only, others by owner, every read and command fails closed by source domain; retired kinds are read-only; payloads are stored whole.
- Chat is trace-only: create the run and `chat_turn` step before provider I/O, persist the transcript first; workers never claim chat; boot runs `reconcileInterruptedChatRuntimeRuns()` without replay.
- Chat run sources prefer the persisted user message id (stateless turns: the ChatRun UUID); a terminal source is never reused.
- Tool evidence is written at the execute boundary (`runtime/tool-evidence.ts`): await `beginToolCallWithAuthority()` first and the terminal write before the model sees the result; lost calls end `uncertain`.
- Commands delegate only what a driver supports via `db.runtime.executeRunDomainCommand()` (lock, re-authorize, side effect, CAS); `runtime/worker.ts` owns leases, interrupt expiry and the outbox.
- `runAgentInSession()` is the only headless turn runner (kit `runAgentTurn`); `usageContext` and `toolCallClient` are required and each turn writes one `usage_events kind='model'` row.

## Activity, search, refs and people

- `/api/activity` (`activity/activity-log.ts`) merges command audits, Files and plugin `activity`, agent writes, automation and admin actions (`ADMIN_ACTIONS`); reads never show as changes.
- Members see only themselves, super sees all and admin changes; object names only when the viewer can read them; settings show key names; windows default 30 days, max 366.
- Wording is verb + object kind + name (`describeToolWrite`), never module names; export uses the same filters, ≤5000 rows, formula-safe CSV.
- `GET /api/activity/recent` pages 14 days by an opaque `(at, id)` cursor, each lane in SQL reading past hidden rows; "via <agent>" needs a matching `agent_write` run window with no slack.
- `GET /api/search` runs one lane per domain (plugins via `searchSources`), each failing alone, with no cross-domain ranking; automation lanes search only the caller's own, even for super.
- `POST /api/refs/resolve` parses only via `parseObjectUrl`, accepts absolute URLs only on this origin, applies each object's own read rule, returns `title: null` for unreadable or missing, ≤50 URLs.
- `POST /api/people/resolve` is internal-only and returns `{ id, name }` only, ≤200 ids (`MAX_RESOLVE_PEOPLE`).

## Model catalog and gateway

- `config/models.yaml` is configuration (models, provider chains, key env names, `options`, `price`); change and redeploy; profile YAML declares no `options`.
- The model is per turn: `isChatModelAllowed()` admits `chat.selectable` reachable models, anything else falls back to the Agent's model; `messages.model` stores the registry id.
- `GET /api/profiles` lists `listChatModels()` (reachable only); `vision: true` (or `vision_env`) is the only image-inlining switch (`chat/vision.ts` caps), and inlined turns add the "images are visible" section.
- The gateway (`routes/gateway.ts`, `gateway/`) has OpenAI and Anthropic wires only; never document Responses, embeddings or images endpoints.
- Gateway auth is a hashed `ghgw` key (Bearer or `x-api-key`); `/api/gateway/` is public, CORS-closed, 4MB, rate-limited per IP and `GATEWAY_RATE_LIMIT_PER_MINUTE` per key; `gateway.enabled` off is 403.
- Upstream clocks (`UpstreamLifetime`, `done()` on every path) are `GATEWAY_UPSTREAM_TIMEOUT_MS` and `GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS`; cut streams get one `upstream_interrupted` event.
- Catalog ids only, no cross-provider fallback; forward only the upstream key and content/Anthropic headers, never the ghgw key; upstream text passes `sanitizeUpstreamText`, 401/403 never pass through.
- Gateway calls reserve via `reserveUserTokenBudget` and record `gateway_key_id`; upstream 4xx/refused connections release, disconnects/5xx/missing usage stay unknown for the sweeper.
- Errors keep each wire's shape (budget refusals 429); members hold ≤`MAX_ACTIVE_GATEWAY_KEYS` keys, secrets shown once; super revokes at `/api/admin/metering/gateway-keys`.

## Metering and budgets

- Every call that spends team money goes through `usage/metering.ts` (`reserveUserTokenBudget`, `reserveSpend`, `meterServiceCall`); never keep a separate ledger.
- Member, service and organization USD accounts are reserved atomically before I/O and settled at the price current at settlement (`price_applied`); release only when I/O certainly never started.
- Prices come from models.yaml, `config/services.yaml` (closed list) and plugin `billableServices`, overridden by super (`syncPriceOverrides()`); unpriced is unknown cost, never a refusal, and `price: 0` is free.
- Limits: `budgets` rows → `USAGE_BUDGET_{MEMBER,ORG,SERVICE}_MONTHLY_USD_MICROS` → defaults; services without a limit follow the org; `createOrganizationAttemptBudgetHook` never bypasses member budgets.
- Attribution comes from `runWithMeteringScope`/`bindMeteringScope` at every entry; a missing scope warns and records "no member"; clients come from `METERING_CLIENTS`.
- Refusals precede I/O as `UsageBudgetAdmissionError` (429); tools rethrow it, MCP returns `isError`, automations record `budgetRefusalReason`, chat shows `localizedBudgetNotice`.
- 80%/100% crossings send one deduplicated `budget_attention` per account and period (zero limits never alert); budget and price edits write platform audit.
- `generate_image` is fixed to `IMAGE_MODEL` at `low` with three sizes (normalized, `requested_size` echoed); reference images use edits and always forward `size`.
- `IMAGE_BASE_URL` and `IMAGE_API_KEY` are set together and a key is only sent to its own URL; on external surfaces `generate_image` is an additive write into the member's Files.

## Usage counters and retention

- Counters store only `(day, kind, key, client)` and never fail or block (`countUsage()`, never an awaited increment); tool calls count once inside the evidence wrapper or after all proxy checks.
- Client Action names never become counter keys; `X-Greenhouse-Client` is a label for counters and metering only, never authentication, permissions or the stored channel.
- `POST /api/usage/page-open` accepts only `PAGE_MODULE_IDS` or active `ext.<id>`; `GET /api/admin/usage/modules` accepts `days=7|30|90` only.
- Retention rules live in `db.retention.run()` plus plugin `retention`; `scheduleRetention()` runs daily, skips within 20h of the last audited run and never throws.
- Rate-limit buckets, OAuth login states and MCP outputs stay on the five-minute upkeep in `index.ts`, each sweep failing alone.

## Plugin host and SDK 2 runtime

- Plugins import only `@greenhouse/api/extension-kit` (snapshot-locked by `__tests__/extension-kit.snapshot.test.ts`); `plugin-host/compiled.generated.ts` comes from `pnpm plugins:sync`, never edited or committed.
- Activation requires `sdk` = `EXTENSION_SDK` and a matching `core` range; `onBoot` failures abort startup; env alone never activates a plugin; `/api/admin/plugins` is super-only and read-only.
- `cli plugins drop` works only on disabled plugins with `--yes`, under the migration lock, never cascading into core or another plugin.
- Seams need a real consumer; `agentContext` is appended before the digest only when its tools are reachable, ≤2000 chars, never turn-dependent; `surface.unattendedDenied` precedes opt-in grants.
- Communication registries aggregate through `fromExtensions`; core keeps inbox, push, login states and binding uniqueness; plugin notification kinds use `ext:<id>:<kind>`; `GET /api/auth/providers` mints no state.
- `plugin-host/data-runtime.ts` is the shared REST/tool/search/export/peek executor: scopes before paging, projection and action checks on every transport, protected fields never caller input even for super.
- Kit `recordWrite`/`notify` follow committed writes; the five-event bus (`plugin-host/events.ts`) runs isolated 5s handlers no request awaits; `onInstall` runs once via `extensionMigrations.installOnce`.
- Kit `channelAgentRuntime()`/`runAgentTurn()` load the catalog after activation; never eagerly import the tool registry from a plugin or kit export.

## Hosting, embeds and client links

- `hosting.ts` serves the universal client from `public/app`; `/classic` redirects to `/`; `/api`, `/ext`, `/oauth`, `/.well-known` and `/health` never fall through to SPA HTML.
- Server-made browser links use `@greenhouse/types/client-routes`, with secrets in the fragment (`clientRouteUrl(..., { fragment })`).
- `POST /api/ext-ui/token` binds member, `auth_version` and a member-visible plugin for ten minutes, rechecked per call; it reaches only `/api/ext/<id>/*` and basic `GET /api/me`, enforced before public bypass.
- Plugin UIs mount at `/ext/<id>/ui/` before auth and SPA fallback (`ui/dist` preferred, disabled or missing → 404, fingerprinted files immutable).
- Plugin UI CSP allows frame ancestors `'self' tauri://localhost` and omits X-Frame-Options; every other response keeps `DENY`.

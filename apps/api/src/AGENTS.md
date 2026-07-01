## Backend API rules

### Logging
- All backend logs use `logger.info/warn/error` from `utils/logger`.
- **No `console.log/warn/error`** — use the structured logger.
- Format: `[INFO/WARN/ERROR] message` + an optional data object.

### Routes
- Each route file starts with a comment block listing its endpoints:
  ```
  /**
   * XXX routes — /api/xxx
   *
   * GET  /api/xxx     — list XXX
   * POST /api/xxx     — create XXX
   */
  ```
- One file per resource, in `routes/`.
- **Routes must be chained** (prerequisite for the hc contract): `const x = new Hono<AppEnv>().get(...).post(...)`. Statement-style registration (`x.get(...)`) doesn't accumulate types and the endpoint disappears from the `AppType` contract. `AppEnv` comes from `src/app-env.ts`.
- Factory routes (`createXxxRoute()`) **must not** declare an explicit `: Hono` return type — it flattens the chained schema and breaks hc inference.
- **No `any` in response objects**: an `any` field in a handler's return value collapses the whole route's inferred response to `never` (the hc endpoint becomes unusable). Annotate raw SQL result shapes before `c.json()`.
- All routes are mounted through `mountRoutes()` in `src/index.ts` (**mount order has security semantics — don't reorder**). `export type AppType` is the contract, re-exported by `@greenhouse/contract` to the web client.
- `/api/client-tools` is mounted dynamically and deliberately stays out of the contract (the browser client-action callback surface: `POST /result` returns an action result and unblocks a suspended agent step).

### Fork extension points (downstream personalization)
These are the seams a downstream fork uses to add private features WITHOUT editing shared registry files, so those files stay byte-identical to upstream and never conflict on sync. **Upstream (this repo) ships each one empty** — guard tests pin that (an OSS build must contain zero private tools/routes).
- **Private tools** → `tools/extensions.ts` (`EXTENSION_TOOL_MODULES`). The fork adds tool modules there; `registry.ts` splices them into the catalog before deriving metadata + the proxy/MCP allowlists, so a private tool with `meta.surface` is auto-exposed. Never edit `registry.ts` to add a tool.
- **Private routes** → `routes/extensions.ts` (`EXTRA_ROUTES` + `mountExtraRoutes`). The fork pushes `{ path, create, use }` entries; they mount in `main()` after the typed chain and are intentionally **outside** the `AppType` contract (same as `/api/client-tools`) — the fork calls them with plain `fetch`. Never edit `mountRoutes()` to add a private route.
- **Private system profiles** → `profiles/extensions.ts` (`EXTENSION_SYSTEM_PROFILES`). The fork adds `defineProfile(...)` results there; `profile.ts` splices them into `SYSTEM_PROFILES` so they're loadable/listable/resolvable, and a private profile may reference private tools (validated against the live catalog). Never edit `profile.ts`.
- **Startup wiring for runtime hooks** → `bootstrap.extensions.ts` (`bootstrapForkExtensions()`, called first thing in `main()`). The array seams above self-wire (their central file imports them); the runtime `register*()` seams must be *called* — do it here. Never edit `index.ts`'s `main()` to wire a fork.
- **Storage backend** → `storage/extensions.ts` (`registerStorageDriver()`). Upstream is local disk; a driver routes `putUpload`/`getUpload`/`deleteUpload`/`presignUpload` to S3/COS. Never edit `storage/uploads.ts`.
- **Email connectors** → `email/extensions.ts` (`registerEmailConnector(provider, factory)`). Upstream is IMAP-only; `createEmailClient` dispatches to a connector for a non-`imap` provider (Gmail/Outlook). Never edit `email/service.ts`.
- **Public (auth-skipped) paths** → `auth/extensions.ts` (`EXTENSION_PUBLIC_PATHS` / `EXTENSION_PUBLIC_PATH_PREFIXES`). For OAuth redirect callbacks that arrive without a bearer token. **Security-sensitive** — a guard test pins these empty upstream. Never edit `isPublicPath()` in `middleware.ts`.
- **CSP `connect-src`** → the `CSP_CONNECT_SRC` env var (space/comma-separated origins) for a fork's external calls. No code edit.
- Convention: contribute private code as NEW files under `tools/<domain>/`, `routes/`, or `profiles/`, then reference them from the matching `extensions.ts`. Runtime `register*()` calls go in `bootstrap.extensions.ts`. If a private need forces an edit to a shared file, that's a signal to add/extend a seam upstream, not to patch downstream.

### Auth module (`auth/`)
- All auth logic lives in `auth/` (token, middleware, password, api-key, crypto, features).
- Internal CLI / server self-calls use `createInternalToken()` from `auth/token.ts`.
- Always import from `auth/index.ts`.
- **Fail-closed startup gate (`assertAuthEnv()`, called from `main()`)**: if `ACCESS_PASSWORD` is unset, auth is off and `authMiddleware` treats every request as super — a total bypass for any exposed deployment. So `ACCESS_PASSWORD` is **mandatory in every environment** (local / dev / prod) and the service **refuses to start** without it; once set, `TOKEN_SIGNING_KEY` is equally mandatory (no fallback). It does **not** rely on `NODE_ENV` — forgetting `NODE_ENV=production` won't open it up. No escape hatch — local/dev `.env` must also set both. The contract is locked by `tests/api/token.test.ts`.

### Security (`security.ts`)
- External user input **must** pass through `sanitizeForPrompt()` before reaching the LLM.
- Use `checkPromptInjection()` to detect and log injection attempts.
- Rate limiting uses the shared `InMemoryRateLimiter` class — don't roll your own.
- File uploads: validate MIME via `validateMagicBytes()`.

### Upload storage (`storage/uploads.ts`)
- Unified storage layer for chat-uploaded images / generated images — **never touch the filesystem directly**, always go through `putUpload(id, buffer, contentType)` / `getUpload(id)` / `deleteUpload(id)`.
- Backend is local disk (`data/uploads`), suitable for single-instance deploys. For multi-instance, put an object-storage backend behind this same put/get/delete interface.
- `routes/upload.ts`'s `GET /api/upload/:id` is the authenticated origin proxy (keeps `authMiddleware`; URL contract unchanged).

### External API (v1)
- v1 endpoints live in `routes/v1/`, fully isolated from internal `/api/chat`.
- Auth: `Authorization: Bearer` header → `apiKeyMiddleware` → injects `ApiClientRow`.
- API key format: `gh_sk_<32-byte hex>`, stored as a SHA-256 hash.
- Request format: OpenAI Chat Completions compatible, streamed via SSE.
- Session isolation: an external client can only access sessions matching its `app_id`.
- Session context: `greenhouse.context` (structured role/locale/timezone/notes/attributes, see the zod schema in `session-context.ts`) is whitelisted, stored in `sessions.metadata.context`, and rendered into the system prompt (labeled as untrusted reference data). Internally it's set from the web session TopBar's Context button (`GET/PUT /api/sessions/:id/context`).
- Every v1 call writes a row to `api_audit_log`.
- Rate limiting: per API key (RPM + RPD + daily token cap) via the shared `InMemoryRateLimiter`.
- Client management: `/api/admin/clients` (super only).
- **LLM layer = OpenAI-compatible protocol only**: the model factory keeps only `openai` / `openai-compatible` cases (both via `@ai-sdk/openai`'s `createOpenAI`); `createModelDirect`'s `switch` is left as an extension point (commented on how to add a native Anthropic/Google protocol later). DeepSeek etc. still connect via their **OpenAI-compatible endpoint**. The registry is **lazily derived from env** (`LLM_BASE_URL`/`LLM_API_KEY`/`LLM_MODEL`, optional `LLM_MODEL_PRO`): logical ids `default`/`flash`/`pro` all resolve to that upstream. (A previous DeepSeek-native "DSML" tool-call interceptor + final-answer guarantee has been removed entirely; hosts iterate `streamResult.fullStream` directly.)

### Team LLM gateway relay (`/api/llm/*`)
- Lets internal users reach org-managed models **without their own vendor key**, server-side; coexists with BYOK (gateway is the default).
- Relay endpoints in `routes/llm-relay.ts`, mounted at `/api/llm`, with **their own relay-key auth** (reuses `apiKeyMiddleware`, `channel='relay'`), exempted from internal Bearer auth in `auth/middleware.ts`'s `isPublicPath` (like `/api/v1`):
  - `POST /v1/chat/completions` — one OpenAI-compatible entry. Looks up `model` in `llm_gateway_models` → `llm_upstreams`, checks it's within the key's `meta.allowed_models` subset (no subset = the `is_public` default set); omitted `model` uses `is_default`. OpenAI/DeepSeek/compatible upstreams are **transparently forwarded** (decrypt + inject the upstream key, rewrite `model`, pass the SSE stream through verbatim and extract usage); Anthropic-kind returns 501 for now.
  - `GET /v1/models` — returns the key's subset (OpenAI-compatible), driving model pickers and the seamless default.
- Pure forward/extract logic is in `llm/relay-proxy.ts` (unit-tested). Each call writes `api_audit_log` (`channel='relay'`, bound `user_id`, tokens feed the `daily_token_limit` quota).
- Upstream real keys are AES-256-GCM encrypted (`auth/crypto.ts`, reuses `PROVIDER_TOKEN_ENCRYPTION_KEY`) in `llm_upstreams.api_key_enc`.
- Self-service provisioning: `/api/auth/llm-keys` (internal user Bearer, `requireInternal`): `POST /provision` (get or rotate the default key, for seamless setup), `POST /` (bind a model subset), `GET /`, `GET /catalog`, `DELETE /:id`.
- Admin (super only): `/api/admin/llm-gateway` — upstream pool / model catalog / gateway-key governance (disable = `status:'disabled'`, change daily quota, view today's usage).

### Tool system

Tool metadata is **co-located in each tool's file**. A tool declares itself with `defineTool({ meta, kind, requires?, create })` (`tools/define.ts`); `meta.description` is passed straight to `tool({ description })`. `tools/registry.ts` is just a barrel — it imports each module and lists it in `TOOL_MODULES`, from which it derives everything else (static factories, the lazy catalog, `LAZY_TOOL_IDS`, the proxy/MCP allowlists); there are no hand-maintained parallel id lists.

- `meta.surface` is the **single declarative source** for proxy / MCP exposure:
  - `proxy: 'read'` → in `READONLY_PROXY_ALLOWLIST` (callable, no confirm).
  - `proxy: 'write'` → in `MUTATING_PROXY_ALLOWLIST` (confirm-gated).
  - `proxy: 'none'` (or omitted) → not proxied; chat-only.
  - `mcp: true` → also in `MCP_EXPOSED_TOOL_IDS` (must also have a `proxy` value).
  `registry.ts` builds these three sets by filtering `TOOL_DEFINITIONS` on `meta.surface` — change the metadata, the allowlists follow.
- `create(ctx: ToolContext)` builds the tool. **Static** tools read only `ctx.db` and are built once in `createToolRegistry`. **Lazy** tools read request-scoped fields (`userId` / `sessionId` / …) and are built per-request in `buildLazyServerTools`.
- `kind`: `static` (no `requires`) / `lazy` (declares `requires`).
- `requires` (lazy only) is the **declarative access guard** the runtime enforces before building the tool — the same guard that used to be a hand-written if-ladder:
  - `user: 'optional'` (anonymous ok) | `'required'` (a userId) | `'internal'` (a non-external userId).
  - `session: true` (needs a sessionId) · `registry: true` (gets the `assembleChildTools` closure; `spawn_session` only — the raw registry is never handed to a tool).

**Adding a tool** = one file + one line, for **every** kind (static or lazy):
1. In the tool's file, `export const xxxTool = defineTool({ meta, kind, requires?, create })`; set `meta.surface` to expose it over proxy/MCP.
2. Add an import + array entry in `TOOL_MODULES` in `tools/registry.ts`.
`createToolRegistry` / `buildLazyServerTools` / `registerKnownTools` / `LAZY_TOOL_IDS` / the proxy + MCP allowlists are all derived automatically — a lazy tool **no longer** needs a second registration in `tool-resolution.ts`.

### Agent tool proxy (`/api/agent/*`)
- A stable cloud capability layer letting programmatic clients reach cloud data through structured tools. Route: `routes/agent-tools.ts`:
  - `GET /api/agent/runtime-manifest?profile_id=&workspace_id=` — the caller's available tools (with a `mutating` flag + input JSON Schema).
  - `POST /api/agent/tools/:toolId/call` — invoke one tool.
- Auth: a logged-in user's access token (`Authorization: Bearer`) via `agentBearerAuthMiddleware` + per-user rate limit.
- Tool set = `resolveEffectiveTools(user, profile)` ∩ the proxy allowlist — the proxy can only **narrow** permissions, never widen them.
- **The system prompt never dynamically lists the tool set**: tool definitions (name/description/schema) are already delivered to the model natively via `tools[]`; injecting "the user's tool names" into the prompt inevitably drifts from the real registered set. `resolveEffectiveTools` returns only the narrowed `effectiveTools`. Exception: a profile YAML's `system_prompt` **may** carry usage policy for tools (e.g. "search before get"), but only for tools that profile guarantees exist.
- The allowlists live in `agent-runtime/tool-proxy.ts` but are **derived from `meta.surface`** (re-exported from `registry.ts`):
  - `READONLY_PROXY_ALLOWLIST` — read tools (e.g. `project_query`, `session_query`, `knowledge_query`).
  - `MUTATING_PROXY_ALLOWLIST` — write tools (e.g. `project_mutation`, `knowledge_mutation`, `email_mutation`).
- **Write tools default DENY**: a write call must be in the write allowlist, the caller's write permission must include it, and every call must carry `confirm:true`, else 400. Every call writes an agent audit row.

### Session orchestration tools (`spawn_session` / `call_llm`)
- A session can spawn child sessions or fire one-shot LLM calls in parallel, turning a single session into a "controller" that can chew through complex tasks. Both are **lazy and session-scoped** — assembled only when `buildLazyServerTools` receives a `sessionId`, so they are **not exposed on the stateless proxy/MCP surface**. `is_global:true`: on by default for internal users, but only effective on the chat surface (which passes a sessionId); child tool sets are always ⊆ the caller's permissions.
- **Shared runner**: `runAgentInSession()` in `agent-runtime/run-agent.ts` is the single implementation of "run one agent turn to completion in a session and persist the assistant message + pipeline + references." Both `scheduler/executor.ts` (automations) and `spawn_session` reuse it. The LLM call goes through an injectable `generate` seam (defaults to `generateText`, stubbable in tests — no real model/key needed); `db` is injectable too.
- **`spawn_session`**: creates a `channel=subagent` child session, links the parent via `sessions.parent_session_id`, records depth in `metadata.spawn_depth`. `mode:'sync'` waits for and returns the result; `mode:'async'` requires `confirm:true` and runs in the background (in-process fire-and-forget, **lost on restart** — no durable queue). Guards: max depth `MAX_SPAWN_DEPTH`, per-parent async concurrency cap; child tool sets go through the same `resolveEffectiveTools` path and stay ⊆ the caller's.
- sync is a legitimate long-task mode (the parent waits to summarize). Guards: sync hard timeout 10min, async 30min; bound to the parent tool call's `abortSignal` (parent cancel/disconnect stops the child immediately, no orphan runs); timeout/cancel/failure always writes a status message to the child session (it's never left empty). `call_llm` likewise has a 2min timeout + parent-abort.
- **`call_llm`**: no session, no tools, one-shot. Full input/output is written to the `llm_calls` audit table (linked by the caller's session_id), **not** fed back into context; optional `model` override; multiple calls in one step fan out in parallel.

### MCP server (`/api/mcp`)
- Wraps the agent tool proxy in the **MCP protocol** so any MCP client (Claude / Cursor / external agent) can reach internal resources over the standard protocol. Route: `routes/mcp.ts`, a **thin adapter** — no custom resource access: `tools/list` ← `buildProxyManifest`, `tools/call` ← `executeProxyTool` (confirm gate / input validation / permission intersection all reuse `tool-proxy.ts`).
- Uses `@modelcontextprotocol/sdk`; transport is **WebStandard Streamable HTTP** (stateless: each request builds a fresh `Server` declaring the `tools` capability, consuming `c.req.raw` and returning a `Response`). `enableJsonResponse:true`.
- Auth: an API key **bound to an internal user** (`api_clients.user_id`, `channel='a2a'`). Chain: `apiKeyMiddleware` → `mcpIdentityMiddleware` (`agent-runtime/mcp-auth.ts`: requires the key be bound to a user whose `role∈{super,team}` and is active, else 403) → per-key rate limit (`createPerKeyRateLimitMiddleware('mcp')`). Exempted from internal Bearer in `isPublicPath` (like `/api/v1`, `/api/agent`).
- **Security boundary = the internal user the key is bound to.** The proxy can only narrow that user's permissions (`resolveEffectiveTools ∩ proxy allowlist ∩ MCP-stage set`). Bind each external integration to a **dedicated least-privilege user** — never to super or a personal account.
- **Write posture: open but confirm-gated.** `mcpIdentityMiddleware` grants the identity the full `MUTATING_PROXY_ALLOWLIST`; mutating tools get a **required `confirm` boolean** injected into their `tools/list` input schema, which `tools/call` strips and passes through as `executeProxyTool`'s `confirm` (MCP's `tools/call` has only `name`+`arguments`). confirm is caller-supplied — it guards against accidental triggering, not malice; the real gate is the bound user's permissions.
- **Exposure set**: `MCP_EXPOSED_TOOL_IDS` (derived from `meta.mcp`) = knowledge + project + email + chat-history tools (each must also be in a `tool-proxy.ts` allowlist):
  - knowledge: `knowledge_query` (read) / `knowledge_mutation` (write).
  - project: `project_query` (read) / `project_mutation` (write).
  - email: `email_query` (read: list_accounts/list_folders/search_emails/read_email) / `email_mutation` (write: draft_email/send_email). Send safety reuses the server-side draft: `draft_email` returns a preview + `draft_token` (stored server-side ~10min), `send_email` sends by token (content taken from the server draft), on top of the MCP `confirm:true` gate.
  - chat: read-only `session_query` / `session_history` (driving conversations goes through `/api/v1/chat/completions`, not MCP).
- Audit: each `tools/call` writes `api_audit_log` via `recordMcpAudit` (`channel='a2a'`, real `app_id`, bound `user_id`).
- Provisioning a bound key: `POST /api/admin/clients` (super) with `user_id` + `channel:'a2a'` (validated at creation that the bound user exists / is active / is internal).
- Performance: `resolveMcpContext` (tool set + registry) is cached per `userId+role` for `CONTEXT_TTL_MS` (60s); permission changes take effect within ≤60s.
- Admin UI: Settings › Administration › MCP Access (`apps/web/src/pages/settings/mcp-keys.tsx`, super only): create / rotate / disable / delete keys, copy the client config, per-key Activity (`/:id/audit`).
- Pure logic (schema normalization + confirm injection, protocol round-trips) is unit-tested in `routes/__tests__/mcp.test.ts` (SDK `InMemoryTransport` + `Client`, no DB).

### Agent profiles
- Profile YAML files live in `profiles/` (`default`, `team`).
- Architecture, tool scoping, and model-switching policy: [agent-profiles.md](./profiles/agent-profiles.md).
- Update that doc when profiles change.

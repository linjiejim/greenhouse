# API rules

These rules cover v1 code: fix bugs, but never extend a module that docs/product/features.md marks 删除 or 合并. New-style code follows docs/product/api.md and docs/product/providers.md. Agents, the Bots engine, computers and the vault also follow bots/AGENTS.md. Short paths such as chat/turn.ts are relative to apps/api/src.

## Routes and auth
- Define each router as one chain, `new Hono<AppEnv>().get(...).post(...)`, under a header comment listing its endpoints. Statement-style registration drops endpoints from AppType, the typed client contract.
- Never annotate a route factory as `: Hono` and never return `any` inside a response object; both erase the inferred response type.
- Mount routers only in mountRoutes() (index.ts), next to routes with the same guard. Mount order is security-relevant: never reorder it.
- Guard with requireInternal() for any account, requireSuper() for super and requireFeature(key) for a flagged module; read the caller with getAuthUser(c).
- Hono's `/*` does not match the bare path: guard both `/x` and `/x/*`, or guard inside the router with `.use('*', guard)`.
- Give every isPublicPath entry (auth/middleware.ts) its own credential (single-use state, signed ticket, unguessable id) and a test. Never mount a member route under a public prefix: /api/mcp, /api/ws, /api/agent/, /api/llm/, /api/upload/, /api/bots-preview/.
- authMiddleware re-reads status, role and auth_version on every request and has no dev or anonymous bypass. Server self-calls carry a real, current account token, never a synthesized user.
- Only super issues invite and reset links, plus security/first-admin.ts, which never elevates or revives an account. Their one public surface, POST /api/auth/password-link/{inspect,complete}, keeps its 4 KB body limit, IP and token-hash rate limits, uniform error and no-store.
- Account binding (WeCom, Feishu, connectors) starts behind Bearer and returns the authorize URL instead of redirecting; public callbacks trust only their state, never a browser session.
- A WeCom or Feishu identity binds one account and never creates one. Feishu login trades a short-lived single-use code for a session from issueUserSession; long-lived tokens never appear in a URL.
- WS handlers and timer callbacks catch their own errors, and every emitter or stream gets an error listener before it can fail; anything unhandled kills the process. /api/ws closes with 1011 on transient failures and keeps 4001 to 4003 for auth and terminal states.
- In-memory state (chat run registry, Feishu long connection, WeCom and Feishu OAuth state, token caches) assumes one serving API process; redesign it before running several.
- Pass every user- or model-written string through sanitizeForPrompt() before it reaches a prompt. Never give it a no-truncate mode; split structured parts out first, as chat/user-message.ts does.
- Take client IPs only from security/request-ip.ts and rate-limit with the shared InMemoryRateLimiter. Never set TRUSTED_PROXY_HOPS where clients can reach the API directly.
- Fetch model-supplied URLs only through security/network.ts (fetchPublicImage, fetchPublicPage). When passing an undici dispatcher, import fetch from undici too; the global fetch rejects it as an opaque "fetch failed".

## Chat, sessions and files
- A turn is a ChatRun (chat/runs.ts): routes/chat.ts only adapts protocol, chat/turn.ts pumps and chat/persist.ts persists. routes/chat.ts never imports tools/registry.ts.
- One turn per session: claim before saving the user message (a duplicate POST gets 409) and release on any later preflight failure. Persist before finish(run), because clients reload when the stream closes.
- Keep both the keepalive ping and CHAT_STREAM_TIMEOUT. An abort part is a failure: persist the partial answer with a generic retry note, except a usage-budget denial (usageBudgetNotice), whose own text goes to both the stream and the stored message.
- ChatRequestBody (@greenhouse/types/api) is the only request type: delete fields the server stops reading so stale clients fail to compile. New rich blocks never join DEFAULT_CLIENT_BLOCKS; clients opt in through rich_blocks.
- Ambient context and client actions are hints, never intent or permission: drop invalid context silently (chat/ambient-context.ts) and require a matching client_action_scope_id.
- Browser-extension sessions get read-only tools from the stored session channel (filterBrowserSessionToolIds), never from a client flag.
- History windowing and tool-result masking shape only the model payload, never the stored transcript. An unknown or unreachable model falls back to the default instead of failing the turn.
- Only superSeesAllChats (sessions/access.ts, off unless SUPER_READS_CHATS) lets super read another member's chats, and global search returns only the caller's own chats.
- Store images only through putUpload and getUpload (storage/uploads.ts) with server-generated ids, and check upload types with validateMagicBytes().
- GET /api/upload/:id is the only unauthenticated file read; never extend it beyond images (attachment-boundary.test.ts).
- Changing a COS key prefix orphans every stored object. Prefixes are validated at module load; keep them there.
- Only the session owner adds attachments. Resolve model-supplied file and image refs through normalizeFileRef and files/conversation-files.ts, so ids from another session never resolve.
- A dynamic import() of a CommonJS package reads .default (see resolveWorkbookCtor). Vitest hides the difference, so verify by loading the real file in Node.

## Tools, profiles and the agent loop
- Declare a tool with defineTool beside its code (fields in the tools/define.ts header), add it to CORE_TOOL_MODULES (tools/registry.ts) and give a core lazy tool a branch in buildLazyServerTools. Exposure sets derive from meta.surface, pinned by surface-derivation.test.ts.
- resolveUserTools alone answers which tools a user may use. Profiles and Bots only narrow it (resolveEffectiveTools), and builtin tools join the filter, never the result.
- Proxy and MCP write tools are deny-by-default: they need the write allowlist, the caller's permission and confirm:true on every call.
- Unattended runs never get UNATTENDED_TOOL_DENYLIST tools, and a schedule's opt-ins reach filterUnattendedToolIds only as an explicit argument. Draft-only tools (DISPATCH_TOOL_IDS) run only from the member's own button and never get a surface.
- Tool descriptions and errors are prompt text: claim only what works, name the next step, never point at a tool the caller lacks, and quote interpolated values. Search tools report an empty library differently from no match.
- Never list tools in a system prompt; usage rules belong in the tool description, and a preset prompt may name only is_global tools.
- Constants interpolated into tool descriptions live in zero-import leaf modules (llm/memory-limits.ts, email/limits.ts); an import cycle through tools/registry.ts crashes boot while unit tests pass.
- Build record links only with entityUrl() (@greenhouse/types/entity-links).
- Add loop protections only in prepareAgentLoop() (packages/agent-core/src/agent-loop.ts), which streaming and headless runs share. runAgentInSession() is the only headless runner and needs usageContext. Read usage with usageTotalsFrom(); never send AI SDK objects to clients.
- sprouty.yaml is the only selectable preset; desktop.yaml (proxy and MCP) and eval-judge.yaml are hidden. Change profile YAML, PRESET_PROFILE_IDS (profiles/profile.ts), apps/web/src/lib/agent-constants.ts, profiles/agent-profiles.md and tests/api/agent-profiles.test.ts together.
- Preset YAML is identity-neutral: identity comes from the Bot (profileFromBot, enrichSystemPrompt), and rich-output instructions only from composeRichOutput.
- resolveProfileAsync() errors on a missing Bot or version and never falls back to Sprouty. Unattended runs pin `bot:<id>@<v>`.
- Models are chosen per turn and their options live in config/models.yaml, so profile YAML has no options or extends. Retired profile ids resolve through normalizeProfileId(); never recreate their YAML or rewrite stored ids.
- DeepSeek-family models must use the DeepSeek client (isDeepSeekFamily in packages/agent-core/src/model.ts); through the generic client their thinking options are dropped and auto-titles come back blank.

## Platform, data and runtime
- runtime.dispatch() is the only entry to protected app actions; transports adapt it, and unauthorized records answer 404.
- Authorization precedence is user deny > user allow > role allow > default deny; roles hold only allows.
- Manifests stay JSON-serializable, and any change to one bumps its version or the API will not boot. Declare computed response fields in the manifest, or projection drops them.
- Register every knowledge route in matchKnowledgeAction() (platform/knowledge/http-adapter.ts); unregistered paths answer 404.
- Search knowledge only through searchKnowledgeScopes(), because an unscoped db.knowledgeBase.search() returns private docs. Tree reorder writes only sort_order for verified siblings, and bulk export stays visibility='team'.
- Tables check record field policies on every read, write, query and aggregate (requireTableData). The model can never archive a table or base.
- Chat-card actions claim chat_artifact_receipts (chat/artifact-actions.ts) before their first side effect and never re-arm.
- Runtime is a read model, not an authorization: filter every list, detail and command by source domain, wrap tool execution with runtime/tool-evidence.ts, and offer only commands the domain driver supports.
- Kill switches are parsed only in trusted-execution/kill-switches.ts, fail closed on invalid values and never touch user_features.
- Missions keep only run-bound credentials in the sandbox; the runner never sends confirm:true, and mutations wait for an approval bound to the input hash. Workflows run only from the confirmed plan card, and workflow_plan edits only unconfirmed drafts from its own session.

## Memory, schedules and delivery
- Prompts get memories only through resolveMemoryContext(), titles only and in a stable order. Run sanitizeForPrompt before injecting and validateMemoryText before writing; only the memory tool writes, and consolidation drops merges that fail mergeDilutes.
- Gate features with userHasFeature, never db.userFeatures.isEnabled, which ignores defaults and super.
- scheduler/task-center.ts is the only schedule implementation. The owner is re-read before every run; schedule tools act with scope 'own' and never write unattended_tools; occurrences are keyed by task and time and never replayed; enqueue failures reach the owner.
- Delivery is system behaviour, never a model tool: recipients come from the owner or a binding, webhooks only reach WeCom and Feishu hosts, and a failed delivery never fails a run.
- WeCom and Feishu webhooks answer HTTP 200 on failure: judge a send by the JSON body, as sendWeComMarkdown and sendFeishuMarkdown (packages/utils) do.
- Write new notifications only through publishNotification() (notifications/publish.ts); push payloads carry ids, never content. Delivery bodies render through notifications/render.ts, which escapes raw HTML and keeps only http(s) and mailto links.
- Email sends only the stored draft and rejects a bad draft token; mail text passes sanitizeEmailForLLM; connections go to the resolved public IP; the shared mailbox is super-only in chat.
- The Feishu bot takes identity only from the binding, claims feishu_message_receipts before processing, answers by reply and adds the permission footer in groups.

## Skills, MCP and media
- skills/center.ts owns skill logic and permission checks: scan before persisting, gate quarantine and review only in downloadSkill, treat a missing actor as strictest, keep blocked sticky. First-party names come from the repo-root skillhub/ directory, never tags, and only super publishes them.
- /api/mcp is a thin adapter over the tool proxy. Only normalizeOAuthScopes expands scopes, never parseStoredOAuthScopes; an empty resource group is invalid, and an empty allowedTools list means no tools.
- A new MCP tool names its resource group in meta.surface.mcp. Email tools and automation_mutation stay off MCP. Permissions and grants are re-read on every request.
- Connectors keep credentials out of the url column and logs, send OAuth fetches through guardedMcpFetch, serialize OAuth calls per member and connector (withConnectionLock) with compare-and-set token writes, and return the global Response from mcpFetch.
- mcp_call has no surface and no unattended use, and connectors never run stdio servers.
- generate_image uses fixed low quality and three sizes (resolveSize). IMAGE_BASE_URL and IMAGE_API_KEY come as a pair, and a key is only sent to its own URL.

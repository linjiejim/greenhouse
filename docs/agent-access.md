# Connect your agents

[← Overview](../README.md) · [Complete tool catalog](product-guide.md#tools)

## MCP & agent access

One tool layer, three surfaces; each can only narrow what the member may do:

- **Chat** — Sprouty gets every tool the user is entitled to except the external-only ones
  (`web_search`, `read_url`, the cloud computer).
- **`/api/agent`** — structured tool proxy for programmatic clients and the CLI, authenticated
  with the member's own login access token (no separate API keys): `GET /runtime-manifest`
  lists the caller's available tools (with input schemas), `POST /tools/:id/call` invokes one.
  Read tools run freely; every write requires `confirm: true`. Calls land in the request log;
  they are not write records.
- **`/api/mcp`** — the standard MCP protocol (stateless Streamable HTTP), so any MCP client
  (Codex, Claude Code, Cursor, …) can connect. Auth is **OAuth 2.1 only**: discovery metadata
  (RFC 9728 / RFC 8414), dynamic client registration, Authorization Code + PKCE with a consent
  screen for people, and machine clients (client credentials) that a super binds to a
  least-privilege internal user under Administration → MCP Access. Tokens are stored hashed and
  rate-limited (120 per minute, 10,000 per day). Scopes combine an action (`mcp:read` /
  `mcp:write`) with resource groups (`mcp:knowledge`, `mcp:files`, `mcp:projects`, `mcp:tables`,
  `mcp:skills`, `mcp:chat`, `mcp:automation`, `mcp:feedback`, `mcp:services`, `mcp:computer`,
  `mcp:reports`; extensions add their own). Tools carry the standard annotations (`readOnlyHint`,
  `destructiveHint`, `openWorldHint`).
- **Writes over MCP** run at once as the member and become a write record (run kind
  `agent_write`, risk r1 own / r2 shared / r3 delete-like) with the client, tool, action and exact
  input and output. An r3 call first returns `{"status":"needs_confirmation", …}` with a preview
  and changes nothing; the agent calls again with `confirm: true`. A write whose outcome could not
  be recorded settles as "outcome unknown" and is never replayed.
- **Bounded replies** — a reply longer than 12,000 characters is stored for 24 hours (private to
  the member and the OAuth client) and returned as an 8,000-character preview plus an
  `output_id`; `tool_output_read` pages through the rest and re-checks the caller's current
  permissions on every read.
- **Team context over MCP** — an admin picks team documents as the conventions and the glossary
  (Administration → Team context). Every member's agent gets them, cut to its grant, as
  resources (`greenhouse://context/overview`, `…/conventions`, `…/glossary`), as the
  `team_context` tool for clients without resources ("call it first in a new task"), and
  SkillHub skills plus the member's saved prompts as MCP prompts. `data_catalog` lists the data
  the grant can query. Settings → Agent connections → Connect walks a member through Codex,
  Claude Code, Cursor or any other client and checks that the connection arrived.
- **Paid services over MCP** (`mcp:services`) — `web_search`, `read_url` (public pages only),
  `analyze_image` (an image URL or a file in Files) and `generate_image`, which saves each image
  as a new file on the member's personal Files shelf and is recorded like any other agent write.
  Every call is metered to the member and to the agent's OAuth client.
- **Cloud computer** (`mcp:computer`, off by default) — once an admin turns it on under Services &
  pricing and sets an E2B key, each member's agent can run commands in its own hosted Linux
  sandbox (`computer_exec`), list / read its files, copy files in from Files and save results back
  (`computer_transfer`), and stop it. Created on first use, stopped after 15 idle minutes, at most
  N running per workspace, billed per minute.
- **Reports** (`mcp:reports`) — `report_templates` lists the team's report templates with
  each section's guidance and content shape and validates content without saving; `report_render`
  renders a report or deck from a template (PDF / docx / pptx) into the member's Files as a new
  file, recorded like any other agent write. Rendering is local and not metered.

For both proxy surfaces the effective tool set is `resolveEffectiveTools(user, profile)`
intersected with the proxy allowlist — a tool only appears if it declares the relevant
`surface` in its metadata (see below). The proxy can only *narrow* a user's permissions,
never widen them.

### Model gateway (members' agents on the team's models)

Members' own agents and scripts (Claude Code, Cursor, OpenAI SDKs, any OpenAI- or
Anthropic-compatible tool) can call the team's catalog models with a personal key, metered to
the member in the same USD budgets as everything else:

- A super turns it on: **Administration → Runtime Config → Model gateway** (or the switch on
  **Services & pricing → Gateway keys**; `GATEWAY_ENABLED=true` as the env fallback). Off by
  default; while off every call is refused with 403.
- A member creates a personal key under **Settings → Agent connections → Model gateway**
  (`ghgw_…`, shown once; optional model allow-list and expiry; revocable; this month's spend per
  key). Supers can list and revoke every key under **Services & pricing → Gateway keys**.
- OpenAI wire: base URL `<origin>/api/gateway/openai/v1` (`GET /models`, `POST /chat/completions`).
  Anthropic wire, for Claude Code: `ANTHROPIC_BASE_URL=<origin>/api/gateway/anthropic`,
  `ANTHROPIC_AUTH_TOKEN=ghgw_…` (`/v1/messages`, `/v1/models`, `/v1/messages/count_tokens`).
  A model is served on the Anthropic wire only when its provider declares
  `anthropic_base_url` / `anthropic_base_url_env` in `models.yaml` (`LLM_ANTHROPIC_BASE_URL` for
  the built-in `flash` / `pro`). Model = a catalog id. Not yet: the Responses API (so current
  Codex cannot use it), embeddings, images.
- Every call reserves before it is forwarded and settles from the provider's usage; an
  exhausted budget answers `429` with the reason. Per-key rate limit:
  `GATEWAY_RATE_LIMIT_PER_MINUTE` (default 300).

# Product guide

[← Overview](../README.md) · [中文能力说明](capabilities.md)

## What it can do

### Members' own agents (MCP)

- **Connect** — `/api/mcp` over OAuth 2.1: a member authorizes Codex, Claude Code, Cursor or any
  MCP client from their own account and picks which resource groups it may reach; automation uses
  machine clients a super binds to a least-privilege user. Settings → Agent connections → Connect
  walks a member through it and checks that the connection arrived.
- **Scoped** — an agent sees the member's permissions, narrowed by the granted groups and by
  `mcp:read` / `mcp:write`; it never sees more than the member could do in the app.
- **Recorded** — every write runs at once, as the member, and becomes a write record (client,
  tool, action, exact input and output) in Settings → Agent connections → Activity and the
  Activity log. No approval queue.
- **Deletes preview first** — a delete-like call returns `needs_confirmation` with a preview and
  changes nothing; the agent calls again with `confirm: true` once its user agrees.
- **Bounded replies** — a reply over 12,000 characters comes back as a preview plus an
  `output_id`; the agent pages through the rest with `tool_output_read` (kept 24 hours, private to
  that member and client).
- **Team context** — `team_context`, `data_catalog`, `greenhouse://context/*` resources, and
  SkillHub skills plus saved prompts as MCP prompts.
- **Metered** — paid calls are priced in USD, reserved against budgets and attributed to the
  member and the OAuth client.
- **Model gateway** *(off by default)* — personal `ghgw_…` keys for OpenAI- and Anthropic-compatible
  endpoints on the team's catalog models, metered in the same budgets.

- **Connectors** — the other direction: Sprouty and members' agents call remote MCP servers
  (Linear, Notion, DeepWiki, … — 13 vetted in `connectors/`) through one `mcp_call` tool.
  Administration → Connectors adds them (public, a team credential, or each member's own key or
  OAuth sign-in); read-only tools are on by default, writes are switched on per tool, destructive
  ones preview first. Every call is audited without its arguments; writes land in the Activity log.

Details: [MCP & agent access](agent-access.md#mcp--agent-access).

### Sprouty, the built-in assistant

- Streaming chat with tool-call traces, background runs, attachments of any type (the assistant
  reads text / CSV / JSON / xlsx / docx / PDF; images go to multimodal models directly), a
  per-turn model picker from the catalog, forking, sharing, pinning, and a global ⌘P search.
- Rich answers: charts, sortable tables, stats, cards, steps, Mermaid diagrams and sandboxed HTML
  previews; confirm cards for the things a person must approve (a Tables schema change, a captured
  task, an email draft), each executed exactly once.
- The same assistant runs on the web, in the iOS app, in Feishu (optional bot) and unattended in
  automations.

### Modules

- **Knowledge Base** — team, personal and shared documents with a Tiptap editor, Markdown-first
  storage, folders plus a file cabinet, templates, version history and restore, per-person
  sharing, AI rewrite / enrich / generate, live updates and editing presence, and segmented
  full-text search (CJK-aware).
- **Files** — the team's file cabinet and your own: folders, upload, preview (images, PDF,
  text), rename / move / delete and name search.
- **Projects** — projects, members, tasks in list / board / Gantt views, task comments, activity.
- **Tables** — multidimensional bases: typed fields, views, record links (shown by the linked
  record's primary field), formulas and rollups, archive and restore, and conversational schema planning (the assistant drafts, you
  confirm).
- **Home** — a new conversation: the assistant, a greeting, what is waiting for you, the composer
  and your recent conversations. The team's recent changes (and which agent made them) are a tab
  of the bell, on the web and on the phone.
- **Activity log** — who changed what: members in the app, their agents over MCP (with the
  client's name), automations and admin setting changes, filterable and exportable as CSV.
  Each automation run and agent write keeps its full step, tool-call and event evidence; a run
  cut off mid-way is never re-run on its own: it ends "outcome unknown" and its owner is told
  which writes were in flight.
- **Automations** — cron-scheduled assistant runs with run profiles (saved instructions, a
  model and a tool set) and result delivery to WeCom, Feishu or email. Unattended runs get
  replay-safe reads and web search, plus the tools the owner granted (in settings, or by saying so
  in a web or phone chat); they can never delete, create automations or send email. Runs land in
  the Scheduled tab of conversation history, apart from your own chats.
- **Issues & requests** — feature requests and frictions in one admin queue; members' agents
  can file both over MCP.
- **Monthly retro (复盘)** — at 09:00 on the 1st, in the time zone set under Administration →
  Team context (default Asia/Shanghai), a team document "YYYY-MM 复盘" lands in the knowledge
  folder 复盘: module usage, members' agent writes by client (failed / outcome unknown), top
  frictions and requests, and spend by service — aggregates only — plus a short list of
  suggestions the model writes from those numbers (charged to the team; skipped, with the
  reason, when the budget is used up or no model is set). Admins can also generate this month's
  from Issues & requests.
- **Data catalog** — Tables › Data catalog lists the bases and extension data sources a member
  can read (row counts, owner, last change) and which MCP tool their agent reaches each with.
- **SkillHub** — an org-wide library of agent skills (SKILL.md bundles) with immutable versions,
  changelogs and security scanning; packs placed under `skillhub/` sync in on boot (this
  repository ships none). Its *My prompts* tab holds your reusable prompts, called from the chat
  composer with `/`.
- **Report templates** — the team's required shape for reports and decks (SkillHub › Report
  templates): ordered sections with writing guidance, cover fields and allowed formats. Any
  agent — a member's Codex over MCP or Sprouty — writes content against a template and the
  server renders it to PDF, Word or PowerPoint in the workspace brand (pure JS, Chinese
  included), saving the file to Files. A weekly report and a project review deck ship by default.
- **Email** *(optional)* — personal IMAP/SMTP mailboxes and a shared team mailbox; search,
  read, draft and send with a confirmation card. Not exposed over MCP.
- **Notifications** — an in-app notification center, durable delivery to email, WeCom and
  Feishu, and iOS push (`MOBILE_PUSH_ENABLED`).
- **Memory** — per-user memories with titles, pinning and lifecycle (feature flag `memory`, on by
  default).
- **Services & pricing** — every paid call (models, web search, page reads, images, cloud
  computer minutes) is priced in USD (defaults in `models.yaml` `price` and `services.yaml`,
  editable by an admin, each call keeping the price it was settled at), reserved against monthly
  member, service and team budgets before it runs, and attributed to the member, service and
  client. Members are told at 80% and 100%; an exhausted budget refuses the call with a message
  the agent can read. Review the default limits ($50 per member, $2,000 for the team); Settings
  → Usage shows a member their own month.
- **Cloud computer** *(off by default)* — a hosted Linux sandbox (E2B) per member for their
  agent: created on first use, stopped after 15 idle minutes, at most `COMPUTER_MAX_RUNNING`
  (default 5) at once, billed per minute. Members' agents use it over MCP or `/api/agent`;
  members see its status and start or stop it under Settings → Cloud computer.
- **Module usage** — Administration → Usage → By Modules shows tool calls by tool and client
  (MCP, Agent API, web chat, mobile, Feishu, automations), page opens by module and app, and the
  prompt-cache hit rate per model. Only daily totals are stored — no users, arguments or content.
- **Platform kernel** — applications declare a manifest (modules, entities, fields, actions);
  roles, capabilities and record / field policies are enforced once for HTTP, chat tools, the
  proxy and MCP. One permissions dialog per user.
- **Workspace branding & runtime config** — rebrand from the web (name, logo, theme tokens) and
  manage runtime credentials (LLM / media / search) in Administration; values live in the
  database with env-var fallback and apply without a restart, from the login screen on.
- **Integrations** *(optional)* — Feishu: account binding, sign-in (web and iOS), direct-message
  push and a bot that runs Sprouty in a chat (`FEISHU_BOT_ENABLED=1`). WeCom: account binding and
  direct-message push (no sign-in).
- **Plant avatars** — the assistant and every agent are flat geometric plants (16 species, 7
  tints) whose face follows what they are doing; members' connected agents get one by client.

Roles: **super** and **team** (historical `external` accounts must be converted to team before
they can be activated), plus per-user feature flags (`tables`, `memory`) and platform policies
that gate optional modules. Auth is fail-closed — the server refuses to start without
`TOKEN_SIGNING_KEY`, and stored secrets need `PROVIDER_TOKEN_ENCRYPTION_KEY`.

### Tools

40 built-in tools, one catalog (`apps/api/src/tools/registry.ts`). **Chat** = Sprouty (web,
iOS, Feishu, automations); **MCP** = the resource group a member grants; every MCP tool except
`mcp_call` is also on `/api/agent`.

| Area | Read | Write | MCP group |
|---|---|---|---|
| Knowledge | `knowledge_query` | `knowledge_mutation` | `knowledge` |
| Files | `files_query` | `files_mutation` | `files` |
| Projects | `project_query` | `project_mutation` | `projects` |
| Tables (flag `tables`) | `tables_query` | `tables_mutation`; `tables_schema_plan` (Chat only, confirm card) | `tables` |
| Skills | `skill_query` | `skill_mutation` | `skills` |
| Conversations | `session_query` | — | `chat` |
| Automations | `automation_query` | `automation_mutation` (Chat and `/api/agent` only) | `automation` (read) |
| Issues & requests | `feedback_query` | `feature_request`, `log_friction` | `feedback` |
| Reports | `report_templates` | `report_render` (new file in Files) | `reports` |
| Paid services | `analyze_image`; `web_search`, `read_url` (external only); `external_search` (Chat only) | `generate_image` | `services` |
| Cloud computer (external only) | `computer_files` | `computer_exec`, `computer_transfer`, `computer_stop` | `computer` |
| Connectors | `mcp_call` (list / describe / call) | through the same tool, per the connector's switches | `connectors` (not on `/api/agent`) |
| Email | `email_query` | `email_mutation` (confirm card) | — not on MCP |
| Chat helpers | `ask_user`, `read_attachment`, `compute`, `call_llm`, `memory` (flag `memory`) | `export_data`, `task_capture` | — |

MCP adds three protocol tools for every grant: `team_context`, `data_catalog` and
`tool_output_read`. Writes whose action deletes (`delete`, `remove`, `purge`, `destroy`, `drop`)
take the preview round trip on MCP; on `/api/agent` every write needs `confirm: true`.

Deliberately **not** on MCP: email (its safety is a person reading the draft), `automation_mutation`
(an unattended client that creates automations multiplies), and the confirm-card tools.

### Clients

- **Web** — Home (a new conversation, with recent conversations in the sidebar on every page,
  tabbed Mine / Scheduled / Shared),
  Knowledge, Files, Tables (with the Data catalog), Projects, SkillHub (Skills / My prompts /
  Report templates) and Automations (with Run profiles); the ⌘P palette, a bell for notifications,
  shares and team activity, the Activity log, and the assistant as an overlay on any
  page. Settings: preferences, Agent connections (connected agents, their writes, model gateway
  keys, connect wizard), Feishu / WeCom binding, email accounts, usage, cloud computer, memory.
  Administration: users and permissions, usage, Services & pricing (spend, prices, budgets,
  gateway, computers), activity, Issues & requests, team context, Branding Studio, Runtime Config,
  MCP Access.
- **iOS app** ([`apps/mobile`](../apps/mobile), Expo) — chat with Sprouty (attachments, offline
  outbox, card actions), conversations (Mine / Scheduled / Shared), search across conversations,
  documents, files and automations, Knowledge (browse, create, rename / move / delete; reading
  only, no body editing), Files (a Recent tab first; upload from Photos, camera or Files; folders)
  with Tables (browse, add simple records), Projects (create projects, change task status,
  comment), Automations (pause / resume, run now, run history, delete; new ones are made in a
  chat), notifications with push, and Me (theme, language, text size, push switches, feedback,
  servers, and a read-only view of your agents' spend, writes and gateway keys). Password and Feishu sign-in; several servers
  ("stations") side by side; "My tasks" and "Recent documents" widgets; iPad split view; offline
  copies of recent content; OTA updates.
- **Android** — Material 3 screens exist in the Expo project, but no Android build is published
  and push is not configured.
- **CLI** — `pnpm cli` (see [Quick start](development.md#quick-start-local-development)).

There is no desktop app and no browser extension in 3.0.

### Off by default

Model gateway (`gateway.enabled` / `GATEWAY_ENABLED`) · cloud computer (`computer.enabled` /
`COMPUTER_ENABLED` plus an E2B key) · Feishu bot (`FEISHU_BOT_ENABLED=1`) · mobile push
(`MOBILE_PUSH_ENABLED`) · email (needs mailboxes) · extensions (`greenhouse.config.ts` /
`GREENHOUSE_EXTENSIONS`).

### Removed

Bots, Missions, rooms, evaluations, Workflows, the team LLM relay of 1.x, the desktop app, the
browser extension, session tags and groups, sub-sessions, user groups, document comments and
backlinks, and table forms / dashboards / in-table automations. Old conversations and runs of
removed kinds stay readable.

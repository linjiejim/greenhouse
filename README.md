<p align="center">
  <img src="logos/greenhouse-logo.png" alt="Greenhouse" width="440" />
</p>

<p align="center">
  <a href="https://greenhouse.linjiejim.com"><img alt="Website" src="https://img.shields.io/badge/website-greenhouse.linjiejim.com-0d9488"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0d9488.svg"></a>
  <a href="https://github.com/linjiejim/greenhouse/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/linjiejim/greenhouse?color=0d9488"></a>
  <a href="https://github.com/linjiejim/greenhouse/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/linjiejim/greenhouse/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/linjiejim/greenhouse/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/linjiejim/greenhouse?style=social"></a>
</p>

**The self-hosted Agent hub for your team.** Every member connects their own agent — Codex,
Claude Code, Cursor or any [MCP](https://modelcontextprotocol.io/) client — and it gets the
team's knowledge, files, projects, tables, skills, report templates and paid services, cut to
that member's own permissions. Every write an agent makes is recorded in the member's name; a
delete shows a preview first. Every paid call is priced, budgeted and attributed to the member
and the agent that made it. Members can also run their own agents on the team's models through
an OpenAI- and Anthropic-compatible model gateway.

Inside the app, **Sprouty** is the built-in assistant: chat on the web and the iOS app (and,
optionally, in Feishu), automations on a schedule, all over the same tool layer and the same
permission model your members' agents use. One command to self-host; one process, one
PostgreSQL database.

A full, code-checked list of what 3.0 does lives in **[docs/capabilities.md](docs/capabilities.md)**
(Chinese).

## A quick look

<p align="center">
  <img src="docs/assets/screens/chat-knowledge.gif" alt="Asking the agent about the home-office stipend: it searches the knowledge base and answers with citations" width="960" />
</p>
<p align="center"><sub>Grounded answers: the agent searches the team knowledge base, cites the policy document, and the trace shows every tool call.</sub></p>

<table>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/home.webp" alt="Home: the assistant, a greeting, the composer and recent conversations" />
      <b>Home is a conversation</b> — open the app and type: the assistant, what is waiting for you, and your recent conversations.
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/chat-tables-answer.webp" alt="Chat answer with a rendered data table from a Tables base" />
      <b>Data in chat</b> — the agent queries a Tables base and answers with sortable, exportable tables.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/tables-grid.webp" alt="Tables grid with typed fields" />
      <b>Tables</b> — typed fields, views and record links; the agent plans schemas conversationally.
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/knowledge-doc.webp" alt="Knowledge base document" />
      <b>Knowledge base</b> — team, personal and shared documents with full-text search.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/projects-gantt.webp" alt="Projects portfolio timeline" />
      <b>Projects</b> — portfolio timeline, boards and task trees with members, comments and activity.
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/execution-center.webp" alt="Activity log listing runs" />
      <b>Activity log</b> — automations and your agents’ writes in one place.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/skillhub.webp" alt="SkillHub" />
      <b>SkillHub</b> — versioned SKILL.md bundles with changelogs and security scanning.
    </td>
    <td width="50%" valign="top">
      <img src="docs/assets/screens/admin-permissions-dialog.webp" alt="Per-user permissions dialog" />
      <b>One permissions dialog</b> — roles, capabilities and feature flags, enforced once for HTTP, chat, the proxy and MCP.
    </td>
  </tr>
</table>

<p align="center">
  <img src="docs/assets/screens/chat-knowledge-answer-dark.webp" alt="Dark theme" width="66%" />
  <img src="docs/assets/screens/mobile-chat.webp" alt="Mobile layout" width="19%" />
</p>
<p align="center"><sub>Light / dark / system themes and a responsive layout; the <a href="apps/mobile">iOS app</a> is described under <a href="#clients">Clients</a>.</sub></p>

Every image above is produced by `node scripts/capture-screens.mjs` against a seeded dev stack — the
same script doubles as an end-to-end smoke tour (see [Development](#development)). The images
currently in the repository were captured on an earlier release: navigation, branding and some
labels differ in 3.0.

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

Details: [MCP & agent access](#mcp--agent-access).

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
  model and a tool set) and result delivery to WeCom, Feishu or email. Unattended runs only get
  replay-safe reads plus the tools the owner ticked; they can never create automations or send
  email.
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

39 built-in tools, one catalog (`apps/api/src/tools/registry.ts`). **Chat** = Sprouty (web,
iOS, Feishu, automations); **MCP** = the resource group a member grants; every MCP tool is also on
`/api/agent`.

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
| Email | `email_query` | `email_mutation` (confirm card) | — not on MCP |
| Chat helpers | `ask_user`, `read_attachment`, `compute`, `call_llm`, `memory` (flag `memory`) | `export_data`, `task_capture` | — |

MCP adds three protocol tools for every grant: `team_context`, `data_catalog` and
`tool_output_read`. Writes whose action deletes (`delete`, `remove`, `purge`, `destroy`, `drop`)
take the preview round trip on MCP; on `/api/agent` every write needs `confirm: true`.

Deliberately **not** on MCP: email (its safety is a person reading the draft), `automation_mutation`
(an unattended client that creates automations multiplies), and the confirm-card tools.

### Clients

- **Web** — Home (a new conversation, with recent conversations in the sidebar on every page),
  Knowledge, Files, Tables (with the Data catalog), Projects, SkillHub (Skills / My prompts /
  Report templates) and Automations (with Run profiles); the ⌘P palette, a bell for notifications,
  shares and team activity, the Activity log, and the assistant as an overlay on any
  page. Settings: preferences, Agent connections (connected agents, their writes, model gateway
  keys, connect wizard), Feishu / WeCom binding, email accounts, usage, cloud computer, memory.
  Administration: users and permissions, usage, Services & pricing (spend, prices, budgets,
  gateway, computers), activity, Issues & requests, team context, Branding Studio, Runtime Config,
  MCP Access.
- **iOS app** ([`apps/mobile`](apps/mobile), Expo) — chat with Sprouty (attachments, offline
  outbox, card actions), conversations, Knowledge (browse, create, rename / move / delete; reading
  only, no body editing), Files (upload from Photos, camera or Files; folders) with Tables (browse,
  add simple records), Projects (create projects, change task status, comment), notifications with
  push, and Me (theme, language, text size, push switches, feedback, servers, and a read-only view
  of your agents' spend, writes and gateway keys). Password and Feishu sign-in; several servers
  ("stations") side by side; "My tasks" and "Recent documents" widgets; iPad split view; offline
  copies of recent content; OTA updates.
- **Android** — Material 3 screens exist in the Expo project, but no Android build is published
  and push is not configured.
- **CLI** — `pnpm cli` (see [Quick start](#quick-start-local-development)).

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

## Architecture

A pnpm monorepo. The Hono API also serves the built React SPA, so production is a single
process / single container.

```
greenhouse/
├── apps/
│   ├── api/                  # Hono backend — routes, agent runtime, platform kernel, auth,
│   │                         #   scheduler, runtime kernel, CLI; also serves the web SPA at `/`
│   ├── web/                  # React + Vite single-page app (hash router)
│   └── mobile/               # Expo (React Native) iOS app — Sprouty chat, knowledge, files +
│                             #   tables, projects, notifications + push, widgets, stations;
│                             #   isolated install (pnpm mobile:install, then pnpm mobile)
├── packages/
│   ├── agent-core/           # Agent kernel — streamText loop, OpenAI-compatible model factory
│   │                         #   + registry, provider quirks (no DB dependency)
│   ├── platform-kernel/      # Application manifests, actor context, authorization, registry
│   ├── types/                # Shared TypeScript types (feature flags, workspace settings, …)
│   ├── utils/                # Shared helpers (date, json, crypto, logger, semver, webhooks)
│   ├── db/                   # Database layer — Drizzle schema + domain services
│   ├── knowledge-editor/     # Tiptap schema + server-side Markdown ↔ Tiptap JSON
│   ├── crud/                 # Low-code CRUD pages for the web (one schema → list / form / detail)
│   ├── ui/                   # Shared UI pieces — the plant-avatar renderer (web + mobile)
│   └── contract/             # Typed API contract — re-exports the API's AppType + hc
├── skillhub/                 # Skill-pack format + sync source for SkillHub (no packs shipped)
├── drizzle/                  # Migration files (the single source of truth for the schema)
├── scripts/                  # gen-secrets, backup-db, run-dev, e2e-ci, capture-screens,
│                             #   build-landing, check-extension-overlay, skillhub-sync, …
└── tests/                    # unit / db / e2e (API) / e2e-ui (Playwright)
```

**Stack:** [Hono](https://hono.dev/) API · React 19 + [Vite](https://vite.dev/) ·
PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team/) · any OpenAI-compatible LLM ·
Node.js 22 (ESM, run via `tsx`).

Full package conventions live in [AGENTS.md](./AGENTS.md).

## Quick start (local development)

Prerequisites: Node.js ≥ 22, pnpm ≥ 11, Docker (for PostgreSQL).

```bash
# 1. Start just Postgres (bound to 127.0.0.1:5432)
docker compose up -d postgres

# 2. Install deps
pnpm install

# 3. Configure secrets + LLM
cp .env.example .env && ./scripts/gen-secrets.sh   # fills the required random secrets
#   then edit .env and set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# 4. Apply the migration chain (refuses a 1.x / 2.x database — see "Upgrading from 1.x to 3.0")
pnpm db:migrate

# 5. Create the first super-admin — or skip to step 6 to load the demo dataset instead
pnpm admin:create

# 6. (optional) Load the example dataset (it bundles demo admins) to explore with
#    realistic content. Fresh DB: no flag needed. To re-seed a populated DB, use
#    `pnpm seed --reset` (wipes first, asks to confirm).
pnpm seed

# 7. Run the dev servers (Vite web :3100 + API :3000, Vite proxies /api → api)
pnpm dev
```

Open http://localhost:3100. Backend changes require a restart (the API has no `--watch`);
frontend changes hot-reload.

> **One-command acceptance environment** — `pnpm run-dev up` starts Postgres + API + web
> together with unified logs under `.run-dev/`, avoids port clashes automatically, and gives
> each git worktree its own sandbox database (`greenhouse_wt_<dir>`); `pnpm run-dev stop`
> tears it down.

> **Custom ports** — if `:3100`/`:3000` clash with something, set `WEB_PORT` / `API_PORT` in
> `.env` (or as shell vars, which take precedence); the web dev proxy follows `API_PORT`.

> **Example dataset** — `pnpm seed` loads a small, de-identified fictional company (users,
> knowledge base, projects, chats, automations, a run profile, sharing) so you can experience
> and validate every major feature. Every seeded user logs in with the password `greenhouse`
> (e.g. `maya@greenhouse.example`). See [`data/examples/README.md`](data/examples/README.md).
> On a non-empty database it refuses unless you pass `--reset` (wipe first) or `--keep`.

> **CLI console** — `pnpm cli <command>` is the dev/ops entry point for a self-hosted
> instance, mostly in-process (no running server needed): `users`, `tools`, `profiles`,
> `sessions`, `seed`, `db`, `doctor` (env + DB readiness), `knowledge` (reindex / import a
> folder of Markdown), `tables`, `platform` (scaffold an application), and `chat` (needs a
> running server). Run `pnpm cli --help` for the full guide.

## One-command Docker deploy

The bundled `docker-compose.yml` runs Postgres, a one-shot migration job, and the API
(which serves the SPA) as a single self-contained image.

```bash
cp .env.example .env && ./scripts/gen-secrets.sh   # fills required secrets
#   edit .env: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
docker compose up -d --build
docker compose exec api pnpm admin:create          # create the first super-admin
```

The app is then at http://localhost:3000.

Prefer the published image over a source build? Use
[`docker-compose.ghcr.yml`](./docker-compose.ghcr.yml) instead — same stack, but it
pulls `ghcr.io/linjiejim/greenhouse` (no Node/pnpm toolchain needed):

```bash
docker compose -f docker-compose.ghcr.yml up -d    # defaults to :latest; pin a 3.x tag via GREENHOUSE_IMAGE in .env
```

## Releases & stability

**Use a tagged release in production.** Two channels, and they are not equally
stable:

| You want… | Use | Stability |
|---|---|---|
| A version to run in production | A **tagged release** `vX.Y.Z` — [Releases](https://github.com/linjiejim/greenhouse/releases) · image `ghcr.io/linjiejim/greenhouse:X.Y.Z` (or `:X.Y`) | **Stable** — a cut we stand behind |
| The bleeding edge / to test `main` | `ghcr.io/linjiejim/greenhouse:edge` (or `:main-<sha>`) | **Unstable** — CI builds off `main`; may break between releases |

What the release workflow (`.github/workflows/release.yml`) does today: a `v*` tag publishes
`:X.Y.Z` and `:X.Y`; a push to `main` publishes `:edge` and `:main-<sha>`. It never moves
`:latest`, so `docker-compose.ghcr.yml` (which defaults to `:latest`) should be pinned to a 3.x
tag with `GREENHOUSE_IMAGE`. The image carries its version and commit as the
`APP_VERSION` / `APP_REVISION` environment variables and the matching OCI labels;
`GET /health` reports database status, the runtime kill-switches and the push switch, not the
version.

The **mobile app** ships on its own cadence via EAS (`.github/workflows/mobile.yml`, on
`main`): JS-only changes roll out as over-the-air updates; native changes build and upload to
TestFlight. Maintainer runbook: **[RELEASING.md](./RELEASING.md)**.

### Upgrading from 1.x to 3.0

3.0 rebuilds the database schema (72 tables, text ids, jsonb, one table per concept), so a
1.x database is never migrated in place. You create a **new, empty database** and carry the
data into it with one command; the old database is only read, never written, and stays your
rollback path.

- The source must be on **1.6.x** (its migrations through `0013_report_templates`). Upgrade an
  older 1.x install to 1.6 first.
- **2.x databases are refused** — 3.0 can neither run on nor carry a 2.x database.
- Ids are kept (old numeric ids become strings), so links, extension rows that store a user id
  and ids an external agent remembered keep working; connected agents don't re-authorize.
- Extension tables (`crm_*`, …) and `extension_migrations` are copied verbatim.
- Not carried: retired and removed features (evaluation, Missions, Workflows, session tags,
  user groups, document comments / backlinks, table forms / dashboards / in-table automations),
  run events older than 30 days, delivered outbox rows, expired tokens, rate-limit counters and
  request logs older than 30 days. Every skipped row is counted in the report.
- The command is repeatable: a non-empty target is emptied first, so you can re-run it until the
  reconciliation report is clean.

Bare-metal / source checkout:

```bash
./scripts/backup-db.sh                                   # 1. back up the 1.x database
createdb greenhouse_v3                                   # 2. a new, empty database
pnpm cli migrate-from-1x --dry-run \
  --from postgresql://greenhouse:greenhouse@localhost:5432/greenhouse   # 3. report only
pnpm cli migrate-from-1x \
  --from postgresql://greenhouse:greenhouse@localhost:5432/greenhouse \
  --to   postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_v3   # 4. carry
# 5. point DATABASE_URL at greenhouse_v3 and start the 3.0 API
```

Docker (the `migrate` service of the 3.0 image runs the command; stop the API first):

```bash
docker compose stop api
PG_CONTAINER=<your postgres container> ./scripts/backup-db.sh
docker compose exec postgres createdb -U greenhouse greenhouse_v3
docker compose run --rm migrate ./node_modules/.bin/tsx apps/api/src/cli/index.ts migrate-from-1x \
  --from postgresql://greenhouse:greenhouse@postgres:5432/greenhouse \
  --to   postgresql://greenhouse:greenhouse@postgres:5432/greenhouse_v3 --dry-run
# drop --dry-run to carry, then set DATABASE_URL on the migrate and api services to
# …/greenhouse_v3 and `docker compose up -d`
```

Add `--json` for a machine-readable report. The command exits with code 2 when it refuses (a
2.x or pre-1.6 source, a 1.x or foreign target, the same database twice) and with code 3
("Carry failed:") when it stops after it started writing. The target is marked as carrying
until a run completes, so a half-carried database is refused by `pnpm db:migrate` and the API
boot; fix the cause and run the same command again. To roll back, point
the 1.x deployment at the untouched old database; anything written in 3.0 afterwards stays in
the new one.

### Upgrading within 3.x

Database migrations ship inside the image and are applied by a one-shot `migrate`
service **before** the API starts — an upgraded deployment never runs new code
against an old schema, and already-applied migrations are skipped. Optional but
wise before a big jump: `./scripts/backup-db.sh`.

**Coming from 1.x?** 3.0 does not upgrade a 1.x database in place — the `migrate`
service and the API refuse it. Follow [Upgrading from 1.x to 3.0](#upgrading-from-1x-to-30)
above instead of the commands below.

```bash
# Docker, published image (docker-compose.ghcr.yml):
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d

# Docker, built from source (a fork / local checkout):
git pull && docker compose up -d --build

# Bare-metal source checkout:
git pull && pnpm install && pnpm db:migrate   # then restart the API
```

### Historical 1.x upgrade notes

These describe upgrades inside the 1.x line. A 3.0 install starts from the new baseline, so the
tables they mention are simply absent; they are kept for readers still on 1.x.

> **Upgrading to 1.5** — Greenhouse narrows to a team agent hub: members bring their own
> agents over MCP, and the in-app agent is an assistant. The desktop app (Tauri shell) is
> removed — use the web app in a browser; installed shells stop receiving updates. The browser
> extension (Greenhouse Bridge) is removed and no longer attached to releases; conversations it
> started stay readable and keep their read-only tool face. Session tags and custom session
> folders are removed from the web and mobile apps (`/api/session-tags`, `/api/session-groups`
> are gone; pinning stays). There is no migration: the tables stay untouched in 1.5 and are
> dropped in the next release. Sub-sessions (the `spawn_session` tool and its background
> Subagent runs) are removed: Subagent runs still active at upgrade are closed on first boot,
> historical ones stay readable in the Execution center, and `RUNTIME_SUBAGENT_DRIVER_ENABLED`
> can be removed from `.env`. *My prompts* (formerly the standalone Tasks page, `#/tasks`) moved
> into SkillHub as its second tab, and *My Agents* (`#/agents`) into Automations as the
> *Run profiles* tab; old links redirect. Custom agents, the chat agent picker and
> automations that run as `custom:<id>@<v>` are unchanged.

> **Upgrading to 1.4** — Evaluation, Missions (the cloud-agent sandbox), the team LLM relay
> (`/api/llm`, relay keys, AI Gateway admin page) and Workflows are removed. There is no
> migration: their tables stay untouched so a rollback to 1.3.x keeps working, and are
> dropped in the following release. Old Mission / Workflow conversations stay readable but
> can no longer be continued, historical Eval / Mission / Workflow runs stay readable in the
> Execution center (runs still active at upgrade are closed on first boot), and the
> sandbox host setup (`runsc`, the agent-runtime image, `MISSION_*` / `SANDBOX_RUNNER_*`
> env) can be decommissioned. MCP machine clients and their audit log are unaffected.
> Custom agents lose the review lifecycle (draft → review → pilot → verified) and the
> automatic review worker (`AGENT_GOVERNANCE_ENABLED` can be removed): an agent is private to
> its owner unless a super makes it available to the team, and everyone who picks it gets its
> current version. Agents that were verified or in pilot stay shared; previously archived or
> suspended agents become visible to their owners again. Automations may now run every 15
> minutes.

> **Upgrading from 0.6.x** — this line removes the public/guest surface (`/api/v1`, the
> `default` profile, external accounts) and the database-managed LLM gateway upstreams in
> favour of the model catalog below. The migration retires external accounts, disables
> legacy agent-to-agent API keys, and drops email accounts (they must be re-added under
> Settings → Email with explicit IMAP/SMTP settings). Existing custom agents become
> immutable draft v1 and stay unshared until a super publishes them. Knowledge documents are
> re-tokenized for search on the first boot.

## Configuration

Everything is environment-driven; see [.env.example](./.env.example) for the full list.

**Required** (the server refuses to start without `TOKEN_SIGNING_KEY`; stored secrets need `PROVIDER_TOKEN_ENCRYPTION_KEY`):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `TOKEN_SIGNING_KEY` | Signing key for auth tokens (`openssl rand -hex 32`) |
| `PROVIDER_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored secrets — email passwords, integration tokens, workspace-setting secrets (`openssl rand -hex 32`) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Any OpenAI-compatible endpoint; the `flash` catalog entry resolves to `LLM_MODEL` (add a stronger `pro` with `LLM_MODEL_PRO`) |

**Model catalog** — `apps/api/src/config/models.yaml` is the single definition of every model
a deployment can use: the built-in `flash` / `pro` entries follow `LLM_*`, and the native
DeepSeek V4.1 Flash entry (`deepseek-flash`) appears in the chat picker as soon as
`DEEPSEEK_API_KEY` is set. Add a provider entry to offer another model; secrets never live in
the file. An optional `price` (USD per 1M input / output / cached-input tokens) feeds metering;
non-model services are priced in `apps/api/src/config/services.yaml`. The default model is treated as multimodal: images attached in Chat go straight into
its payload. Set `LLM_VISION=false` when `LLM_MODEL` is text-only, and images go through
`analyze_image` instead.

Optional: media (vision `analyze_image` + `generate_image` through `MEDIA_*`, falling back to
the LLM endpoint; `IMAGE_BASE_URL` + `IMAGE_API_KEY` move generation alone to an image
provider), external web search, email mailboxes, WeCom / Feishu, usage budgets, and
object storage. Uploads default to local disk (`data/uploads`), SkillHub
bundles to `data/skills` — set all four `SKILLS_S3_*` to keep bundles in S3-compatible storage.

**Admin-configurable at runtime**: the LLM / media / search credentials and the product name
can also be set in **Administration → Runtime Config** (and branding in **Branding Studio**) —
values saved there are stored in the database (secrets encrypted with
`PROVIDER_TOKEN_ENCRYPTION_KEY`), win over the env vars, and apply without a restart.

**Structure lives in code**: [`greenhouse.config.ts`](./greenhouse.config.ts) (typed, validated
at boot) declares which extensions are switched on, where content packs live (skill packs,
agent profiles, a seed dataset) and how client builds (the mobile app) treat server
stations. `GREENHOUSE_EXTENSIONS=example` (a comma-separated list) overrides it per deployment.

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

## Adding a tool

A tool's metadata and implementation live in one file, declared with `defineTool`, and the
tool is registered with one line in `CORE_TOOL_MODULES` (`apps/api/src/tools/registry.ts`).
A tool that needs nothing about the caller is **static**: it is built once, and `create`
receives the shared database handle.

```ts
// apps/api/src/tools/my-tool.ts
const meta: ToolMeta = {
  id: 'my_tool',
  name: 'My Tool',
  brief: 'one-line summary for catalogs and the permissions UI (never sent to the model)',
  description: 'full usage instructions — this is what the model reads, on every step',
  category: 'team', // 'core' | 'team' | 'admin'
  is_global: true, // on for every internal user, no assignment needed
  icon: 'Wrench', // Lucide icon name
  sort_order: 50,
  surface: {
    proxy: 'read', // 'read' (no confirm) | 'write' (confirm-gated) | 'none'
    mcp: 'knowledge', // MCP resource group (needs a proxy tier); omit to keep it off /api/mcp
  },
};

export function createMyTool(db: DatabaseProvider) {
  return tool({ description: meta.description /* , inputSchema, execute: uses db */ });
}

export const myTool = defineTool({ meta, kind: 'static', create: (db) => createMyTool(db) });
```

A tool that must know who is calling is **lazy**: it is built per request, so every read and
write can be scoped to that user. A core lazy tool declares no `create`; its file exports the
factory, and the factory gets one construction case in `buildLazyServerTools`
(`apps/api/src/agent-runtime/tool-resolution.ts`). Tools bound to a conversation go inside that
function's `if (sessionId)` block, so they never appear on the stateless `/api/agent` and
`/api/mcp` surfaces. Extension tools skip this step: they set `createLazy(ctx)` and are built
through a generic path (see [Extensions](#extensions)).

```ts
// apps/api/src/tools/my-user-tool.ts
const meta: ToolMeta = { id: 'my_user_tool' /* , …the same fields as above */ };

export function createMyUserTool(db: DatabaseProvider, ctx: { userId: string }) {
  return tool({ description: meta.description /* , inputSchema, execute: filters by ctx.userId */ });
}

export const myUserTool = defineTool({ meta, kind: 'lazy' });

// apps/api/src/agent-runtime/tool-resolution.ts, inside buildLazyServerTools
if (effectiveTools.includes('my_user_tool')) {
  tools.my_user_tool = createMyUserTool(db, { userId });
}
```

There is no per-tool access guard to declare. Who may call a tool is resolved before anything
is built: `super` gets every tool; a `team` member gets the `is_global` tools, the tools owned
by each feature flag they have, and any tools assigned to them individually. A run profile can
only narrow that set, and each surface narrows it again (the proxy allowlists and OAuth scopes,
the unattended denylist for scheduled runs). Ownership of the data itself is checked inside the
tool, against the `userId` its factory received.

The registry derives every exposure set from the catalog, with no hand-maintained id lists: the
read and write proxy allowlists, the MCP set per resource group, the builtin
set, and the lazy id list all come from each tool's `meta.surface` / `builtin` / `kind`. Guard
tests pin the result: `tools/__tests__/surface-derivation.test.ts` fixes the exact core members
of the proxy, MCP and lazy sets (an intentional exposure change edits the tool and
the test together), and `description-budget.test.ts` caps the combined length of tool
descriptions, since every one is sent to the model on every step.

The other `meta` fields: `surface.unattendedReplaySafe` (may run with nobody present and be retried), `builtin` (part of
every run profile, even one that did not list it), `runtime_risk` (the risk class recorded
on each call when the surface does not imply it) and `presentation` (`'artifact'` marks a
result that renders as an inline card rather than a trace row). The header of
`apps/api/src/tools/define.ts` is the field-by-field reference.

Optional modules are gated by per-user feature flags (`packages/types/src/features.ts`) and
by **feature points** (`apps/api/src/platform/feature-points.ts`), which map a flag or an
application to the tools it owns so one switch controls the app, REST, MCP and chat at once.
A non-global tool that no flag or application owns lands in the *Advanced tools* bucket and is
granted per user.

## Adding an application

Larger modules are **platform applications**: a JSON-serializable manifest (modules, entities,
fields, actions, navigation) plus a registration that binds handlers. The kernel enforces
capabilities and record / field policies once, for every transport. Scaffold a fail-closed
starting point with:

```bash
pnpm cli platform create-app my-app --title "My App"
```

See [EXTENDING.md](./EXTENDING.md) for the full map of extension points.

## Extensions

Private or optional modules do not need to touch core at all. An **extension** is two folders
and two list entries:

```
apps/api/src/extensions/<id>/    tools, routes, tables + migrations, services, jobs, commands, flags, settings
apps/web/src/extensions/<id>/    pages, navigation, settings modules, translations, chat cards
apps/api/src/extensions/index.ts one import line   ·   apps/web/src/extensions/index.ts one import line
```

Each half exports one object — `defineExtension({...})` / `defineWebExtension({...})` — whose
fields map 1:1 onto the core registries: the tool catalog (and with it `/api/agent` and
`/api/mcp`), route mounting, platform applications, feature flags and points (one switch in
the permissions dialog), Runtime Config settings, public paths, the scheduler, the CLI, the
database services, a dedicated **migration lane** (`extension_migrations`, applied at boot under
an advisory lock), record kinds with deeplinks and chat peeks, lanes in global search, whole-dataset
sources for `export_data`, its own scope in the shared file Drive, MCP consent groups, the hash router (including a page's own sub-modules), the sidebar, i18n, tool
cards and the agent panel. Which extensions are *active* is decided per deployment by
`greenhouse.config.ts` or `GREENHOUSE_EXTENSIONS`; an inactive extension contributes nothing —
no tools, no routes, no migrations.

The shipped `example` extension (off by default; `GREENHOUSE_EXTENSIONS=example` to try it) is a
complete reference — per-user notes with their own table, tool, API, page, "More" entry,
Settings module, Runtime Config section, job and CLI command. Forks keep their modules under
`apps/*/src/extensions/`, content under `packs/`, and run `scripts/check-extension-overlay.mjs`
in CI so a commit outside the seam fails instead of drifting from upstream. The full contract
and the fork workflow are in [EXTENDING.md](./EXTENDING.md#extensions).

## Development

```bash
pnpm dev            # Vite web (:3100) + API (:3000), proxied
pnpm test           # every layer: unit + db (transaction-isolated) + db-commit
pnpm test:unit      # fast feedback: unit / contract tests only
pnpm test:db        # database integration tests (needs a migrated greenhouse_test)
pnpm test:e2e:ci    # live-server API e2e suite, self-contained (boots the API, dead LLM)
pnpm test:e2e:ui    # Playwright browser suite (tests/e2e-ui; auto-starts pnpm dev)
pnpm typecheck      # tsc --noEmit
pnpm lint           # eslint + prettier --check
pnpm lint:fix       # auto-fix
```

### Screenshot tour (visual smoke test)

```bash
pnpm dev                         # or pnpm run-dev up — with `pnpm seed` loaded
node scripts/capture-screens.mjs # logs in as the seeded super, seeds a demo base, walks every surface
```

The tour writes `docs/assets/screens/*.webp` (plus a chat `gif`/`mp4`, needs `ffmpeg` and `cwebp`)
and exits non-zero on any console error or failed `/api` request, so it doubles as a real-browser
smoke test. Re-run it after visible UI changes so the README and landing page stay truthful.

A husky + lint-staged pre-commit hook runs `eslint --fix` + `prettier --write` on staged
files. CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → e2e → secret-scan on
pushes to `main` and `v1` and on every pull request.

### Database migrations

Migration files are the single source of truth for the schema. The chain starts at the 3.0
baseline `drizzle/0000_v3_baseline.sql`; the 1.x chain lives in `drizzle/archive-1x/` and is
only read to recognize a 1.x database. Edit `packages/db/src/schema/*.ts`, run
`pnpm drizzle-kit generate`, review the generated SQL, commit it, and apply it with
`pnpm db:migrate` (it refuses 1.x and 2.x databases). **On persistent / shared databases use
`pnpm db:migrate` only — never `push`** (`push` is for throwaway local scratch DBs). See
[packages/db/src/AGENTS.md](./packages/db/src/AGENTS.md) and the table map in
[packages/db/src/db-schema.md](./packages/db/src/db-schema.md).

### Backups

```bash
./scripts/backup-db.sh                                   # dump to data/db/backups/
PG_CONTAINER=greenhouse-postgres-1 ./scripts/backup-db.sh /srv/backups   # docker compose stack
```

Every dump is **verified** before it counts (gzip integrity, a size floor, pg_dump's own
completion marker) — a failed dump leaves no file behind, so a cron log or mail shows the
failure instead of an empty archive that looks like a way back. Retention keeps the newest
seven plus eight Sunday dumps and only ever touches files the script named itself
(`<prefix>_YYYYmmdd_HHMMSS.sql.gz`); hand-made archives next to them are left alone.
`PG_CONTAINER` / `PG_USER` / `PG_DB` / `BACKUP_PREFIX` / `KEEP_DAILY` / `KEEP_WEEKLY` select
the target and the policy.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the
quality gates, and conventions, and please follow the
[Code of Conduct](./CODE_OF_CONDUCT.md). Found a security issue? Don't open a public
issue — see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) — © Greenhouse contributors.

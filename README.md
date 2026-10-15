<p align="center"><img src="logos/greenhouse-logo.png" alt="Greenhouse" width="400" /></p>

# Greenhouse v2

An open-source, self-hosted workspace where members work with their own AI Agents on shared knowledge, tables and apps. Each member has a main Agent and can create more. Conversations, background runs and external MCP clients use the same services and permissions.

**This branch prepares v2.0.** v2 is a rewrite with a new database. It is not an in-place upgrade from v1. Published releases still come from `main`; use a separate database and storage when trying this branch. See the [v1 migration guide](docs/product/migration-v1.md) before moving an existing deployment.

[中文产品说明](docs/product/prd.md) · [Feature status](docs/product/features.md) · [API](docs/product/api.md) · [Provider configuration](docs/product/providers.md) · [MIT license](LICENSE)

## A look inside

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/v2/conversation-dark.webp" />
  <img src="docs/assets/v2/conversation-light.webp" alt="Greenhouse v2 conversation with a knowledge source" width="1200" />
</picture>

Screenshots use seeded sample data and a scripted model. [Regenerate them](#screenshots) against the local preview stack.

- **Conversations:** a main thread, direct Agent conversations, separate chats and rooms. Replies include sources, rich results and requests for a member's decision. Voice input and read-aloud use configured services, with browser fallbacks.
- **Agents and runs:** profiles, abilities, memory, schedules, optional computers (full screen, start queue, encrypted home backups) and mailboxes. Long work runs in the background; its progress, decisions and results stay visible. Agents can page through long tool outputs; reading stored public research keeps web access available, while private reads close it for background runs. Reversible and external writes use the approval tiers described in [always-on.md](docs/product/always-on.md). Approval cards show named changes and safe Markdown previews; same-turn table writes share one receipt and batch undo. Browser screenshots appear as reply images even with a text-only model. Room drafts survive consecutive sends, and room replies show each Agent’s face and owner. Background proposals describe actual network access; empty active-run lists link to recent finished work. Step failures explain permission and budget limits; memory pages keep notes separate from work logs.
- **Knowledge:** shared and personal folders, documents and files; an editor, versions, comments, sharing and cited answers.
- **Tables:** typed and computed fields, grid, kanban, calendar, gallery, timeline, dashboards, internal forms, access roles and automations. The project template uses the same tables and views.
- **Apps:** build pages on a table base, publish an immutable version to internal members and manage reviewed templates. Runtime actions obey both table access and application roles. External data cards read through the viewer's own connections; custom code cards run in an isolated frame after an admin reviews each published version.
- **Skills and connections:** reusable skills, approved MCP connectors, personal connections and OAuth/PAT access for external clients acting as a member.
- **Administration:** members and roles, services, usage with workspace, member, provider and published-Agent monthly budgets, computers, and operations switches that pause background runs, computers or outgoing mail. Private extensions add routes, pages, tools and their own migrations; see [EXTENDING.md](EXTENDING.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/v2/tables-dark.webp" />
  <img src="docs/assets/v2/tables-light.webp" alt="The project template in Greenhouse v2 Tables" width="1200" loading="lazy" />
</picture>

## Native apps

The [native API v2 app](apps/mobile) opens the main thread with Greeny, conversations, Agents, runs, needs-you cards, notifications and the live computer. iOS uses system navigation, SwiftUI forms and Liquid Glass controls; Android uses Material 3 forms, menus and dialogs.

Knowledge includes spaces and folders, safe Markdown reading and source editing, versions, comments and mentions, sharing, signed file previews and search. Tables use phone record lists with a grid switch, kanban, agendas and read-only timelines; records and internal forms use native sheets. The grid shows the view's first six visible fields; record details show all readable fields. Agent mailboxes show allowed senders and held mail, with mail cards in conversations. Configured transcription fills the composer without sending; read-aloud uses the speech service or device voice.

Published apps open native runtime pages, record details, forms, charts and confirmed actions. Reads and writes retain the publication version and access boundaries; building and publishing stay on the web. The builder shows the published version, pending changes and an Open action; record fields use their configured currency and precision. Always-on flows include reversible write receipts and undo, tier2 standing approvals, quiet schedules, record handoffs and event lines.

Native directories filter loaded names and clear when left. Agent profiles show memory and monthly usage with budgets; shared notes and account password/About me edits are available on the phone. Computer queues show their position, and computer/background/mail pauses explain what is waiting in the selected language. Approval sheets render safe Markdown previews with expand; write receipts keep document names and batch actions.

The launch cover leaves when authentication, fonts and the focused page are ready. Its 650 ms logo animation adds no minimum wait; unsettled content gets up to 900 ms before showing loading or retry. On iOS, chat and computer files use native Quick Look for PDF, images and system-supported formats, with sharing and saving available.

The app has an isolated install: `pnpm mobile:install`, then `pnpm mobile`. Use a native development client on an iOS simulator or Android device; Expo Go cannot run it. See [mobile rules](apps/mobile/AGENTS.md) for platform checks and [RELEASING.md](RELEASING.md) for native builds.

## Start with Docker Compose

Install Docker with Compose, then use a fresh checkout and a new Compose project for v2:

```sh
git clone https://github.com/linjiejim/greenhouse.git
cd greenhouse
git checkout v2
cp .env.example .env
./scripts/gen-secrets.sh
```

Edit `.env` before starting:

```dotenv
BOOTSTRAP_ADMIN_EMAIL=you@example.com
PUBLIC_URL=http://localhost:3000
LLM_PROVIDER=deepseek
LLM_API_KEY=your-provider-key
LLM_MODEL=deepseek-chat
# Keep an existing v1 Postgres port available:
POSTGRES_BIND=127.0.0.1:55432
```

Choose an unused loopback port for `POSTGRES_BIND` if 55432 is already occupied. `DATABASE_URL` inside Compose is supplied by the service configuration. The generated signing, provider-encryption and vault keys must persist across restarts.

```sh
docker compose -p greenhouse-v2 up -d --build
docker compose -p greenhouse-v2 logs api | rg 'Activate the first administrator'
```

Open the one-time activation link to set the first admin's password. The app is at <http://localhost:3000>. The bootstrap creates an admin only when none exists; it never promotes an existing account. Admins invite other internal members. There is no guest or anonymous workspace access.

Set `PUBLIC_URL` to the real HTTPS URL behind your reverse proxy. Configure trusted proxies in `.env.example` for your topology. Compose persists Postgres in `pg_data` and files/skill bundles in `app_data`; back up both volumes together with `.env` before replacing a deployment. Do not reuse a v1 volume or run `docker compose down -v` on data you need.

## Configure services

Use **Admin → Services** (管理 → 服务) or initialize from `.env`. Once an admin saves a capability's order, that saved configuration takes precedence over its environment defaults. Instances have explicit addresses, models, secrets and fallback order. Secrets are encrypted at rest and are never returned to clients.

| Capability | Configuration |
| --- | --- |
| Models | `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`, optional `LLM_BASE_URL`; `LLM_MODEL_FAST` for titles/summaries and `LLM_MODEL_STRONG` for a second choice. OpenAI, Anthropic, Gemini, compatible APIs and local Ollama are supported. |
| Search | `SEARCH_PROVIDER` is a comma-separated fallback order, with each provider's key; SearXNG uses `SEARXNG_URL`. |
| Voice | `STT_*` for transcription, `TTS_*` for read-aloud. Without a service the web app uses browser speech features when available. Service usage includes audio seconds and spoken characters. |
| Images and video | `IMAGE_*` and `VIDEO_*`, or configure an instance in Admin → Services. Video is queued work with progress in Runs. |
| Storage | Local files by default; `STORAGE_*` configures S3-compatible storage. File reads use expiring, member-scoped signed URLs. |
| Computers | Hosted E2B-compatible sandboxes for Compose, or Docker when the API runs on the host; see below. |
| Mail | Resend or Mailgun for system mail and Agent mailboxes; SMTP sends system mail only. A member's own IMAP/SMTP mailbox is a personal connection. |

A YAML file (`PROVIDERS_FILE`) supports several instances and fallback chains. See [providers.md](docs/product/providers.md) for adapters, preset addresses, model lists, budgets and the resolution order.

### Mail

For SMTP, set `SMTP_HOST`, `SMTP_SECURITY` (`starttls`, `tls` or `none`), `SMTP_FROM` and optional port/user/password. The default ports are 587/465/25 respectively.

For receiving, configure Resend or Mailgun in Admin → Services → Mail, verify the provider's sending/receiving domain and enter its webhook verification secret. Set the Agent address domain there or through `MAIL_AGENT_DOMAIN`. Configure the provider's notice URL as `PUBLIC_URL/api/mail/inbound/<instance-id>`. A verified notice queues a fetch from that provider; an HTTP acknowledgement does not mean delivery to an Agent. Unknown senders are held for the owner to decide. See [API mail routes](docs/product/api.md) and [provider configuration](docs/product/providers.md).

### Agent computers

Compose uses **E2B or an E2B-compatible host**:

```dotenv
SANDBOX_PROVIDER=e2b
SANDBOX_API_KEY=your-sandbox-key
SANDBOX_E2B_TEMPLATE=your-template-id
SANDBOX_E2B_NAMESPACE=greenhouse-v2
```

Build the template with `node --import tsx scripts/e2b-template.mts`; see [the computer image definition](apps/bot-computer/Dockerfile). Another deployment on the same provider account needs its own namespace. Hosted adapter tests use a local protocol server; acceptance against a real E2B account still needs that account's credentials.

To run computers on your own Docker host, run the API on the host, build the image from `apps/bot-computer` and configure `SANDBOX_PROVIDER=docker` and `SANDBOX_IMAGE`. Production requires gVisor (`SANDBOX_DOCKER_RUNTIME=runsc`); `runc` is for local development. Do not mount the Docker socket into the Compose API container.

### Separate API and worker processes

A single container defaults to `GREENHOUSE_ROLE=all`. To split it:

```sh
GREENHOUSE_ROLE=api RATE_LIMIT_STORE=postgres docker compose -p greenhouse-v2 --profile worker up -d --build
```

API replicas serve HTTP, WebSocket and foreground replies; workers process background runs, jobs, schedules and cleanup. They share the database, storage and encryption keys. Use `RATE_LIMIT_STORE=postgres` on every replica. Compose allows 70 seconds for the engine's 60-second shutdown drain.

## Local development

Node.js 22+, pnpm and Postgres 16+ with ICU are required. Use a dedicated v2 database on a port separate from v1. Copy `.env.example`, generate keys, set `DATABASE_URL`, then:

```sh
pnpm install
pnpm api                 # API on 3000; MIGRATE_ON_START=1 applies the guarded baseline
pnpm web:dev             # in another terminal; proxies /api to the API
```

`GREENHOUSE_API` selects another API address for Vite. Pages, the editor, rich charts/diagrams and the computer viewer load on demand with skeletons. Run `node scripts/check-web-bundle.mjs` after a web build to check the 350 KB entry budget and deferred modules. `pnpm web:build` builds the SPA served by the API. `apps/design` is a component prototype on mock data, not the product.

### A local stack with real services

With `greenhouse-v2-pg` on loopback port 55432 and provider keys in an external environment file:

```sh
REAL_ENV_FILE=/path/to/private.env sh scripts/dev-real.sh
```

The web app opens on 4570 and API on 4571. Override `REAL_WEB_PORT`, `REAL_API_PORT` and `REAL_DATABASE_URL` for a separate stack. It preserves its database by default; **`REAL_RESET=1` deletes that local database** and seeds Lin and Mei again. These sample accounts and fixed development signing keys are for local use only. Real model and search calls use the configured providers and can incur charges. The script also enables local Docker computers with the development runtime.

### Tests

```sh
pnpm typecheck
pnpm lint
TEST_DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:55432/greenhouse_v2_test pnpm test
E2E_DATABASE_URL=postgresql://greenhouse:greenhouse@localhost:55432/greenhouse_v2_e2e pnpm test:web-e2e
```

Create those disposable databases first. Tests reset them: unit/database names must contain `test`; browser database names must end in `_e2e`. Browser tests start their own API, Vite and scripted model on 4590–4592. Override `E2E_WEB_PORT`, `E2E_API_PORT`, `E2E_LLM_PORT` to avoid collisions. Browser retries are disabled.

Schema changes update `packages/db/src/schema` and regenerate the single v2 baseline with `pnpm db:baseline`. Until v2.0, recreate disposable databases after baseline changes; never run the baseline over v1.

### Screenshots

```sh
sh apps/web/e2e/stack.sh
# In another terminal; seeds sample content through the local API and captures both themes:
node --import tsx apps/web/e2e/capture-v2.mts
```

The fake stack resets only its `_e2e` database on start and runs on 4580–4582. Restart it before each capture so sample names start fresh. The capture script uses `STACK_WEB_PORT` to select it, saves small WebP images under `docs/assets/v2/` and a review manifest under `artifacts/t10/`. It needs Playwright Chromium and `cwebp`. Sample credentials are in [e2e/env.ts](apps/web/e2e/env.ts). Never use the fake stack as a public deployment.

## Upgrading from v1

Read [migration-v1.md](docs/product/migration-v1.md). There is no in-place migration and no implemented v1 import command yet. Keep v1's database, files, keys and deployment intact; start v2 alongside it with new volumes. Deployments that need their history should remain on v1 until the offline migration tool is available and verified on a copy.

## Contributing

Start with [AGENTS.md](AGENTS.md), the [product documents](docs/product/) and [design system](docs/design-system/README.md). API contracts live in `packages/contract`; permission checks live in services and are shared by HTTP routes, Agent tools and MCP. The web interface includes Chinese and English dictionaries; sign-in follows the browser language and members can choose their own language. Every local commit needs typecheck, lint and relevant tests; releases come from `main` only. See [RELEASING.md](RELEASING.md).

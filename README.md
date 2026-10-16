<p align="center"><img src="logos/greenhouse-logo.png" alt="Greenhouse" width="360" /></p>

<p align="center"><b>Your AI colleagues, in one self-hosted workspace.</b><br />
Open source · Web, iOS and Android · Docker Compose · MIT</p>

<p align="center">
  <a href="https://greenhouse.linjiejim.com">Website</a> ·
  <a href="docs/assets/v2/greenhouse-v2-intro.mp4">One-minute intro</a> ·
  <a href="docs/product/prd.md">中文产品说明</a> ·
  <a href="docs/product/features.md">Features</a> ·
  <a href="docs/product/api.md">API</a> ·
  <a href="docs/product/providers.md">Providers</a>
</p>

<p align="center"><a href="docs/assets/v2/greenhouse-v2-intro.mp4"><img src="docs/assets/v2/greenhouse-v2-intro-poster.png" alt="Watch the one-minute Greenhouse v2 introduction" width="880" /></a></p>

Greenhouse is a workspace where every member works with their own AI Agents on shared knowledge, tables and apps, and stays in charge. Agents search, write, build and keep working in the background. They ask before anything shared or irreversible, leave a receipt you can undo for everything else, and speak up only when there is something worth saying.

## Highlights

- **An Agent colleague for everyone.** Each member has a main Agent, Greeny, in one long-running thread, and can create more from a sentence: "make an Agent that sums up my mail every morning". Agents have memory, skills, schedules, a mailbox and an optional computer.
- **Writes with boundaries.** Private, reversible writes happen at once with a named receipt and Undo. Shared changes wait for one tap, or for a standing approval you granted. External or irreversible actions always ask. A newer request replaces an older one, and handled requests clear themselves away.
- **Work while you are away.** Background runs start from a brief you approve. Schedules, one-off reminders, and wake-ups from mail and automations keep work moving; when nothing matters, the Agent stays quiet.
- **Short, plain replies.** Answers lead with the result in a few sentences. A reaction acknowledges, files and plans arrive as cards, and Markdown appears only where structure helps.
- **Knowledge, tables and apps.** Docs and files with versions, comments and cited answers. Typed tables with grid, kanban, calendar, timeline, gallery, dashboards, forms and automations. Apps built on tables and published to members, with roles that only narrow table access.
- **A computer you can watch.** An Agent's sandboxed computer (E2B or Docker) has a browser and a terminal. Watch it live, take over, hand it back; its home survives restarts in encrypted backups.
- **Rooms.** Several people and their Agents in one conversation. Mention a person or an Agent; everyone sees whose Agent replied.
- **Native apps.** iOS and Android carry the same conversations, approvals, knowledge, tables, apps, runs and push notifications.
- **Open to your tools.** MCP connectors per member, OAuth 2.1 and personal tokens for external clients, and private extensions with their own pages, tools and migrations.
- **Your server, your models.** Docker Compose and Postgres; OpenAI, Anthropic, Gemini, DeepSeek, compatible APIs or local Ollama; search, voice, images and video; budgets per workspace, member, provider and published Agent; switches that pause background work, computers or outgoing mail.

## A look inside

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/v2/conversation-dark.webp" />
  <img src="docs/assets/v2/conversation-light.webp" alt="A Greenhouse v2 conversation with a knowledge source" width="1200" />
</picture>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/v2/tables-dark.webp" />
  <img src="docs/assets/v2/tables-light.webp" alt="The project template in Greenhouse v2 Tables" width="1200" loading="lazy" />
</picture>

Screenshots use seeded sample data and a scripted model; [regenerate them](#screenshots) against the local preview stack. The interaction rules every screen keeps are in [docs/design-system/rules.md](docs/design-system/rules.md).

## Native apps

The [native app](apps/mobile) (Expo SDK 57) opens the main thread with Greeny and carries conversations and rooms, approvals and receipts, Agents, runs, knowledge, tables, published apps, the live computer, notifications and push. iOS follows system navigation, sheets and forms; Android uses Material 3. Building apps and administration stay on the web.

The app has an isolated install: `pnpm mobile:install`, then `pnpm mobile`. Use a native development client on an iOS simulator or Android device; Expo Go cannot run it. See [mobile rules](apps/mobile/AGENTS.md) for platform checks and [RELEASING.md](RELEASING.md) for native builds and over-the-air updates.

## Start with Docker Compose

Install Docker with Compose, then use a fresh checkout and a Compose project of its own:

```sh
git clone https://github.com/linjiejim/greenhouse.git
cd greenhouse
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
SANDBOX_E2B_TIMEOUT_MINUTES=60
```

The server needs an E2B account with credit, a completed computer template in that account, and outbound HTTPS/WebSocket access to `api.e2b.app` and `*.e2b.app`. It needs no local Docker engine or Docker socket for computers. Build from this checkout on an operator machine with Node.js and `pnpm install`:

```sh
# E2B_API_KEY is supplied securely in the environment, for the same account as SANDBOX_API_KEY.
node --import tsx scripts/e2b-template.mts --cpus 2 --memory 2048
```

Copy the printed name into `SANDBOX_E2B_TEMPLATE`. Rebuild after changes to [the computer image](apps/bot-computer/Dockerfile); existing computers retain their original template and need recreation to adopt bridge/image changes. After a verified home backup, deleting the sandbox in the provider console lets the next start restore that backup into the configured template; Greenhouse Reset deletes backups too. For an E2B-compatible host set both build-time `E2B_DOMAIN` and runtime `SANDBOX_E2B_DOMAIN` to its domain. Every deployment sharing an account needs a distinct namespace; API and worker replicas of the same deployment share it, the API key, storage and encryption keys.

Running computers consume provider credit; template builds also use provider resources. See [current E2B pricing](https://e2b.dev/pricing). Greenhouse pauses idle computers after 30 minutes by default (Admin → Services → Computers). Watching, typing, running processes and pending takeovers keep them active. The provider timeout is a separate auto-pause safeguard: keep it above the idle interval and within your account's session limit. Stop preserves memory and both homes; reset permanently deletes the sandbox. Paused computers persist until explicitly deleted; see [E2B persistence](https://docs.e2b.dev/sandbox/persistence).

Encrypted home backups use the configured storage provider and `PROVIDER_TOKEN_ENCRYPTION_KEY`; keep both when restoring a deployment. Background runs can reach only approved brief domains on E2B; non-loopback IPv6 is blocked to prevent bypassing the provider's IPv4 rules. After private reads the computer goes offline. Screenshots reach the member even with a text-only model; only the model's own look at the screen needs vision. Details and the opt-in live check are in [provider configuration](docs/product/providers.md).

For local real-service acceptance, `REAL_SANDBOX_PROVIDER=e2b SANDBOX_E2B_TEMPLATE=<printed-name> sh scripts/dev-real.sh` uses E2B; Docker remains the default. Export `SANDBOX_API_KEY` securely first. `REAL_STORAGE_ROOT` can isolate acceptance files.

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

Real-model acceptance against a disposable local stack: `node --import tsx scripts/acceptance/run.mts --base http://127.0.0.1:4885`. It uses the browser-test accounts, makes real provider calls, captures light/dark/narrow checkpoints, and writes `artifacts/v2-delivery/results.json`. Start `scripts/dev-real.sh` first; `--only F01,F02` selects checkpoints and `--wait 240000` controls turn waits. iOS requires separate native simulator evidence.

Schema changes update `packages/db/src/schema` and add the next migration with `pnpm db:generate --name <change>`. Released migrations are never regenerated or edited; deployments apply new ones before the API starts. Never run v2 migrations over a v1 database.

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

Start with [AGENTS.md](AGENTS.md), the [product documents](docs/product/) and the [design system](docs/design-system/README.md), whose [interaction rules](docs/design-system/rules.md) every screen keeps. API contracts live in `packages/contract`; permission checks live in services and are shared by HTTP routes, Agent tools and MCP. The interface has Chinese and English dictionaries. Every commit needs typecheck, lint and the relevant tests; releases come from `main` only. See [RELEASING.md](RELEASING.md).

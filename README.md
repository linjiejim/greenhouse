<p align="center">
  <img src="logos/greenhouse-logo.png" alt="Greenhouse" width="440" />
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0d9488.svg"></a>
  <a href="https://github.com/linjiejim/greenhouse/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/linjiejim/greenhouse?color=0d9488"></a>
  <a href="https://github.com/linjiejim/greenhouse/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/linjiejim/greenhouse/actions/workflows/ci.yml/badge.svg"></a>
</p>

**Greenhouse 4.0 is a self-hosted Agent hub: a governance core, official plugins, and your own plugins.**
Members connect their agents over MCP and use the team's resources within their own permissions.
Sprouty, the built-in assistant, uses the same tools. The core assigns access, records actions,
and meters paid calls against member, service and team budgets.

This checkout is **4.0.0-rc.1**, a release candidate for testing. See the
[release notes and 3.x upgrade instructions](CHANGELOG.md#400-rc1-2026-10-27), the
[capability reference](docs/capabilities.md) (Chinese), and the
[architecture guide](docs/architecture.md) (Chinese).

## Three rings

| Ring | Responsibility |
|---|---|
| Governance core | Internal accounts and permissions; conversations and Agent profiles; tools and runs; audit and usage; models, budgets and gateway; MCP server and remote connectors; automations; notifications and push; Files; runtime configuration, branding, plugin host, administration and CLI. |
| Official plugins | Knowledge, Tables, SkillHub, Memory, Feedback, Projects, Reports, Email, Feishu, WeCom, Computer and Retro. They use the same kits and import boundaries as private plugins. |
| Your plugins | Domain data, integrations, tools and pages in `plugins/<id>/` or installed packages. SDK 2 can derive governed data tools, REST and pages from an entity definition. Existing SDK 1 overlays remain supported in 4.x. |

The default build compiles all twelve official plugins plus the disabled Example reference.
Compilation and enablement are separate:

| Enabled by default | Compiled, disabled by default |
|---|---|
| [Knowledge](plugins/knowledge), [Tables](plugins/tables), [SkillHub](plugins/skills), [Feedback](plugins/feedback), [Memory](plugins/memory) | [Projects](plugins/projects), [Reports](plugins/reports), [Email](plugins/email), [Feishu](plugins/feishu), [WeCom](plugins/wecom), [Computer](plugins/computer), [Retro](plugins/retro), [Example](plugins/example) |

`greenhouse.config.ts.plugins` selects compiled packages. `extensions.enabled` selects active
ids; `GREENHOUSE_EXTENSIONS` overrides that list at boot. Keep existing ids when adding one.
Configuration changes require a restart (and a rebuild when the compiled package list changes).
Env credentials alone never activate a plugin. Disabling preserves its tables and rows; routes,
tools, navigation, settings and delivery adapters stop being registered. Retro requires Knowledge.
Administration → Plugins shows status; it does not switch plugins on or off.

## What members can do

- **Bring an agent.** `/api/mcp` supports OAuth 2.1 authorization with PKCE and machine clients
  bound to an internal member. Tools are the intersection of that member's permissions and the
  granted action/resource scopes. Existing grants do not acquire new plugin groups automatically.
- **Use Sprouty.** Streaming chat, attachments, tool traces, model selection, rich tables/charts/
  diagrams, pinning, forks, sharing and scheduled Agent runs. Saved prompts and `task_capture`
  remain core even without SkillHub. `conversations.sharing: false` disables conversation sharing.
- **Read and change team resources.** Enabled plugins supply knowledge search/editing, typed
  Tables and formulas, project boards/tasks, versioned skill bundles, report rendering and other
  tools. Each plugin README lists its routes, tools, settings and data ownership.
- **Keep control.** MCP writes run in the member's name and produce write records; delete-like
  calls preview first and require a second call with `confirm: true`. `/api/agent` uses the member's
  login token and requires confirmation for every write; its calls are request-logged, with
  platform audits for dispatched actions. There is no approval queue.
- **Connect outward.** `mcp_call` reaches configured remote MCP servers using team or personal
  credentials. Read/write switches and destructive previews narrow access further. Connector
  writes appear in the Activity log. Connectors are distinct from in-process plugins.
- **Use paid services within budgets.** Models, search, page reads, vision and image generation
  reserve USD budgets before calling providers. Computer contributes its own metered service
  when enabled. The model gateway is separately off by default.

Large MCP replies return an `output_id` for `tool_output_read`; outputs remain private to the
member/client for 24 hours. `team_context`, `data_catalog` and MCP resources/prompts expose only
reachable capabilities. Team context works with core Markdown settings; Knowledge can additionally
supply selected team documents.

## Clients

| Client | What ships in this repository |
|---|---|
| Classic web (`apps/web`) | React/Vite web app with the administration console and SDK 1 React plugin pages. Always available at `/classic/`; at `/` only with `clients.web: 'classic'`. |
| Universal browser client (`apps/client`) | Default at `/`. Expo web export with wide-screen rail, secondary navigation, chat, inspectors, ⌘K, document editing, Tables grids and project boards. Plugins appear from the member-filtered station manifest. |
| iOS / Android (`apps/client`) | Native Expo client with chat, Files, enabled plugin places, notifications, stations and offline copies. iOS includes widgets; Android has Material 3 adapters, with store distribution/push setup still operator-dependent. |
| macOS (`apps/desktop`) | Tauri 2 shell bundling the universal client, multiple stations, Keychain sessions, native menus/notifications and Quick ask. Local unsigned builds are supported; signing and an updater feed require operator setup. |
| CLI | `pnpm cli`: users, database, diagnostics, profiles, sessions, plugins, chat and enabled plugin commands. |

`greenhouse.config.ts` `clients.web` defaults to `'universal'`: the universal client serves `/`, including
the account activation, MCP OAuth consent, connector sign-in return and Feishu/WeCom sign-in pages that
server links point at. Classic stays at `/classic/`, including administration; `web: 'classic'` puts it
back at `/`.
`pnpm dev` serves classic through Vite; it does not switch the development UI to Expo.
There is no browser extension.

`GET /api/extensions` is an authenticated station manifest v2: visible plugins, navigation,
pages, entities, fields and actions. It retains the v1 `extensions` and `entityKinds` fields.
`/api/bootstrap.mobile_api` is **4**; the current universal client's minimum remains **3** and
uses legacy navigation when v2 discovery is unavailable. Declarative pages support entity lists,
details/editing and settings; trusted embeds receive short-lived plugin credentials.

## Quick start (Docker)

Prerequisites: Docker Compose. Clone this repository and run:

```bash
cp .env.example .env
./scripts/gen-secrets.sh
# Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env.
docker compose up -d --build
docker compose exec api pnpm admin:create
```

Open http://localhost:3000. The image includes both web clients; PostgreSQL, a one-shot migration
job and the API run as separate Compose services. The API serves the static clients.

For a published image, set `GREENHOUSE_IMAGE=ghcr.io/linjiejim/greenhouse:<published-version>` in
`.env`, then use `docker compose -f docker-compose.ghcr.yml up -d`. Pin an exact version;
`4.0.0-rc.1` becomes available only after the maintainer publishes it.

## Local development

Prerequisites: Node.js 22+, pnpm 11, PostgreSQL 16 (or Docker).

```bash
pnpm install
cp .env.example .env
./scripts/gen-secrets.sh
# Configure LLM_* and DATABASE_URL for your local database.
docker compose up -d postgres
# Always use the intended database explicitly; never migrate another worktree's database.
DATABASE_URL=postgresql://greenhouse:greenhouse@127.0.0.1:5432/greenhouse pnpm db:migrate
pnpm admin:create
pnpm dev
```

Classic opens at http://localhost:3100; Vite proxies `/api`, `/public`, `/ext` and `/health` to
API port 3000. `WEB_PORT` / `API_PORT` override the ports. Backend changes require a restart.
`pnpm run-dev up` manages a local acceptance stack with isolated worktree databases, port
conflict handling and logs under `.run-dev/`; `pnpm run-dev stop` tears it down.

Optional `pnpm seed` loads the fictional reference dataset, including only enabled plugin seeds.
It refuses a non-empty database without `--keep` or `--reset`; reset is destructive and asks for
confirmation. Demo credentials and load order are in [data/examples/README.md](data/examples/README.md).

Build classic with `pnpm web:build`. Build the hosted universal client with `pnpm client:install`
then `pnpm app:build` (export to `public/app/`; rebuilding classic preserves it). For interactive
Expo development use `pnpm client:web` or a native dev client. Mobile has its own lockfile and
is outside the root workspace. See [desktop instructions](apps/desktop/README.md) for
`pnpm desktop:check` / `pnpm desktop:build`.

## Configuration

| Layer | Owns |
|---|---|
| `.env` | Infrastructure, secrets, ports and fallback credentials. `TOKEN_SIGNING_KEY` is required; encrypted stored secrets need `PROVIDER_TOKEN_ENCRYPTION_KEY`. |
| Runtime Config / Branding Studio (DB) | Live LLM/media/search settings, branding and registered plugin settings. DB values win over env fallback; secret values are encrypted and write-only. |
| `greenhouse.config.ts` | Compiled plugins, enabled ids, content packs, client hosting/stations and conversation sharing. |

See [.env.example](.env.example) and [EXTENDING.md](EXTENDING.md). Model definitions are in
`apps/api/src/config/models.yaml`; non-model prices come from the core service catalog and
active plugins' `billableServices`. Runtime permissions use `super` and `team`; there is no
anonymous or guest account. The model gateway, mobile push and plugin-specific switches still
need their own configuration after plugin enablement.

## Upgrading from 3.x

4.0 upgrades a 3.x database in place with `pnpm db:migrate` (3.0.2 recommended): it finishes the
archived 3.x chain, records the 4.0 baseline, and plugins adopt their tables without moving or
deleting rows. Fresh 4.0 installs create only core tables; each plugin creates its own when
enabled. **Select plugins explicitly before
restarting**: several formerly built-in modules are now off by default. The exact complete list,
client switch, SDK compatibility and rollback considerations are in
[CHANGELOG → Upgrading from 3.x](CHANGELOG.md#upgrading-from-3x).

Back up first (`scripts/backup-db.sh`), pin the new image, run the migration job and restart.
For source installs, install dependencies and run `DATABASE_URL=<your-database> pnpm db:migrate`.
Do not use `db push` on persistent/shared data. A binary downgrade alone does not reverse
migrations; retain the database backup and previous image for rollback.

### Upgrading from 1.x or 2.x

4.0 refuses 1.x and 2.x databases. Upgrade to 3.0.2 first (its README covers the 1.x carry into
a new database), run it once, then upgrade that database to 4.0 as above.

## Plugins and architecture

[EXTENDING.md](EXTENDING.md) is the package/SDK guide, using [Example](plugins/example) as a
working data-plugin walkthrough. [docs/architecture.md](docs/architecture.md) describes the
three rings, clients, request flows, database ownership and security boundaries.

```
apps/api/                governance API, plugin host, scheduler, runtime and CLI
apps/web/                classic web and React plugin host
apps/client/             isolated Expo universal client (web / iOS / Android)
apps/desktop/            macOS native shell around the universal client
packages/                agent/platform kernels, DB (+ core migrations), types, utils, CRUD, UI and ui-tokens
plugins/<id>/            manifest, API/web, tables/services, migrations, tests and optional UI
skillhub/                skill-pack source (no bundled packs)
scripts/                 assembly, builds, test gates, backup and screenshot tooling
tests/                   unit, DB, committed-state DB, HTTP and browser suites
```

## Verification and screenshot tour

```bash
pnpm typecheck
pnpm lint
node scripts/check-extension-overlay.mjs --all --strict
TEST_DATABASE_URL=<loopback-test-database-url> VITEST_UNIT_MAX_WORKERS=4 VITEST_DB_MAX_WORKERS=3 pnpm test
DATABASE_URL=<loopback-test-database-url> E2E_NO_LLM=1 pnpm test:e2e:ci
pnpm test:core
# Mobile is isolated; run its own checks as well.
(cd apps/client && pnpm typecheck && pnpm lint)
pnpm web:build
```

`pnpm test` includes unit, transactional DB and committed-state DB layers. `test:e2e:ci` boots
an API with a dead LLM endpoint for deterministic HTTP security checks. With Chromium available,
run `pnpm test:e2e:ui` (classic/plugin surfaces) and `pnpm test:e2e:client` (universal).

The repository's existing [screenshots](docs/assets/screens) are **earlier classic-web captures**,
not verified 4.0 screenshots or universal-client images. Generate replacements on a seeded
acceptance stack with a real model and the intended plugins enabled:

```bash
# Enable the plugins needed for a full tour before migration, seed and API startup:
# GREENHOUSE_EXTENSIONS=all  (includes Example; use a disposable acceptance database)
E2E_BASE_URL=http://localhost:4400 node scripts/capture-screens.mjs
```

The tour always uses `/classic/`, reads the active plugin set, visits available plugin pages
and Administration → Plugins, and writes WebP plus a chat GIF/MP4 (`cwebp` / `ffmpeg`). It
reports browser/API failures. A default-plugin tour skips disabled pages; it cannot refresh
screenshots of Projects, Reports or Example until those plugins are enabled. Universal browser
coverage and captures are maintained separately in `tests/client-e2e/`. Never mock or hand-edit
product captures.

## Releases

Stable `vX.Y.Z` tags publish GHCR `:X.Y.Z`, `:X.Y` and `:latest`; prereleases publish only their
exact prerelease tag. `main` publishes `:edge` and `:main-<sha>`. Pin versions in production.
Images carry `APP_VERSION` / `APP_REVISION` and OCI labels; `/health` reports health/runtime
switches, not a version stamp. [RELEASING.md](RELEASING.md) describes the local rc cut, maintainer
publication steps, stable promotion, mobile CD and desktop signing. This work does not publish
an image, tag, mobile update or desktop release.

## License

[MIT](LICENSE).

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
[4.0 upgrade guide](docs/upgrading-to-4.0.md), the [release notes](CHANGELOG.md#400-rc1-2026-10-27),
the [capability reference](docs/capabilities.md) (Chinese) and the
[architecture guide](docs/architecture.md) (Chinese).

## Three rings

| Ring | Responsibility |
|---|---|
| Governance core | Internal accounts and permissions; conversations and Agent profiles; saved prompts; tools and runs; audit and usage; models, budgets and gateway; MCP server and remote connectors; automations; notifications and push; Files; runtime configuration, branding, plugin host, administration and CLI. |
| Official plugins | Knowledge, Tables, SkillHub, Memory, Feedback, Projects, Reports, Email, Feishu, WeCom, Computer and Retro. They use the same kit and import boundaries as private plugins. |
| Your plugins | Domain data, integrations, tools and pages in `plugins/<id>/` or installed packages. SDK 2 derives governed data tools, REST and client pages from an entity definition. |

The default build compiles all twelve official plugins plus the disabled Example reference.
Compilation and enablement are separate:

| Enabled by default | Compiled, disabled by default |
|---|---|
| [Knowledge](plugins/knowledge), [Tables](plugins/tables), [SkillHub](plugins/skills), [Feedback](plugins/feedback), [Memory](plugins/memory) | [Projects](plugins/projects), [Reports](plugins/reports), [Email](plugins/email), [Feishu](plugins/feishu), [WeCom](plugins/wecom), [Computer](plugins/computer), [Retro](plugins/retro), [Example](plugins/example) |

`greenhouse.config.ts` `plugins` selects compiled packages and `extensions.enabled` selects active
ids; `GREENHOUSE_EXTENSIONS` replaces that list at boot. Keep existing ids when adding one.
Configuration changes require a restart (and a rebuild when the compiled package list changes).
Env credentials alone never activate a plugin. Disabling preserves its tables and rows; routes,
tools, navigation, settings and delivery adapters stop being registered. Retro requires Knowledge.
Admin › Plugins shows status; it does not switch plugins on or off.

## What members can do

- **Bring an agent.** `/api/mcp` supports OAuth 2.1 authorization with PKCE and machine clients
  bound to an internal member. Tools are the intersection of that member's permissions and the
  granted action/resource scopes. Existing grants do not acquire new plugin groups automatically.
- **Use Sprouty.** Streaming chat, attachments, tool traces, rich tables/charts/diagrams, pinning,
  forks, sharing and scheduled Agent runs. Saved prompts and `task_capture` remain core even
  without SkillHub. `conversations.sharing: false` disables conversation sharing.
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

There is one client, the universal client in `apps/client`, built with Expo for the browser,
iOS and Android. The API serves its hosted web export at `/`; `/classic` redirects to `/`.

| Client | What ships in this repository |
|---|---|
| Browser (`apps/client`) | Wide-screen rail with the built-in places and a More flyout for apps, secondary navigation, chat with inspectors, ⌘K, document editing, Files, Tables grids, project boards, the Automations place (editor and custom agents) and plugin pages from the station manifest. Supers get the Admin place at `/admin`. Entry pages handle account activation, MCP OAuth consent, connector and identity-provider returns. |
| iOS / Android (`apps/client`) | Native Expo client with chat, Files, enabled plugin places, notifications, stations and offline copies. iOS includes widgets; Android has Material 3 adapters, with store distribution/push setup still operator-dependent. |
| macOS (`apps/desktop`) | Tauri 2 shell bundling the universal client, multiple stations, Keychain sessions, native menus/notifications and Quick ask. Local unsigned builds are supported; signing and an updater feed require operator setup. |
| CLI | `pnpm cli`: users, database, diagnostics, profiles, sessions, plugins, chat and enabled plugin commands. |

`GET /api/extensions` is an authenticated station manifest v2: visible plugins, navigation,
pages, entities, fields and actions. `/api/bootstrap` reports `mobile_api: 4`, and the client
requires it: a 3.x station asks to be updated. Server-made links target client
routes (`packages/types/src/client-routes.ts`), and old classic `#/…` links are mapped to them.
There is no browser extension.

## Quick start (Docker)

Prerequisites: Docker Compose. Clone this repository and run:

```bash
cp .env.example .env
./scripts/gen-secrets.sh
# Set LLM_BASE_URL, LLM_API_KEY and LLM_MODEL in .env.
docker compose up -d --build
docker compose exec api pnpm admin:create
```

Open http://localhost:3000. PostgreSQL, a one-shot migration job and the API run as separate
Compose services; the API serves the universal client.

For a published image, set `GREENHOUSE_IMAGE=ghcr.io/linjiejim/greenhouse:<published-version>` in
`.env`, then use `docker compose -f docker-compose.ghcr.yml up -d`. Pin an exact version;
`4.0.0-rc.1` becomes available only after the maintainer publishes it.

## Local development

Prerequisites: Node.js 22+, pnpm 11, PostgreSQL 16 (or Docker).

```bash
pnpm install
pnpm client:install        # the client has its own lockfile, outside the root workspace
cp .env.example .env
./scripts/gen-secrets.sh
# Configure LLM_* and DATABASE_URL for your local database.
docker compose up -d postgres
# Always name the intended database explicitly; never migrate another worktree's database.
DATABASE_URL=postgresql://greenhouse:greenhouse@127.0.0.1:5432/greenhouse pnpm db:migrate
pnpm admin:create
pnpm dev
```

`pnpm dev` starts the API on port 3000 and the client's Expo web dev server on
http://localhost:3100, which calls the API directly. `WEB_PORT` / `API_PORT` override the ports.
Backend changes require a restart. `pnpm run-dev up` manages a local acceptance stack with
isolated worktree databases, port conflict handling and logs under `.run-dev/`;
`pnpm run-dev stop` tears it down.

Optional `pnpm seed` loads the fictional reference dataset, including only enabled plugin seeds.
It refuses a non-empty database without `--keep` or `--reset`; reset is destructive and asks for
confirmation. Demo credentials and load order are in [data/examples/README.md](data/examples/README.md).

`pnpm app:build` exports the hosted client to `public/app/`, which the API serves at `/`.
For native development use `pnpm client:ios` / `pnpm client:android` (dev clients) or
`pnpm client:web`. See [desktop instructions](apps/desktop/README.md) for
`pnpm desktop:check` / `pnpm desktop:build`.

## Configuration

| Layer | Owns |
|---|---|
| `.env` | Infrastructure, secrets, ports and fallback credentials. `TOKEN_SIGNING_KEY` is required; encrypted stored secrets need `PROVIDER_TOKEN_ENCRYPTION_KEY`. |
| Runtime Config / Branding (DB) | Live LLM/media/search settings, branding and registered plugin settings. DB values win over env fallback; secret values are encrypted and write-only. |
| `greenhouse.config.ts` | Compiled plugins, enabled ids, content packs, conversation sharing and client stations. |

See [.env.example](.env.example) and [EXTENDING.md](EXTENDING.md). Model definitions are in
`apps/api/src/config/models.yaml`; non-model prices come from the core service catalog and
active plugins' `billableServices`. Runtime permissions use `super` and `team`; there is no
anonymous or guest account. The model gateway, mobile push and plugin-specific switches still
need their own configuration after plugin enablement.

## Upgrading

Read [Upgrading to 4.0](docs/upgrading-to-4.0.md) before upgrading. In short: 3.x databases
(3.0.2 recommended) upgrade in place with `pnpm db:migrate`, which the Compose `migrate` service
runs before the API. Back up first (`scripts/backup-db.sh`), pin the new image and **select
plugins explicitly**: several formerly built-in modules are now off by default. 1.6 databases go
through 3.0.2 first; 2.x databases have no upgrade path. Never use `db push` on persistent data.
A binary downgrade does not reverse migrations; keep the backup and previous image for rollback.

## Plugins and architecture

[EXTENDING.md](EXTENDING.md) is the package/SDK guide, using [Example](plugins/example) as a
working data-plugin walkthrough. [docs/architecture.md](docs/architecture.md) describes the
three rings, clients, request flows, database ownership and security boundaries.

```
apps/api/                governance API, plugin host (src/plugin-host), scheduler, runtime and CLI
apps/client/             universal client (Expo: web / iOS / Android), isolated workspace
apps/desktop/            macOS Tauri shell around the universal client
packages/                agent/platform kernels, DB (+ core migrations), types, utils, CRUD, UI tokens
plugins/<id>/            manifest, API half, tables/services, migrations, seeds, tests and optional UI
skillhub/                skill-pack source (no bundled packs)
scripts/                 assembly, builds, test gates and backup
tests/                   unit, DB, committed-state DB, HTTP and browser suites
```

## Verification

```bash
pnpm typecheck
pnpm lint                  # includes the plugin import-boundary scan
pnpm plugins:sync --check
TEST_DATABASE_URL=<loopback-test-database-url> pnpm test
DATABASE_URL=<loopback-test-database-url> pnpm test:e2e:ci
TEST_DATABASE_URL=<loopback-test-database-url> pnpm test:core
# The client is isolated; run its own checks as well.
(cd apps/client && pnpm typecheck && pnpm lint)
pnpm test:e2e:client       # needs Chromium and a migrated test database
pnpm app:build
```

`pnpm test` includes unit, transactional DB and committed-state DB layers. `test:e2e:ci` boots
an API with a dead LLM endpoint for deterministic HTTP security checks. `test:e2e:client` starts
the API and Expo web from `playwright.client.config.ts`; `CLIENT_E2E_DATABASE`,
`CLIENT_E2E_API_PORT` and `CLIENT_E2E_WEB_PORT` override its database and ports. Product images
in [docs/assets/screens](docs/assets/screens) predate the universal client; never mock or
hand-edit product captures.

## Releases

Stable `vX.Y.Z` tags publish GHCR `:X.Y.Z`, `:X.Y` and `:latest`; prereleases publish only their
exact prerelease tag. `main` publishes `:edge` and `:main-<sha>`. Pin versions in production.
Images carry `APP_VERSION` / `APP_REVISION` and OCI labels; `/health` reports health/runtime
switches, not a version stamp. [RELEASING.md](RELEASING.md) describes the rc cut, maintainer
publication steps, stable promotion, mobile CD and desktop signing.

## License

[MIT](LICENSE).

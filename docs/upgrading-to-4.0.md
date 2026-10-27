# Upgrading to Greenhouse 4.0

This guide is for operators upgrading a deployment and for authors of private plugins and forks.
4.0 splits Greenhouse into a governance core and plugins, replaces the classic web app with the
universal client, and starts a new core migration chain. Read the whole page before upgrading.

- [Who can upgrade](#who-can-upgrade)
- [Before you start: backup and rollback](#before-you-start-backup-and-rollback)
- [Upgrade step by step](#upgrade-step-by-step)
- [Breaking changes](#breaking-changes)
- [Features removed from the UI](#features-removed-from-the-ui)
- [Links and bookmarks](#links-and-bookmarks)
- [Plugin authors: SDK 1 to SDK 2](#plugin-authors-sdk-1-to-sdk-2)
- [Developers: workflow changes](#developers-workflow-changes)

## Who can upgrade

| You run | Path |
|---|---|
| 3.x (3.0.2 recommended) | Upgrade in place: `pnpm db:migrate` bridges the database to 4.0. |
| 1.6.x | Move to 3.0.2 first with 3.0.2's `pnpm cli migrate-from-1x` into a new empty database (see the 3.0.2 README), run 3.0.2 once, then follow this guide. 4.0 has no 1.x carry command. |
| Older 1.x | Upgrade to 1.6 inside the 1.x line, then take the 1.6.x path. |
| 2.x | No upgrade path: 3.x never accepted 2.x databases and 4.0 refuses them. Start a fresh 4.0 install. |
| A fresh install | Nothing to upgrade; see the [README](../README.md#quick-start-docker). |

`pnpm db:migrate` and the API boot refuse 1.x, 2.x, half-carried (`migrate-from-1x` not
completed) and unrecognized databases with exit code 2 and an explanation. They leave such a
database untouched.

## Before you start: backup and rollback

1. Back up the database with `scripts/backup-db.sh` (it checks the dump's integrity and rotates
   old dumps). Keep the backup until 4.0 has run in production for a while.
2. Keep the previous image tag (or source revision), its `greenhouse.config.ts` and `.env`.
3. Rehearse on a copy: restore the backup into a scratch database, run the 4.0 migration
   against it and start 4.0 on it with the plugin list you intend to enable.

The migration is forward-only. A code downgrade does not reverse it, and starting 3.x on a
database that 4.0 has migrated is not supported. To roll back, stop 4.0, restore the
pre-upgrade backup into the database and start the previous image with its old configuration.
Anything written while 4.0 ran is lost in that case, so decide early.

## Upgrade step by step

### 1. Choose the plugins to enable

Several modules that were built in on 3.x are plugins in 4.0, and some are off by default:

| Enabled by default | Compiled, disabled by default |
|---|---|
| Knowledge, Tables, Skills (SkillHub), Feedback, Memory | Projects, Reports, Email, WeCom, Feishu, Computer, Retro, Example |

To keep every module you had on 3.x, enable the twelve official plugins (keep your private
plugin ids too). Retro requires Knowledge. Do not use `all` in production: it also enables the
Example reference plugin.

```dotenv
# .env — replaces (does not append to) the list in greenhouse.config.ts
GREENHOUSE_EXTENSIONS=knowledge,tables,skills,feedback,memory,projects,reports,email,wecom,feishu,computer,retro
```

Or, in a source install or fork, set it in `greenhouse.config.ts`:

```ts
extensions: {
  enabled: ['knowledge', 'tables', 'skills', 'feedback', 'memory',
            'projects', 'reports', 'email', 'wecom', 'feishu', 'computer', 'retro'],
},
```

Credentials alone never enable a plugin. Keep your existing `SHARED_MAILBOX_*`,
`MAIL_EGRESS_PROXY`, `WECOM_*`, `FEISHU_*` and `E2B_*` variables. Computer still needs its
workspace switch (`computer.enabled` or `COMPUTER_ENABLED`); the Feishu bot still needs
`FEISHU_BOT_ENABLED=1`. Email must be enabled for shared-mailbox delivery of password links.
Member feature flags (for example `tables`, `memory`, `email`) still apply after enablement.

Disabling a plugin keeps its tables and rows; its routes, tools, pages, settings and delivery
adapters stop registering. Re-enabling restores them.

### 2. Update `greenhouse.config.ts` (source installs and forks)

The Docker image ships the upstream file; image users can skip this step.

- Start from the 4.0 file: it has a `plugins` list naming the compiled packages
  (`./plugins/<id>`) and `extensions.enabled`. A 3.x file has neither `plugins` nor the new
  ids: without `plugins` no plugin is compiled, and the 3.x default `enabled: []` enables none.
- Remove `clients.web` if you added it while testing 4.0 candidates. 4.0 refuses to boot with
  it ("clients.web was removed in 4.0").
- Keep `packs`, `clients.stations` and add `conversations: { sharing: false }` only if you want
  to turn off conversation sharing (default on).
- Add your own plugin packages to `plugins` and their ids to `extensions.enabled`.

### 3. Install, migrate and start

Docker Compose (pin an exact version; never `latest` for an upgrade):

```bash
# .env: GREENHOUSE_IMAGE=ghcr.io/linjiejim/greenhouse:<4.0 version>
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d
```

The one-shot `migrate` service runs before the API. It finishes the archived 3.x chain,
records the 4.0 baseline and applies the lanes of the plugins enabled in the image's config,
all under one advisory lock. The `migrate` service does not read `.env`, so plugins you enable
through `GREENHOUSE_EXTENSIONS` create or adopt their tables when the API boots (the lane is
idempotent). The bundled `docker-compose.yml` builds from source the same way.

Source install:

```bash
pnpm install
DATABASE_URL=<your existing database> pnpm db:migrate   # always name the database explicitly
pnpm app:build                                          # needs `pnpm client:install` once
pnpm api                                                # or your process manager
```

The API refuses to boot on a 3.x database that `pnpm db:migrate` has not bridged yet. The
bridge never drops or copies tables. Plugin tables created by 3.x are adopted in place by each
plugin's `0001_adopt.sql`; private plugin tables, their `extension_migrations` rows and
`drizzle.greenhouse_carry` are left as they are. Never use `drizzle-kit push` on a persistent
database.

### 4. Verify

1. `GET /health` returns `{"status":"ok", "database": {"connected": true, …}}`.
2. Sign in at `/` with an existing account; the universal client opens on Home.
3. `pnpm cli plugins status` (or Admin › Plugins) lists the plugins you enabled as active.
4. Open Admin (`/admin`, super accounts on a wide window): Users, Activity log, Usage,
   Services & pricing, Team context, Branding, Runtime config, MCP access, Team connectors and
   Plugins, plus plugin sections (Issues & requests, Retro, Computer) when those are enabled.
5. Open one item of each enabled module (a document, a table, a project) and an automation.
6. Check that an MCP client still connects (`<origin>/api/mcp`) and that a test notification
   or automation delivery reaches its channel.

## Breaking changes

| What changed | What to do |
|---|---|
| The classic web app (`apps/web`) is gone; the universal client serves `/` and `/classic` redirects there. | Nothing for members; update bookmarks and docs (see [links](#links-and-bookmarks)). |
| `clients.web` in `greenhouse.config.ts` is a boot error. | Delete it. |
| Modules became plugins; Projects, Reports, Email, WeCom, Feishu, Computer and Retro are off by default. | Enable the ids you need (step 1). |
| New core migration chain (`packages/db/migrations/0000_v4_baseline.sql`); fresh installs create only the 49 core tables. | Run `pnpm db:migrate` (or the Compose `migrate` service) before the API. |
| 1.x and 2.x databases are refused; `migrate-from-1x` is removed. | 1.6 → 3.0.2 → 4.0; 2.x has no path. |
| SDK 1 plugins, in-tree overlays and plugin `web/` halves are refused by `plugins:sync`. | Port them to SDK 2 ([below](#plugin-authors-sdk-1-to-sdk-2)). |
| A plugin without `sdk` or `core` refuses activation (3.x only warned). | Declare `sdk: 2` and a `core` range that includes 4.0. |
| `GET /api/sessions` caps every page at 200 and ignores `include_eval`. | Page with `offset`/`page_meta`. |
| Automations accept delivery only as the `notify` object; the flat `notify_webhook`, `notify_email`, `notify_wecom` and `notify_feishu` fields are ignored. | Send `notify: { webhook, email, wecom, feishu }`. |
| Kit `WidgetRecipe`, `defineExtension.workbenchRecipes` and tool `surface.workbench` are removed. | Delete them; they had no effect since 3.0. |
| `@greenhouse/web/extension-kit`, `@greenhouse/ui/*` and `packages/contract` are no longer importable from plugins. | Use `@greenhouse/api/extension-kit`, `@greenhouse/types/*`, `@greenhouse/ui-tokens`. |
| The Docker image contains only the universal client. | Nothing; the API serves it. |

Kept on purpose: the station manifest still carries the v1 `extensions` and `entityKinds`
fields, `/api/bootstrap` reports `mobile_api: 4` while the client accepts stations from level 3,
and plugin `fallback_url` values remain so old links keep resolving. Browser sessions survive the
switch: the hosted client reads the same `greenhouse_access_token` / `greenhouse_refresh_token`
keys the classic app stored. Installed iOS/Android
apps from the 3.x line keep working against a 4.0 server, and the 4.0 client works with 3.x
stations through legacy navigation.

## Features removed from the UI

These classic web screens have no universal-client equivalent in 4.0. The APIs and agent tools
behind them mostly remain; use chat, an agent or the API, or wait for a later release.

| Removed screen | Alternative in 4.0 |
|---|---|
| Saved prompts management (SkillHub › My prompts) and the composer's `/` picker | Save prompts from chat's task-capture card; `/api/prompts` and MCP `prompt-*` prompts remain. |
| The composer's per-turn model picker | Chat uses the Agent's default model; custom agents pin their own model; `POST /api/chat` still accepts `model`. |
| A member's own activity log page with CSV export | Supers: Admin › Activity log (filters and CSV export). Members: team activity in the notification center; agent writes in Me › My Agents. |
| Creating or editing email accounts, memories and the cloud computer | Read-only lists in the client. Memories: ask Sprouty (`memory` tool). Computer: a member's MCP agent (`computer_*` tools). Email accounts: `/api/email/accounts`. |
| Skill upload, version history and report-template editing | Read-only lists; publish skills with `skill_mutation` (chat or MCP); templates through `/api/report-templates`. |
| The agent-connection wizard (Settings › Agent access › Connect) | Point the MCP client at `<origin>/api/mcp`; OAuth discovery and the consent page (`/oauth-consent`) work as before. |
| Adding personal connectors | Supers add team connectors in Admin › Team connectors; members connect them in Me › Connections. |
| Creating model-gateway keys | `POST /api/agent-access/gateway/keys` remains; supers list and revoke keys in Admin. |
| Knowledge share dialog | Ask Sprouty to share (`knowledge_mutation` share_doc). |
| Project members panel | `GET/POST/PATCH/DELETE /api/projects/:id/members` remain. |
| Tables field editing, recycle bin, data catalog page and audit dialog | Structure changes through chat (`tables_schema_plan` card); restore with `pnpm cli tables restore-base` / `restore-table`; agents use `data_catalog`. |
| SDK 1 React plugin pages | Port to manifest pages ([below](#plugin-authors-sdk-1-to-sdk-2)). |

## Links and bookmarks

Server-made links (activation mail, MCP consent, connector and identity-provider returns,
plugin page fallbacks) now point at universal client routes from
`@greenhouse/types/client-routes`. Secrets (activation token, sign-in code, provider code) ride
in the URL fragment. Identity-provider callback URLs registered with WeCom and Feishu
(`PUBLIC_BASE_URL` + `/api/<provider>/oauth/callback`) do not change.

Old classic links keep working: `/classic/…` redirects to `/`, and the client maps `#/…` hash
routes (`apps/client/src/shell/legacy-links.ts`) before routing:

| Old link | Opens |
|---|---|
| `#/chat/<id>` | `/chat?session=<id>` |
| `#/knowledge/…`, `#/kb/…` | `/knowledge` (shelf, folder or document) |
| `#/tasks`, `#/automations` | `/automations` |
| `#/settings`, `#/settings/notifications`, `#/settings/connectors` | `/me`, `/me/notifications`, `/me/connectors` |
| `#/settings/provider-bindings?…` | `/bindings?…` (or `/me/connectors`) |
| `#/administration/<key>` | `/admin/<key>`; plugin sections resolve through their `fallback_url` |
| `#/skillhub`, `#/skillhub?tab=reports` | `/p/skills/skills`, `/p/reports/reports` |
| `#/ext/<plugin>/<page>` | `/p/<plugin>/<plugin>-<page>` |
| `#/activity/<kind>/<id>` | the run sheet |
| `#/notifications?id=<id>` | the notification sheet |
| Document, file, folder, project, task and record links | the object's sheet or place |
| `#/login`, `#/activate` | `/login`, `/activate` (parameters move to the fragment) |
| Anything else | Home |

## Plugin authors: SDK 1 to SDK 2

4.0 accepts only SDK 2 packages under `plugins/<id>/` (or installed packages named in
`greenhouse.config.ts`). [EXTENDING.md](../EXTENDING.md) is the full contract and
[plugins/example](../plugins/example) the reference.

1. Make the plugin a package. Move in-tree code from `apps/api/src/extensions/<id>/` into
   `plugins/<id>/api/` and delete the `apps/web/src/extensions/<id>/` half. package.json declares
   `"greenhouse": { "id": "<id>", "sdk": 2, "api": "./api/index.ts" }` and exports `./api` and
   `./manifest`; there is no `web` entry.
2. Write a pure-data `manifest.ts`: `id`, `name`, `version` (from package.json), `sdk: 2`,
   `core` (a range that includes 4.0, e.g. `>=4.0.0 <5.0.0`), `dependsOn`, `features`,
   `client_min: 4`, `surfaces` and optional `ui: './ui'`.
3. Export `defineExtension({ ...manifest, ... })` from `api/index.ts` and import host APIs only
   from `@greenhouse/api/extension-kit`. Relative imports that leave the package, `@greenhouse/db`,
   `@greenhouse/utils`, kernel packages and `@greenhouse/ui/*` fail `pnpm lint`.
4. Replace the web half with manifest surfaces:
   - React list/detail pages for table-backed data → `dataSources` plus `entity-list` /
     `entity-detail` pages; the client renders them.
   - Settings panels → a `settings-form` page (`parent: 'settings'` or `'administration'`).
   - Admin pages → pages with `parent: 'administration'` (Admin sections, supers only).
   - Custom UI → an `embed` page served from the plugin's static `ui/`, using
     `connectGreenhouse` from `@greenhouse/ui-tokens` for theme, member and a narrow token.
   - Navigation → `surfaces.nav` entries (`primary` or `more`, a lucide icon name, a short
     label); copy → `LocalizedText` (`{ en, zh }`) in the manifest instead of `ext.<id>.*` keys.
   - Tool cards, slots, tabs and page-context providers have no replacement; return Markdown,
     rich blocks and `url` deep links from tools instead.
5. Remove `workbenchRecipes`, `WidgetRecipe` and `meta.surface.workbench`.
6. Keep your migration lane byte-identical: same plugin id, same `migrations/` files. Applied
   checksums in `extension_migrations` must match or startup refuses.
7. Keep tool ids, routes (`/api/ext/<id>/…` or legacy prefixes), entity kinds and
   `fallback_url` values so stored links, grants and profiles keep working.
8. Add the package to `plugins`, enable its id, then run `pnpm plugins:sync`, `pnpm typecheck`,
   `pnpm lint`, `pnpm test`, `pnpm test:core` and, for UI, `pnpm test:e2e:client`. Forks also run
   `node scripts/check-extension-overlay.mjs --base upstream/main --strict`.

## Developers: workflow changes

| 3.x | 4.0 |
|---|---|
| `apps/web` (classic), `apps/mobile` | `apps/client` (one universal client), `apps/desktop` (Tauri shell) |
| `pnpm web:dev`, `pnpm web:build` | `pnpm dev` (API + Expo web on `WEB_PORT`, default 3100), `pnpm app:build` |
| `pnpm mobile:install`, `mobile:web`, `mobile:ios`, … | `pnpm client:install`, `client:web`, `client:ios`, `client:android`, `client:prebuild` |
| `apps/api/src/extensions/`, `apps/api/src/platform/` | `apps/api/src/plugin-host/`; OAuth helpers in `apps/api/src/agent-access/oauth.ts` |
| `apps/{api,web}/src/extensions/compiled.generated.ts` | `apps/api/src/plugin-host/compiled.generated.ts` (generated, ignored) |
| `pnpm test:e2e:ui`, `tests/e2e-ui`, `tests/web`, `playwright.config.ts` | `pnpm test:e2e:client`, `tests/client-e2e`, `playwright.client.config.ts` |
| `packages/contract`, the `@greenhouse/crud` React client | Removed; `AppType` is still exported from `apps/api/src/index.ts` |
| `scripts/skillhub-sync.mjs` | Removed; the Skills plugin syncs packs at boot |
| `scripts/apply-ext-migrations.mjs` | Removed; `pnpm db:migrate` runs the plugin lanes |
| `scripts/capture-screens.mjs`, `scripts/clean-web-output.mjs` | Removed |
| `pnpm cli platform create-app` | Removed; copy `plugins/example` |
| Core migrations from the 3.0 baseline | `packages/db/migrations/` from the 4.0 baseline; the 3.x chain is frozen in `archive-3x/` |

The client stays outside the root pnpm workspace with its own lockfile: run `pnpm typecheck`
and `pnpm lint` inside `apps/client` as well as at the root. Client browser tests take
`CLIENT_E2E_API_PORT`, `CLIENT_E2E_WEB_PORT` and `CLIENT_E2E_DATABASE`, so parallel worktrees do
not share ports or a database. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full gate list.

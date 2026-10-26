# Extending Greenhouse

Greenhouse is built to be extended without being forked apart. Every capability plugs into a
**registry** that already drives chat, the `/api/agent` proxy, the `/api/mcp` server,
permissions and the admin UI. Since 0.7 those registries aggregate from one more source: the
**extension seam** — a folder per module, one import line, zero other core edits.

There are three ways to add something, from lightest to heaviest:

| You want to… | Do this |
|---|---|
| Change how a deployment is wired (which extensions are on, where content packs live, how clients treat stations) | Edit `greenhouse.config.ts` — see [Configuration](#configuration) |
| Add a private or experimental module — tools, routes, pages, tables, jobs — without touching core | Write an **extension** — see [Extensions](#extensions) |
| Improve Greenhouse itself | Change the core registries directly and send it upstream — see [Core extension points](#core-extension-points) |

> Earlier releases (≤ 0.6) shipped a family of `*.extensions.*` seam files that were pinned
> empty upstream, then retired them in favour of the registries. The extension seam brings the
> idea back as one explicit contract instead of sixteen stub files.

## Configuration

Configuration lives in three layers, each with one job:

| Layer | Holds | Changed by |
|---|---|---|
| `.env` | secrets and infrastructure: `DATABASE_URL`, API keys, ports | ops, per machine |
| Administration → Runtime Config / Branding Studio (database) | live product knobs: LLM / media / search credentials, product name, logo, theme | a super, from the browser, no restart |
| `greenhouse.config.ts` (repo root) | structure that changes with a rebuild: enabled extensions, content packs, client stations | the maintainer of the deployment or fork |

`greenhouse.config.ts` is typed by `@greenhouse/types/config` and validated at boot
(`packages/types/src/config-schema.ts`); a bad file stops the API with a readable error.

```ts
import { defineConfig } from '@greenhouse/types/config';

export default defineConfig({
  plugins: ['./plugins/example'],     // packages compiled into the build
  extensions: { enabled: ['crm', 'example'] }, // or 'all'; GREENHOUSE_EXTENSIONS=… overrides at boot
  packs: {
    skills: ['packs/skills'],        // extra skill-pack roots, same layout as skillhub/
    profiles: ['packs/profiles'],    // extra agent profile directories (a pack may override a core id)
    seeds: 'packs/seed',             // dataset for `pnpm seed`
  },
  clients: {
    stations: { mode: 'single', defaults: [{ id: 'hq', name: 'HQ', url: 'https://greenhouse.example.com' }] },
  },
});
```

- **`extensions.enabled`** — which *compiled* extensions are active. `'all'` for everything listed
  by `plugins` plus the SDK 1 in-tree list; an id list to trim per deployment. `GREENHOUSE_EXTENSIONS=crm,example`
  (or `all`, or empty for none) overrides the file so one image serves several deployments.
- **`packs`** — content, not code: skill packs, profile YAMLs and a seed dataset that live outside
  the repository (a fork's `packs/` folder, a mounted volume). Paths are absolute or relative to
  the repository root.
- **`clients.stations`** — how client builds treat servers. `multi` (default) lets users add and
  switch stations; `single` locks a client build to the one station in `defaults`. The mobile app
  mirrors it at build time; see `apps/mobile/AGENTS.md` for the wiring.

## Plugins (packages)

New plugins live in workspace packages. The reference `plugins/example` is compiled by default
but remains disabled unless explicitly enabled; moving it has not changed the default product.

```
plugins/<id>/
  package.json      # name, version, greenhouse metadata, exports, dependencies
  manifest.ts       # pure JSON-serialisable data; default export
  api/index.ts      # default defineExtension({ ...manifest, ... }) export (optional)
  web/index.ts      # default defineWebExtension({ ...manifest, ... }) export (optional)
  migrations/       # the existing extension migration lane, unchanged
  e2e/              # Playwright *.e2e.ts; same authenticated project as in-tree specs
  skills/ profiles/ seeds/   # optional content; use the existing packs/skillPacks hooks
```

```json
{
  "name": "@greenhouse/plugin-example",
  "version": "3.0.2",
  "type": "module",
  "greenhouse": { "id": "example", "sdk": 2, "api": "./api/index.ts", "web": "./web/index.ts" },
  "exports": { "./api": "./api/index.ts", "./web": "./web/index.ts", "./manifest": "./manifest.ts" }
}
```

`manifest.ts` supplies `id`, `name`, `description`, `version`, `sdk`, `core`, `dependsOn` (ids)
and `features`. Its id and SDK match package metadata, its version matches package.json, and
its directory is `<id>` (installed packages may use `plugin-<id>`). Both halves are optional;
a web-only package still gets an identity in `/api/extensions`. Code halves default-export
their extension object; do not import the code halves from the manifest.

Set `plugins: ['./plugins/example']` or `plugins: ['@greenhouse/plugin-example']` in
`greenhouse.config.ts`. Workspace names resolve without an extra root dependency; installed
packages must be dependencies of the deployment. `GREENHOUSE_PLUGINS` overrides this list at
assembly time (comma-separated names/paths, empty means none). Keep every `dependsOn` package
in the list and enable it alongside its consumer. Cycles, duplicate ids, invalid metadata and
missing exports fail assembly. Registration order follows configuration order.

`pnpm plugins:sync` generates static imports in
`apps/{api,web}/src/extensions/compiled.generated.ts`. These files are gitignored. Install,
dev, build, typecheck, tests and operational CLI commands sync automatically; CI also runs
`pnpm plugins:sync --check`, which refuses missing/stale output. SDK 1 `index.ts` lists remain
available to overlays, after generated packages. No runtime code loading or hot replacement.

Package production imports may reach only `@greenhouse/api/extension-kit`,
`@greenhouse/web/extension-kit`, `@greenhouse/types/*`, `@greenhouse/crud`,
`@greenhouse/ui/*`, their own directory, plugins declared in `dependsOn` **and** package.json,
and third-party dependencies declared in their own package.json (plus Node builtins).
Relative paths cannot escape the package. Tests retain the SDK 1 exemption for host test hooks.
Core `apps/**` / `packages/**` imports cannot reach plugins, except in the two generated files.
`pnpm lint` and the overlay guard enforce these edges. Both kit export lists stay snapshot-locked.

Operators use:

```bash
pnpm cli plugins list --json       # compiled/enabled, SDK, version, dependencies; no DB needed
pnpm cli plugins status --json     # migration state and process-local boot facts
pnpm cli plugins drop example     # preview tables; refuses an enabled/unknown plugin
pnpm cli plugins drop example --yes
pnpm test:core                     # zero-package typecheck, core unit/DB suites, real API boot
```

Administration → Plugins (`GET /api/admin/plugins`, super only) is read-only. Enable/disable
through configuration plus restart; disabled plugins retain all data. `drop` removes the
net tables from current-generation migrations plus registered `resetTables`, and only that
lane's rows, in one transaction under the migration lock. It refuses core tables, shared
ownership and external table dependencies (`RESTRICT`, never `CASCADE`). CLI boot state is
`not-run`: inspecting status does not execute hooks. Boot or migration failures still stop
startup; status only shows facts from the current process, not historical error storage.

## Extensions

An extension is two folders and two list entries:

```
apps/api/src/extensions/<id>/    ← tools, routes, tables + migrations, services, jobs, commands, flags
apps/web/src/extensions/<id>/    ← pages, navigation, settings modules, translations, chat cards
apps/api/src/extensions/index.ts ← import + list entry (API half)
apps/web/src/extensions/index.ts ← import + list entry (web half)
```

Nothing else in core changes. The registries — tool catalog, route mounting, platform
applications, feature flags and points, workspace settings, public paths, scheduler, CLI,
database services, migrations, hash router, sidebar, i18n, tool cards, agent context — all read
the active extensions and fold their contributions in. `plugins/example` exercises SDK 2 together with SDK 1 compatibility fields; the in-tree layout below remains supported for existing overlays.

### The API half — `defineExtension`

```ts
// apps/api/src/extensions/crm/index.ts
import { defineExtension, extensionPath, requireFeature } from '../../extension-kit.js';

export const crmExtension = defineExtension({
  id: 'crm',                        // lowercase, digits, dashes — also the config switch
  name: 'CRM',
  sdk: 1,                           // the contract revision (EXTENSION_SDK) it was written for
  core: '>=3.0 <4',                 // Greenhouse versions it supports
  tools: [crmQueryTool, crmMutationTool],                  // defineTool(); lazy tools use createLazy(ctx)
  routes: [{ path: '/api/ext/crm', app: crmRoutes, guards: [requireFeature('crm')] }],
  applications: [{ manifest: crmManifest, handlers: crmHandlers, teamCapabilities: ['crm.*'] }],
  featureFlags: [{ key: 'crm', label: 'CRM', description: '…', defaultEnabled: false }],
  featurePoints: [{ key: 'crm', kind: 'flag', flag: 'crm', group: 'apps', toolIds: ['crm_query', 'crm_mutation'], … }],
  workspaceSettings: [{ key: 'crm.api_key', group: 'crm', label: 'API key', type: 'string', secret: true, … }],
  publicPaths: { exact: ['/api/ext/crm/webhook'] },
  jobs: [{ id: 'crm-sync', cron: '*/15 * * * *', run: syncCrm }],
  commands: [{ name: 'crm:import', usage: 'Import customers from a CSV', run: importCsv }],
  migrations: { dir: extensionPath(import.meta.url, 'migrations') },
  services: (db) => ({ customers: createCustomerService(db) }),
  resetTables: ['ext_crm_customers'],
  skillPacks: [extensionPath(import.meta.url, 'skills')],
  onBoot: async ({ db, config }) => { /* warm caches, validate credentials */ },
  onShutdown: async () => { /* flush */ },
});
```

Every field is optional and maps 1:1 onto a core registry:

| Field | Lands in | Notes |
|---|---|---|
| `sdk` / `core` | activation | `sdk` must equal the core's `EXTENSION_SDK` (from the kit); `core` is a semver range checked against `APP_VERSION` (else the root `package.json`), where a pre-release counts as its release (`3.0.0-rc.3` satisfies `>=3.0 <4`). A mismatch refuses to start; leaving them out only warns in 3.x and is an error from 4.0. |
| `tools` | tool catalog → chat, `/api/agent`, `/api/mcp` | `meta.surface` decides exposure exactly like a core tool. Lazy tools implement `createLazy(ctx)` (user, session, db, `unattended`) — no per-tool case in core, and `defineExtension` refuses a lazy tool without it. Ids must not collide. A tool that changes data must declare `surface.proxy: 'write'` (see "Writing tools" below). |
| `routes` | mounted after the typed core chain | Convention `/api/ext/<id>`; `guards` run for every request under the prefix. Extension routes are not part of the public `AppType` contract. |
| `applications` | platform kernel (`bootstrapPlatform` + `initializePlatformRuntime`) | Manifest v2 + handlers; scaffold with `pnpm cli platform create-app <id>`. |
| `featureFlags` / `featurePoints` | `user_grants` (`kind='feature'`), the permissions dialog, feature-owned tool sets | Extension flags are strings (the compile-time `FeatureKey` union stays core-only). A non-global tool must belong to exactly one point. |
| `workspaceSettings` | Runtime Config (one section per extension), `workspace_settings` table, env overlay | Key `<id>.<name>`, `group: '<id>'`; secrets are encrypted at rest and write-only over the API. |
| `publicPaths` | `isPublicPath()` in the auth middleware | Keep minimal — OAuth callbacks, webhooks. |
| `jobs` | started/stopped with the scheduler | croner syntax; zone defaults to `SCHEDULER_TIMEZONE`. |
| `commands` | `pnpm cli <name>` and `pnpm cli --help` | Namespace with the id: `crm:import`. |
| `migrations` | the extension migration lane | Ordered `NNNN_name.sql` files, `--> statement-breakpoint` between statements (what `drizzle-kit generate` emits). Applied by `pnpm db:migrate` right after the core chain (same advisory lock) and again, idempotently, at boot; tracked in `extension_migrations` with a checksum — editing an applied file fails fast. A file may not `CREATE TABLE` a core table name. Core DDL stays in `drizzle/`. See "Migrations across core generations" below. |
| `services` / `resetTables` | `db.extensions[<id>]`, integration-test truncation | Keep a typed accessor: `getExtensionServices<CrmServices>(db, 'crm')`. |
| `entityKinds` | in-app deeplinks (`entityUrl` / `parseEntityUrl`) and chat peeks | `{ kind: 'ext:crm:company', route: '#/crm/companies/:id' }` — one template drives both directions. Put the URL in a tool result and the chat renders a peek instead of a link. |
| `searchSources` | the ⌘P palette | One lane per record kind; it applies its own permission check and a failure only empties its own group. |
| `mcpGroups` | MCP consent + OAuth scopes | `['crm']` gives `mcp:crm`; tools join it with `surface.mcp: 'crm'`. Existing grants never pick up a new group. |
| `exportSources` | the `export_data` tool's source union | A whole-dataset lane (`crm_customers`) so the model exports server-side instead of transcribing rows. Apply your own authorization; the tool only persists the result. |
| `applications[].teamExportableEntities` | the `team` role's bootstrap field policy | Which of your entities a normal user may export in full. Empty by default — bulk export is a deliberate grant. |
| `applications[].platformTools` | MCP tool visibility | Ties `crm_query` / `crm_mutation` to the application's query / command actions, so a fully denied tool disappears from `tools/list` like core's do. |
| `dependsOn` | a boot-time check | Ids this extension needs switched on too. Two extensions in one build can import each other by path; this makes the configuration requirement explicit and fails fast instead of deep inside a request. Reserve it for the genuinely unshareable — an authenticated transport, a credential chain. |
| `driveScopes` | the shared Drive (`folders` / `files` rows with `source='drive'`) | Your own file cabinet inside core's tables: rows carry `scope: '<your scope>'` and `owner_key` (any text — a record id), and the `authorize(ownerKey, ctx)` you declare is the only rule core applies. |
| `workbenchRecipes` | nothing (deprecated) | The Home workbench was removed in 3.0; the field is accepted and ignored so 2.x extensions compile, and goes in 4.0. Same for `meta.surface.workbench` and the kit's `WidgetRecipe`. |
| `skillPacks` | Skill Center seed at boot | Same layout as `skillhub/`. |
| `onBoot` / `onShutdown` | after the tool registry exists, before routes serve; on SIGTERM | |

### Core data your extension touches

- Reach core only through the stable facades `db.users`, `db.drive` and `db.platform`; their
  method shapes do not change between releases.
- Every core id is text. New rows get a prefixed ULID (`usr_01J…`, `fil_01J…`); rows carried
  from 1.x keep their old id as a string (`"42"`). Store user ids and other core ids as `text`,
  without a foreign key into core, and never parse an id's shape.
- `db.drive` takes ids as `string | number` and always returns strings. `DriveFileRow` keeps the
  1.x field names extensions read: `cos_key` (= `files.storage_key`), `size` and `uploaded_by`
  (= `files.created_by`).
- There is one organization: no `org_id` anywhere. `db.platform` methods still take an `orgId`;
  pass `'default'`.
- Name new extension tables `ext_<id>_*`. Existing `crm_*`-style tables keep their names.
- `pnpm cli migrate-from-1x` copies extension tables and `extension_migrations` verbatim when a
  1.x database moves to 3.0 (DDL rebuilt from the catalog, rows streamed with COPY, sequences
  carried), so the lane keeps running from where it was. An extension that stored a 1.x numeric
  user id keeps resolving because carried users keep that id as a string.

### Stable surface vs internals

An extension may import only:

- its own directory (and another extension's, for a declared `dependsOn`);
- its app's kit — `apps/api/src/extension-kit.ts` / `apps/web/src/extension-kit.ts`;
- the shared contracts in `@greenhouse/types/*` and the CRUD kit `@greenhouse/crud`;
- third-party packages.

That is the stable surface, together with the `defineExtension` / `defineWebExtension` types.
Everything else — `apps/*/src/**` outside the kit, `@greenhouse/db`, `@greenhouse/utils`,
`@greenhouse/platform-kernel` — is internal and may change in any release; the kits re-export the
parts an extension needs (actors, the platform runtime, storage, export sources, CLI helpers,
`compileApp` / `defineApp` and policy helpers, `nowIso` / `toErrorMessage` / `safeJsonParse`; on
the web side icons, navigation, page shells, UI and detail components, `fetchJson`, formatters).
Each kit's export list is locked by a snapshot test (`apps/*/src/__tests__/extension-kit.snapshot.test.ts`):
a removal or rename updates the snapshot and adds a CHANGELOG line starting `extension-kit:`.
Test files are exempt from the import rule (they may reach core test hooks such as
`routes/mcp`, `tools/registry` or the platform runtime's reset).

`scripts/check-extension-overlay.mjs` checks these import edges and prints `file:line` for each
one past the surface; `--strict` fails on them. Upstream CI runs `--all --strict` over the
example extension.

### Writing tools

A tool that changes data declares `surface.proxy: 'write'`. That alone puts it under governed
writes when a member's own agent calls it over `/api/mcp`: it runs as the
member, is recorded as an `agent_write` run with a risk tier, and a delete-like action
(`delete` / `remove` / `purge` / `destroy` / `drop`, e.g. `notes.delete`) first returns a
`needs_confirmation` preview and runs only when called again with `confirm: true`. A writing tool
declared `proxy: 'read'` bypasses all of that — never do it. The example's
`example_notes_mutation` is the reference (`plugins/example/api/tool.ts`, tested
over `/api/mcp` in `plugins/example/api/__tests__/example-write-tool.db.test.ts`).

If the tool is backed by a platform application, list it in `applications[].platformTools` —
`{ query: ['crm_query'], command: ['crm_mutation'] }` — so MCP hides it once every query
(respectively command) capability of that application is denied to the member, exactly as core
does for its own tools.

### Migrations across core generations

A migration written against the **1.x** core tables (it alters or reads a 1.x table) starts with
the line

```sql
-- greenhouse:core-generation 1x
```

3.0 never executes such a file. On a database that was never carried from 1.x it is recorded as
satisfied and reported as *skipped*; on a carried database whose copied `extension_migrations`
has the row nothing happens; on a carried database where the extension ran on 1.x but this row
is missing, 1.x never applied the file, so 3.0 refuses to start — apply it on 1.x and run
`migrate-from-1x` again. The marker line is not part of the checksum, so marking an already
applied file is not an edit. `pnpm cli db status` lists every file with its generation and state;
`migrate-from-1x --dry-run` reports the same per file, plus any extension table whose name a 3.0
core table already uses. The example's `0002_v1_session_note_count.sql` shows the form.

### The web half — `defineWebExtension`

```ts
// apps/web/src/extensions/crm/index.ts
import { lazy } from 'react';
import { defineWebExtension } from '../../extension-kit';

export const crmWebExtension = defineWebExtension({
  id: 'crm',
  sdk: 1,                // same compatibility declaration as the API half
  core: '>=3.0 <4',
  messages: { en: { title: 'CRM', … }, zh: { title: '客户', … } },   // merged under ext.crm.*
  pages: [
    {
      route: 'crm',
      component: lazy(() => import('./page')),
      sidebarPanel: CrmNavPanel,
      titleKey: 'ext.crm.title',
      // Optional: sub-modules of this page — `#/crm/companies`, module id `crm.companies`.
      modules: [{ key: 'companies', labelKey: 'ext.crm.companies', icon: Users }],
      // Optional: hashes from before the extension — `#/customers/<tail>` → `#/crm/companies/<tail>`.
      aliases: { customers: 'crm/companies' },
    },
  ],
  navigation: [{ id: 'crm', labelKey: 'ext.crm.nav', icon: Users, href: '#/crm', route: 'crm', requireFeature: 'crm' }],
  modules: [{ key: 'crm', parent: 'settings', labelKey: 'ext.crm.settings', icon: Users, component: CrmSettings }],
  toolCards: [{ tool: 'crm_query', component: CrmResultCard }],
  toolIcons: { crm_query: Users, crm_mutation: Users },
  contextProvider: { type: 'extension', label: …, emptyMessage: …, quickActions: …, contextHint: … },
});
```

| Field | Lands in | Notes |
|---|---|---|
| `pages` | hash router (`#/<route>` and sub-paths), top bar, contextual sidebar | Rendered only while the API reports the id active; otherwise a calm "not enabled" state. |
| `pages[].modules` | the navigation registry as `standalone` modules, id `<id>.<key>` | What `<ModulePage moduleId="crm.companies">`, the module rail and the breadcrumb resolve against. Omit for a one-screen page. |
| `pages[].aliases` | the hash router, before extension routes | Legacy top-level hashes → a path inside this page; the tail and query survive (`#/customers/42` → `#/crm/companies/42`). Must land in the page's own route, must not repeat a route, unique across the compiled set; a core route can never be aliased. |
| `navigation` | the sidebar "More" menu (desktop flyout + mobile drawer) | `requireFeature` / `requireRole` hide the entry per user. |
| `modules` | Settings ("Extensions" section) or Administration | Key becomes `#/settings/<key>` or `#/administration/<key>`; the module id is `settings.<key>` / `admin.<key>` (core's own shape), so a panel renders through `<ModulePage moduleId="admin.<key>">`; pins and breadcrumbs work. |
| `messages` | i18n, under `ext.<id>.*` | `t('ext.crm.title')` type-checks; a missing locale falls back to English. The visible-copy guard still rejects hard-coded English in your TSX. |
| `toolCards` / `toolIcons` | chat transcript, tool catalogs | A card replaces the trace row once the tool returned without error; `placement: 'below'` renders after the prose. |
| `entityKinds` | peek / side-pane chrome and body for the kinds the API half registered | Same `kind` string on both halves; `render` is optional (without it the peek offers "open full page"). |
| `mcpGroups` | consent screen and machine-client form | Display copy for a group the API half owns; the group only appears while the extension is active. |
| `knowledgeDocPanels` | every knowledge document, below the document body | For things attached to documents — provenance, sync state. |
| `contextProvider` | the agent panel on your pages | Receives `{ type: 'extension', extension, route, subPath }`. |

`apps/web/src/extension-kit.ts` re-exports `authFetch`, `useT`, the UI kit, `useAuthStore`,
`canUseFeature`, `usePageActions` and the contract types.

On the browser side, `<DriveBrowser owner={{ scope: 'crm', owner_key: String(companyId) }} />`
renders that cabinet with the same UI Tables and Knowledge use.

### Proving it in a browser

An API-level test cannot see the failures an extension actually ships with — a module id the
panel cannot resolve, a page that throws on first render, a front end still calling a moved
route. Two things cover that, and both are generic:

- **The surface sweep** — `tests/e2e-ui/extension-surfaces.spec.ts` reads every hash the
  *active* extensions registered (`window.__greenhouseExtensionSurfaces`, fed by
  `defineWebExtension`: pages, page modules, "More" entries, Settings / Administration modules,
  aliases) and opens each one, failing on an error boundary, a "not enabled" state, a blank
  shell or an uncaught page error. Nothing to write: compile an extension in, switch it on, and
  the sweep covers it.
- **Extension-owned specs** — `plugins/<id>/e2e/*.e2e.ts` and `apps/web/src/extensions/<id>/e2e/*.e2e.ts` run in the
  `extensions` Playwright project with the shared authenticated state (see
  `plugins/example/e2e/notes.e2e.ts`). Import only `@playwright/test`; the
  folder stays self-contained and inside the seam.

CI runs both in the `e2e-ui` job with `GREENHOUSE_EXTENSIONS=example`. A fork's CI runs the
same `pnpm test:e2e:ui` with its own extensions enabled (the config file's list applies when
the variable is unset), so a private extension gets the sweep and its own specs on every push.

### What the seam does not cover (yet)

Notification transports (email / WeCom / Feishu) are still closed in core. If your module needs
one, extend the registry upstream rather than patching around it: that is a contribution, not a fork.

### Keeping a fork thin

A fork keeps its private packages under `plugins/<id>/` (or existing SDK 1 modules under `apps/*/src/extensions/<id>/`), its content under
`packs/`, its deployment files under `deploy/`, and its own `greenhouse.config.ts`; it syncs with
`git merge upstream/main`. `scripts/check-extension-overlay.mjs` fails the fork's CI when a commit
touches anything else, so a gap in the seam surfaces as an upstream pull request instead of a
patch that will conflict on the next merge:

```bash
git remote add upstream https://github.com/linjiejim/greenhouse.git && git fetch upstream
node scripts/check-extension-overlay.mjs --base upstream/main   # or OVERLAY_UPSTREAM_REF=…
```

The same run reports extension imports past the stable surface (`file:line`). Start in report
mode; once the list is empty add `--strict` so a new deep import fails CI.

Upstream's workflows (`ci.yml`, `release.yml`, `release-please.yml`, `mobile.yml`, `deploy.yml`)
are gated to `linjiejim/greenhouse` and stay inert in a fork — `ci.yml` included, because it
neither migrates a fork's extension tables nor carries an organisation's gitleaks licence, so on
a fork it could only fail. A fork puts its own gates and deployment in
`.github/workflows/fork-*.yml`, which the overlay guard allows.

The rule of thumb: **code that could exist without your business goes upstream; content,
credentials and business-specific modules stay in the overlay.**

## Core extension points

Everything below is also what the extension seam feeds; use these directly when the change
belongs to Greenhouse itself.

| Add a… | Where | Mechanism |
|---|---|---|
| **Agent tool** (chat, plus `/api/agent` / `/api/mcp` as its `surface` allows) | `apps/api/src/tools/<name>.ts` + one line in `CORE_TOOL_MODULES` (`tools/registry.ts`); a lazy tool also gets a construction case in `buildLazyServerTools` (`agent-runtime/tool-resolution.ts`) | `defineTool({ meta, kind, create? })`: static tools get `create(db)`, lazy ones are built per request from the caller's `userId`; `meta.surface` decides proxy / MCP exposure and the workbench binding; `meta.is_global` decides default availability |
| **Platform application** (module with entities, permissions, navigation) | `apps/api/src/platform/manifests/<app>.ts` + `apps/api/src/platform/<app>/application.ts`, registered in `index.ts` (`initializePlatformRuntime`) and `platform/bootstrap.ts` | Manifest v2 (JSON-serializable) + registration handlers; scaffold with `pnpm cli platform create-app <id>`; bump `manifest.version` whenever the serialized manifest changes |
| **Feature flag** (per-user opt-in / opt-out) | `packages/types/src/features.ts` | `FEATURE_FLAGS` entry; guard routes with `requireFeature('<key>')`; the admin toggle appears automatically |
| **Feature point** (what a flag / app owns) | `apps/api/src/platform/feature-points.ts` | Maps a flag or app to its tool ids and capability prefix so one switch controls app + REST + MCP + chat |
| **API route** | `apps/api/src/routes/<resource>.ts`, mounted in `apps/api/src/index.ts` (`mountRoutes`) | Chained Hono routes (they become part of the typed `AppType` contract used by the web client) |
| **Database table + service** | `packages/db/src/schema/<domain>.ts` + `services/<domain>.ts`, an id prefix in `ids.ts`, one line in `provider.ts` | Drizzle schema with the `_columns.ts` helpers → `pnpm drizzle-kit generate` (diffs against the 3.0 baseline) → review SQL → commit → `pnpm db:migrate`; services are typed factories, the provider type is inferred; update `db-schema.md` |
| **Web page / navigation** | `apps/web/src/pages/**`, `apps/web/src/lib/nav-registry.ts`, hash routes in `apps/web/src/app.tsx` | Settings/Administration modules come from `nav-registry`; top-level pages are hash routes in `app.tsx`; platform apps surface through the permission-aware catalog (`apps/web/src/platform/`) |
| **Chat card for a tool output** | `apps/web/src/components/tool-call/body-artifacts.tsx` + `tool-call-card.tsx` | Tool results render from the tool's `presentation` metadata; add a body renderer keyed by tool id |
| **Translations** | `apps/web/src/lib/i18n/{en,zh}.ts` | Keys must exist in both locales; `visible-copy.test.ts` rejects hardcoded English in TSX |
| **Workspace setting** (admin-editable runtime config) | `packages/types/src/workspace-settings.ts` | One `WORKSPACE_SETTINGS` entry (`key`, `group`, `type`, `secret?`, `env?`) — the Runtime Config page renders from it, no migration |
| **Model** | `apps/api/src/config/models.yaml` | Catalog entry with a provider chain; `api_key_env` / `model_env` / `base_url_env` name the env vars; unset keys hide the model |
| **Agent profile** | `apps/api/src/profiles/*.yaml` (or a `packs.profiles` directory) | Validated on load by `validateProfile()` in `apps/api/src/profiles/profile.ts`; keep prompts free of tool-specific rules (those belong in tool descriptions) |
| **Skill pack** (first-party skill) | `skillhub/<group>/<name>/SKILL.md` (+ `CHANGELOG.md`, assets), or a `packs.skills` root | Synced into the Skill Center on boot; see `skillhub/README.md` |
| **Automation-eligible write tool** | `packages/types/src/automation-tools.ts` | Opt-in catalog of tools an owner may grant to an unattended run |
| **Upload storage backend** | `apps/api/src/storage/uploads.ts` | Local disk by default; Tencent COS when `TENCENT_CLOUD_COS_*` are set; Skill Center bundles use `SKILLS_S3_*` |
| **Notification transport** | `apps/api/src/notifications/` | Durable delivery attempts per transport (email, WeCom, Feishu) |
| **Integration (OAuth callback, bot)** | `plugins/wecom/api/`, `plugins/feishu/api/` as reference implementations | Plugin callback paths are declared by `publicPaths` on each active plugin — keep that list minimal |

## Golden rules

1. **Registries, not forks of shared files.** If a change needs an edit to `registry.ts`,
   `index.ts`, `provider.ts` beyond the one-line registration, add the missing seam to the
   registry instead of special-casing your module.
2. **Permissions are declared, not hand-rolled.** Tools declare `surface` and `is_global`, and
   feature points map each flag or application to the tools it owns; applications declare
   capabilities and entity/field policies in the manifest. Transport layers (HTTP, chat,
   proxy, MCP) adapt protocol only — they never make a second permission decision.
   Extensions inherit this: a guard on a route, a flag on a tool, never both halves
   re-deciding.
3. **Declared capabilities must be real.** A tool description, UI option or doc must not claim
   something the code cannot do; unconfigured paths fail explicitly.
4. **Delete with the same discipline as you add.** Removing a module means removing its
   translations, nav entries, docs and tests in the same change.
5. **Generic improvements go upstream.** Anything that could exist without your private
   domain belongs in Greenhouse; keep only genuinely private modules on your branch.

## Recipe: a private module as an extension

1. For a new module use the package recipe above. For an existing SDK 1 overlay keep
   `apps/api/src/extensions/<id>` and `apps/web/src/extensions/<id>`; use the contract examples in this section.
2. Add the import + list entry in both `extensions/index.ts` files; enable the id in
   `greenhouse.config.ts` (or `GREENHOUSE_EXTENSIONS`).
3. Tables: write `migrations/0001_*.sql` (or generate it with a per-extension drizzle config),
   declare `resetTables`, expose services through `services`.
4. Tools: one file per tool with `defineTool`; own them through a feature point so the
   permissions dialog shows one switch for the whole module. Declare `mcpGroups` if the module
   should be separately consentable over MCP, and `entityKinds` + `searchSources` if it owns
   records people will link to and search for.
5. UI: a page under `#/<id>`, a "More" entry, translations under `ext.<id>.*`, a card for the
   tool's result.
6. Tests: a `*.db.test.ts` for the service, a route test, and a seam test that imports the
   extension with `GREENHOUSE_EXTENSIONS=<id>` (see `plugins/example/api/__tests__/seam.test.ts`).

## Recipe: a list/edit page with `@greenhouse/crud`

The low-code CRUD framework turns one declarative schema into a list + filters + add/edit
form + detail + delete.

- **Server:** `createTableCrudService(getDb(), tableName, { columns, scope, searchFields })` (from `@greenhouse/db`) →
  `createCrudRoutes(service, { filterable, sortable, guards, hooks, parseCreate, parseUpdate })`
  (from `@greenhouse/crud/server`) → mount in `index.ts` (or in an extension's `routes`).
  Filter/sort keys are whitelisted fail-loud (unknown key → 400).
- **Client:** `defineCrud<Row>({ dataSource: createRestDataSource('/api/…', authFetch), columns,
  filters, formFields, access, … })` then render `<CrudPage schema={…} />`. Reference
  implementations: `apps/web/src/pages/administration/users.tsx`, `skills.tsx`, `mcp-keys.tsx`.
- **Escape hatches, narrow → wide:** column/field `type: 'custom'` (render fn) → `slots` +
  `tableActions` / `pageActions` → use `CrudPage` / `CrudForm` / `CrudDetail` standalone in a
  bespoke page (`installCrudUi` wires the host's UI kit once, in `app.tsx`).

## Optional module contributions (4.0)

Official packages use the same boundaries as private plugins. Memory and Feedback are enabled by
default; Reports and Computer require deployment enablement. Their legacy REST URLs remain stable.
The existing `services(db)` factory provides only the plugin's typed DB bag. New contribution fields:

| Field | Consumer and contract |
|---|---|
| `promptContext: [{toolIds, build(userId, role)}]` | Stable system prompt fragments; Chat supplies the actual turn tool ids. Owner/feature checks remain in the contributor. |
| `billableServices` | Service catalog definitions plus optional async `isEnabled`; pricing, budget selectors and usage read the active catalog. |
| `toolAvailability` | Async tool-id checks shared by external listings and admission. |
| `settingValidators` | Synchronous `(key, value) => error or null`, called by the existing workspace-settings write validator. |
| `activity` | Audit actions, modules, tool-write descriptions and permission-aware target hydration. |
| `summarySources` | Optional aggregate sections for monthly summaries; disabling a contributor leaves empty sections. |
| `retention: [{table, column, days}]` | Existing daily retention, bounded by batch size and maximum batches; identifiers validated and deletion counts audited. |
| `seeds: [{dir, tables}]` | JSONL example rows after core parents; custom packs.seeds overrides the directory. |
| web `tabs: [{host, key, labelKey, component}]` | Optional tabs on an existing host page, included in the browser surface sweep. |
| web `slots: [{slot, component}]` | Optional settings sections; the host queries active contributions only. |

`meta.builtin: true` works for plugin tools through the existing catalog-derived builtin set.
The generic lazy builder excludes `surface.externalOnly`; external tools use the external builder.
Plugin cron callbacks have local overlap protection and a shared per-minute claim in rate_limits,
so replicas do not execute the same scheduled occurrence twice. Claim failures prevent execution.

Adoption SQL uses the exact baseline columns, guarded foreign keys and `IF NOT EXISTS` indexes.
No DROP is emitted when ownership leaves core. Generate a custom core migration and advance its
snapshot; the snapshot is the current protection set, while historical DDL remains the fresh-install
and 1.x carry reference. Keep every applied migration immutable.

Automation opt-in entries (`automationTools: [{id, tier, order?, labelKey?}]`) come from active plugins; the API includes them in `/api/extensions`, and the client replaces its optional catalog when the station changes. `hubContext` contributes MCP group descriptions and overview/bundle hints, each gated by reachable tool ids. Settings/Administration module ownership also selects the extension's existing context provider. Optional Runtime Config group labels use `ext.<group>.settingsGroup` from the existing message registry.

## Communication adapters

`defineExtension` accepts four optional registries, aggregated through `fromExtensions`:

| Field | Consumer | Contract |
|---|---|---|
| `notificationTransports` | durable delivery worker and automation queue | `{ id, title, deliver({db, notification, attempt}), bindingSettings? }`; `automationRecipients(task)` derives server-owned envelopes from stored preferences. Only active channels are claimed, so disabling retains pending rows for re-enablement. `acceptsWebhook(URL)` owns its exact allowlist; `sendWebhook(url, markdown)` also serves system producers such as skill quarantine notices. `accountLinks` optionally supplies immediate audited password-link mail. |
| `notificationKinds` | DB notification write validation | Downstream ids use `ext:<id>:<kind>`; core kinds remain accepted. Historical values remain readable. Kind and channel CHECKs are replaced by service registry validation. |
| `identityProviders` | public `GET /api/auth/providers`, binding/start/callback routes | `{ id, title, icon, login, bind, path, available(), start(ctx), callback(ctx) }`. Discovery exposes only id/title/icon/login of configured providers, no state or secrets. The host mounts the existing prefix, protects binding/start, and leaves callback authentication to single-use state. Core `bindProviderIdentity` enforces active internal users and one identity per account. Extra protocol routes use `routes`; only explicitly declared `publicPaths` bypass central auth. |
| `channels` | API boot/shutdown | `{ id, start({db, toolRegistry}) }`; start may return a shutdown callback. `channelAgentRuntime()` resolves the member's normal tool pipeline; `runAgentTurn()` uses the existing metered session runner. |

`configurationEnv: string[]` names infrastructure variables that require the package. When any is set while that package is disabled, boot logs one enablement hint; it does not activate or call the integration.

The classic web half contributes `identityProviders` (`id`, optional login component, optional binding component) and `notificationTransports` (`id`, `preference`, component, optional webhook label/hint). Login components are selected by public discovery; authenticated binding/form components are selected by the enabled extension set. UI copy stays under `ext.<id>.*`. `surface.unattendedDenied` on a tool overrides all unattended grants.

Email, WeCom and Feishu retain their 3.0 routes, recipient envelopes and preference keys. Email's feature flag defaults on for members **only when its package is enabled**. WeCom is binding-only; Feishu also supplies login and its bot channel. The phone callback remains `greenhouse://auth/feishu`. Their generic identity tables stay core; private table/service ownership is documented in the plugin directories. No plugin jobs are invented for email: mailbox reads already fetch live over IMAP.

## Agent context and optional data surfaces

`agentContext` is one object on defineExtension, aggregated by the active registry. It accepts
`promptFragment(ctx)`, `resources: [{name,title,description,read(ctx)}]` and
`prompts: [{name,title,description?,arguments?,render(args,ctx)}]`. A dynamic prompt collection
uses `{list(ctx) => Promise<Prompt[]>, get?(name,args,ctx) => Promise<TeamPrompt|null>}`;
the optional lookup keeps prompts directly addressable beyond a bounded listing. Context contains db, userId, role, actor and reachable
(the member/grant's actual tools). The host first intersects reach with the owner's tools;
optional `toolIds` narrows it further. No tool access means no fragment, resource or prompt.
Fragments are capped at 2000 characters each and appended to the stable system prefix; authors
must keep them session-stable. They cannot rewrite the core prompt or model call.

Resources use `greenhouse://ext/<id>/<name>` in MCP and the compact team_context bundle (3000
characters, with full resource URI). Prompts use `ext-<id>-<name>`. `legacyPromptPrefixes` plus
an entry's explicit `legacyName` preserve an existing protocol name; duplicates fail. SkillHub
uses this for skill-* and compatibility prompt-* access. Saved-prompt storage/rendering stay
core and are also reachable through chat grants. Listing and reading recheck reach each request.

| Contribution | Existing consumer |
|---|---|
| `objectRefs: [{type,resolve(ref,ctx)}]` | batched `/api/refs/resolve`; same actor/capability cache as core; return a hidden title for unreadable records |
| `recentChanges: [{id,load(db,runtime,viewer,window,need)}]` | team activity feed; use kit scanRecentChanges/recentChangeDraft and activitySql cursor helpers to preserve the bounded merge frontier |
| activity `auditCapabilities`, `auditShapes`, `actionEntities`, `toolShapes`, `toolTargets` | distinguish domain history from platform writes and hydrate targets with plugin access rules |
| `rateLimits: [{path,windowMs,max,internalMax?}]` | existing IP/member admission counter; only active routes contribute, longest plugin prefix first |
| `retiredToolAliases: {oldId: [successorId]}` | stored Agent profile expansion; aliases disappear with their owner, and successors must be live tools; collisions fail boot |
| web page `applicationId` | explicitly register an application's classic URL without host id cases |
| web tab `default`, `page`, `titleKey`, `descriptionKey`, `sidebarPanel` | optional catalogue beside the core saved-prompt page; panel receives subPath/params and, with `page`, owns its page shell and receives the tab bar |
| web `contextProviders`, `resolveContext`, `entitySync` | active page context and browser invalidation using existing registries |

An empty page module key registers its root identity as the extension id. Official reserved
entity kinds retain their wire names; plugins register their route template like any other kind.
Classic entity UI and context providers are hidden while their owner is disabled. Plugin e2e
specs import only @playwright/test and use the shared authenticated browser state.

### Tables extraction seams (4.0)

- `catalogSources: [{id, replaceDefaultSource?, load(CatalogInput)}]` contributes the existing data-catalog `bases` and truncation fields through `fromExtensions`; loaders enforce the caller's reachable tools and platform actor. Core does not know the owning application. `replaceDefaultSource` suppresses the automatic tool-source entry when the plugin owns its full catalog presentation.
- `discriminators` registers `shareResources`, `fileLinkTargets`, `folderScopes`, `auditApps`, `runKinds`, and `artifactKinds`. Core service writes reject unknown values; historical reads survive disabled plugins. Application ids also register from active applications. Knowledge registers its legacy values from its package; the host has no domain bridge.
- `driveScopes` can add `placement(input,userId)`, `validatePlacement(input)` and `authorizeNode(node,ctx)` for a legacy placement contract. Omitted fields preserve the existing owner_key behavior. Tables keeps base_id without changing stored rows.
- `meta.interactiveOnly` declares a draft that requires a person at its card; the catalog adds it to the shared headless deny list after catalog construction.
- Web `toolCards` can add `matches(output)` and receive `actionId` / `sessionId` from the host. Read-only conversations receive neither handle. `placement: below` preserves prose-before-confirm order.

Tables' nine tables are owned by its schema and idempotent adoption lane. It is enabled by default and uses the same boundary rules as private packages. Shared InlineEditCell remains core because other plugins already use that kit primitive.


### Knowledge, team context and monthly summaries (4.0)

- Knowledge is enabled by default; Retro is compiled but disabled and depends on Knowledge. Both retain their old URLs, ids and document links. Their schemas/rules live with the packages.
- `teamContextSources: [{toolIds,resolve(db,config),validate(db,input),candidates(db)}]` supplies published team documents and administrative selection metadata. The built-in Markdown settings remain useful with no plugin. Existing document ids stay in `team_context.conventions/glossary`; disabling their source never clears stored values. One document selection source is installed per deployment.
- `mcpResources: [{toolIds,list(caller),templates(caller),read(uri,caller)}]` preserves domain URI schemes and dynamic templates. Callers include the actual reachable tool set and actor; providers enforce their own platform/record ACL. Example notes demonstrates direct reads and a template; arbitrary URI probing must return undefined without revealing existence.
- `toolResults` contributes `ToolResultAdapter` entries (toolId, summarizeInput/Output, references, relevance). Streaming, recovered steps and headless transcripts use the same adapter. The exact Runtime evidence is unaffected. Error outputs produce no references.
- `settingValueValidators` validates/canonicalizes non-string settings with ValidationResult or null when it does not own the key. Existing string settingValidators remain supported.
- `workspaceTimeZoneChanged` callbacks replan active schedules; `schedules[].nextRun` supplies existing administrative schedule metadata. `runExtensionJob(id,run,occurrence)` shares claims across replicas. Retro's one-shot planner retains UTC-close protection.
- driveScopes may supply `authorizeSync`, `hasFolderContents(db,folderId)` and `cabinet: true`. This keeps Knowledge's legacy kb cabinet for the default installation; a zero-plugin host uses its independent drive cabinet. A second cabinet selector is rejected.
- Classic web `wsEvents` and `onReconnect` are dispatched only to active owners. Page navigationOrder preserves relative application placement without host id cases. Existing slots supply optional document pickers and review actions.
- Active activity contributions own writeLabels/writeRisks and dynamic auditShape. The host's destructive/base-r3 classification remains authoritative before a lower plugin tier.

The executable import audit is `node scripts/check-plugin-boundaries.mjs --core-only`; the full checker also audits plugin production imports. It parses imports, re-exports, import types and literal dynamic loads instead of relying on line-oriented grep.

Run the populated upgrade rehearsal with:

```sh
TEST_DATABASE_URL=postgresql://greenhouse:greenhouse@127.0.0.1:55450/gh4_test \
  VITEST_UNIT_MAX_WORKERS=4 VITEST_DB_MAX_WORKERS=3 \
  pnpm exec vitest run tests/db/plugin-upgrade.db-commit.test.ts
```

It creates a throwaway database at the explicit test server, applies the immutable 3.0 migration subset, inserts connected data in every one of the 24 extracted tables, and runs the current core plus plugin lanes. Counts and full-row fingerprints must remain identical, including a Knowledge-off/on cycle. It drops only that uniquely named fixture database.

The shared leaf `@greenhouse/knowledge-editor/markdown` is an allowed plugin import for server conversion (declare its package dependency); classic browser editor primitives are exposed through the web kit. The API host does not depend on that package.

Classic `defaultQuickActions()` contributes optional Assistant launcher actions. The host filters by active owner, so disabling a module removes its launcher entry.

A toolResults adapter may also contribute legacyCalls handlers for proxy and DSML recovery. Only active owners normalize old names; the Knowledge adapter preserves its exact historical action/scope merges.


## Data plugins (SDK 2)

`plugins/example` is the executable walkthrough. Enable it with
`GREENHOUSE_EXTENSIONS=example`. Its old notes table, migration files, tools and
classic routes remain usable; the new API is `/api/ext/example/entities/note`.
SDK 1 declarations continue to activate throughout 4.x; new packages declare
`sdk: 2` in both `package.json.greenhouse` and the pure-data `manifest.ts`.

1. Describe the application with the kit's `defineApp`: modules, entities, fields,
   `accessScopes` and `classification` are the platform kernel DSL. Each data
   entity uses its own module id so capabilities are `<app>.<entity>.<action>`.
   Pass `actions: {}` in the app; `dataSources[].entities[].actions` derives the
   actions. An action maps to `team` or `super`; omitted actions are disabled.
2. Add `dataSources: [{ app, entities: { note: { actions: { read: 'team',
   create: 'team', update: 'team', delete: 'team', export: 'team' },
   ownerField: 'userId', columns: { userId: 'user_id' },
   audit: 'all', peek: { title: 'body', subtitle: 'createdAt' }, views: [...] } } }]`.
   Field ids stay lowerCamelCase; `columns` maps adopted physical column names.
   Tables still belong to the plugin migration lane. Table-backed entities need
   an `id` field and a database-generated primary key/default for create.
3. This derives the application, role capabilities and field policies, an app
   feature point, MCP group, query/mutation tools, guarded CRUD routes, catalog,
   search/export lanes, entity kinds, peek and entity list/detail page metadata.
   The defaults are `<plugin>_query` and `<plugin>_mutation`; a read-only data
   source has no mutation tool. Multiple sources must choose distinct tool ids
   with `tools.query.id` / `tools.mutation.id`. An existing entity-kind route
   explicitly declared by the plugin wins, preserving historical deep links.
4. REST uses the existing CRUD protocol: `POST /list` with
   `{ filter: [{key, method, value: [...]}], sort: [{key, order}], skip, limit }`
   returns `{items, total}`. `GET /` accepts the same fields (`filter` and `sort`
   JSON-encoded); `GET /:id`, `POST /`, `PATCH /:id` (`PUT` remains accepted),
   `DELETE /:id`, and `GET /:id/peek` share the same runtime checks. Unknown
   filters/sorts return 400; denied actions return 403; inaccessible records
   return 404. The query tool uses `entity`, `action` (`list/get/search/aggregate`),
   `filters`, `sort`, `skip`, `limit`, `query` and `id`. Aggregate returns a scoped
   count. MCP deletes use the host's preview + `confirm: true` flow.
5. Scope checks run before table paging/counting: `own` requires `ownerField`;
   `collaborating` requires a JSON-array `memberField`. Creation binds the owner
   to the caller. Policy scopes are OR-ed. Unsupported scopes fail at definition.
   Team policies expose public/internal fields, mask confidential fields and hide
   restricted fields; those last two are neither writable nor exportable.
   Filtering/sorting masked or hidden fields is denied. Super gets the existing
   full-access policy. `export` still needs its own capability and field policy.
6. Override only needed operations in `handlers.list/get/search/export/create/update/delete`.
   The example customizes search. Each handler receives `{db, actor, policy,
   service}`; `service` is the already-scoped `createTableCrudService` adapter.
   Delegate to it to preserve totals, pagination and atomic row restrictions.
   Custom handlers own equivalent scope/transaction correctness for their own
   external I/O; the host rejects returned rows outside the member scope and
   projects readable/exportable fields. Never return secrets in audit metadata.

All generated operations enter `runtime.dispatch`. `audit: 'writes'` omits
successful query audits; `audit: 'all'` records them. Denied/failed dispatched actions are always
recorded. Commands appear in the existing activity log under the plugin id.
Custom routes can bind a registered command with `recordWrite(request, operation)`;
`notify(input)` uses the durable notification center plus push/WS delivery.
Register custom notification kinds as `ext:<id>:<kind>`.

Subscribe with `hooks: hooks => { hooks.on('user.created', async ({userId}) => ...) }`.
The exact event set is `user.created`, `user.disabled`, `run.completed`,
`conversation.turn.completed`, `automation.ran`. Producers publish ids and metadata
only after authoritative writes resolve; subscribers run asynchronously, cannot veto
writes and have independent 5-second deadlines. Runtime observations use the committed
outbox and may repeat on delivery retries: subscribers must be idempotent. A timeout
stops waiting for a handler, not its external I/O; use bounded/cancellable I/O.
`onInstall(ctx)` runs after migrations and before `onBoot`, once per plugin/database.
The lane records `@onInstall` under its advisory lock after success; failures retry.
The hook must be idempotent across a crash after side effects but before the marker.

`manifest.ts.surfaces` declares pure-data `nav` and `pages`. Official pages use
`kind: 'native'`, `screen` and `fallback_url`; declarative data pages use
`entity-list`/`entity-detail`, with `settings-form` and `embed` as escape hatches.
`requireRole: 'super'` and administration settings pages are omitted for members.
`GET /api/extensions` returns the member-filtered station manifest v2 with actions,
fields, kinds, features and MCP groups, retaining the 3.x `extensions`/`entityKinds`
fields. `/api/bootstrap.mobile_api` is 4 (`CLIENT_API_LEVEL`).
The example's `ui.dir` serves static files at `/ext/example/ui/` with same-origin
frame CSP; static assets are public, while data APIs stay authenticated. Full embed
host rendering, short-lived embed tokens and universal-client work belong to the
client wave; this SDK wave publishes their page metadata and the example static UI.

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
  in the two index files; an id list to trim per deployment. `GREENHOUSE_EXTENSIONS=crm,example`
  (or `all`, or empty for none) overrides the file so one image serves several deployments.
- **`packs`** — content, not code: skill packs, profile YAMLs and a seed dataset that live outside
  the repository (a fork's `packs/` folder, a mounted volume). Paths are absolute or relative to
  the repository root.
- **`clients.stations`** — how the browser extension and the mobile app treat servers. `multi`
  (default) lets users add and switch stations; `single` locks a client build to the one station in
  `defaults`. See `apps/browser/src/AGENTS.md` and `apps/mobile/AGENTS.md` for the build wiring.

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
the active extensions and fold their contributions in. Copy `apps/api/src/extensions/example`
and `apps/web/src/extensions/example` to start: together they exercise every field.

### The API half — `defineExtension`

```ts
// apps/api/src/extensions/crm/index.ts
import { defineExtension, extensionPath, requireFeature } from '../../extension-kit.js';

export const crmExtension = defineExtension({
  id: 'crm',                        // lowercase, digits, dashes — also the config switch
  name: 'CRM',
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
| `tools` | tool catalog → chat, `/api/agent`, `/api/mcp`, workbench | `meta.surface` decides exposure exactly like a core tool. Lazy tools implement `createLazy(ctx)` (user, session, db) — no per-tool case in core. Ids must not collide. |
| `routes` | mounted after the typed core chain | Convention `/api/ext/<id>`; `guards` run for every request under the prefix. Extension routes are not part of the public `AppType` contract. |
| `applications` | platform kernel (`bootstrapPlatform` + `initializePlatformRuntime`) | Manifest v2 + handlers; scaffold with `pnpm cli platform create-app <id>`. |
| `featureFlags` / `featurePoints` | `user_features`, the permissions dialog, feature-owned tool sets | Extension flags are strings (the compile-time `FeatureKey` union stays core-only). A non-global tool must belong to exactly one point. |
| `workspaceSettings` | Runtime Config (one section per extension), `workspace_settings` table, env overlay | Key `<id>.<name>`, `group: '<id>'`; secrets are encrypted at rest and write-only over the API. |
| `publicPaths` | `isPublicPath()` in the auth middleware | Keep minimal — OAuth callbacks, webhooks. |
| `jobs` | started/stopped with the scheduler | croner syntax; zone defaults to `SCHEDULER_TIMEZONE`. |
| `commands` | `pnpm cli <name>` and `pnpm cli --help` | Namespace with the id: `crm:import`. |
| `migrations` | the extension migration lane | Ordered `NNNN_name.sql` files, `--> statement-breakpoint` between statements (what `drizzle-kit generate` emits). Applied at boot under an advisory lock, tracked in `extension_migrations` with a checksum — editing an applied file fails fast. Core DDL stays in `drizzle/`. |
| `services` / `resetTables` | `db.extensions[<id>]`, integration-test truncation | Keep a typed accessor: `getExtensionServices<CrmServices>(db, 'crm')`. |
| `entityKinds` | in-app deeplinks (`entityUrl` / `parseEntityUrl`) and chat peeks | `{ kind: 'ext:crm:company', route: '#/crm/companies/:id' }` — one template drives both directions. Put the URL in a tool result and the chat renders a peek instead of a link. |
| `searchSources` | the ⌘P palette | One lane per record kind; it applies its own permission check and a failure only empties its own group. |
| `mcpGroups` | MCP consent + OAuth scopes | `['crm']` gives `mcp:crm`; tools join it with `surface.mcp: 'crm'`. Existing grants never pick up a new group. |
| `exportSources` | the `export_data` tool's source union | A whole-dataset lane (`crm_customers`) so the model exports server-side instead of transcribing rows. Apply your own authorization; the tool only persists the result. |
| `applications[].teamExportableEntities` | the `team` role's bootstrap field policy | Which of your entities a normal user may export in full. Empty by default — bulk export is a deliberate grant. |
| `applications[].platformTools` | MCP tool visibility | Ties `crm_query` / `crm_mutation` to the application's query / command actions, so a fully denied tool disappears from `tools/list` like core's do. |
| `dependsOn` | a boot-time check | Ids this extension needs switched on too. Two extensions in one build can import each other by path; this makes the configuration requirement explicit and fails fast instead of deep inside a request. Reserve it for the genuinely unshareable — an authenticated transport, a credential chain. |
| `driveScopes` | the shared Drive (`drive_folders` / `drive_files`) | Your own file cabinet inside core's tables: rows carry `scope: '<your scope>'` and `owner_key` (any text — a record id), and the `authorize(ownerKey, ctx)` you declare is the only rule core applies. |
| `workbenchRecipes` | Home workbench card picker + `workbench_query.recipes` | Backed by one of the extension's own read tools; `labelKey` / `descriptionKey` translate it. |
| `skillPacks` | Skill Center seed at boot | Same layout as `skillhub/`. |
| `onBoot` / `onShutdown` | after the tool registry exists, before routes serve; on SIGTERM | |

Import what you need from `apps/api/src/extension-kit.ts` (`defineTool`, `getDb`,
`getAuthUser`, `requireFeature`, `getWorkspaceValue`, `GREENHOUSE_CONFIG`, types). Deeper
imports into core stay possible; the kit is the documented stable subset.

### The web half — `defineWebExtension`

```ts
// apps/web/src/extensions/crm/index.ts
import { lazy } from 'react';
import { defineWebExtension } from '../../extension-kit';

export const crmWebExtension = defineWebExtension({
  id: 'crm',
  messages: { en: { title: 'CRM', … }, zh: { title: '客户', … } },   // merged under ext.crm.*
  pages: [
    {
      route: 'crm',
      component: lazy(() => import('./page')),
      sidebarPanel: CrmNavPanel,
      titleKey: 'ext.crm.title',
      // Optional: sub-modules of this page — `#/crm/companies`, module id `crm.companies`.
      modules: [{ key: 'companies', labelKey: 'ext.crm.companies', icon: Users }],
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
| `navigation` | the sidebar "More" menu (desktop flyout + mobile drawer) | `requireFeature` / `requireRole` hide the entry per user. |
| `modules` | Settings ("Extensions" section) or Administration | Key becomes `#/settings/<key>` or `#/administration/<key>`; pins and breadcrumbs work. |
| `messages` | i18n, under `ext.<id>.*` | `t('ext.crm.title')` type-checks; a missing locale falls back to English. The visible-copy guard still rejects hard-coded English in your TSX. |
| `toolCards` / `toolIcons` | chat transcript, tool catalogs | A card replaces the trace row once the tool returned without error; `placement: 'below'` renders after the prose. |
| `entityKinds` | peek / side-pane chrome and body for the kinds the API half registered | Same `kind` string on both halves; `render` is optional (without it the peek offers "open full page"). |
| `mcpGroups` | consent screen and machine-client form | Display copy for a group the API half owns; the group only appears while the extension is active. |
| `knowledgeDocPanels` | every knowledge document, between backlinks and comments | For things attached to documents — provenance, sync state. |
| `contextProvider` | the agent panel on your pages | Receives `{ type: 'extension', extension, route, subPath }`. |

`apps/web/src/extension-kit.ts` re-exports `authFetch`, `useT`, the UI kit, `useAuthStore`,
`canUseFeature`, `usePageActions` and the contract types.

On the browser side, `<DriveBrowser owner={{ scope: 'crm', owner_key: String(companyId) }} />`
renders that cabinet with the same UI Tables and Knowledge use.

### What the seam does not cover (yet)

Notification transports (email / WeCom / Feishu) and workbench **pinning** of extension records
are still closed in core — pinning needs a read tool plus an action mapping per kind, which no
extension has asked for yet. If your module needs one, extend the registry upstream rather than
patching around it: that is a contribution, not a fork.

### Keeping a fork thin

A fork keeps its private modules under `apps/*/src/extensions/<id>/`, its content under
`packs/`, its deployment files under `deploy/`, and its own `greenhouse.config.ts`; it syncs with
`git merge upstream/main`. `scripts/check-extension-overlay.mjs` fails the fork's CI when a commit
touches anything else, so a gap in the seam surfaces as an upstream pull request instead of a
patch that will conflict on the next merge:

```bash
git remote add upstream https://github.com/linjiejim/greenhouse.git && git fetch upstream
node scripts/check-extension-overlay.mjs upstream/main
```

The rule of thumb: **code that could exist without your business goes upstream; content,
credentials and business-specific modules stay in the overlay.**

## Core extension points

Everything below is also what the extension seam feeds; use these directly when the change
belongs to Greenhouse itself.

| Add a… | Where | Mechanism |
|---|---|---|
| **Agent tool** (auto-exposed on chat, `/api/agent`, `/api/mcp`) | `apps/api/src/tools/<name>.ts` + one line in `tools/registry.ts` | `defineTool({ meta, kind, requires?, create })`; `meta.surface` decides proxy / MCP exposure and the workbench binding; `meta.is_global` decides default availability |
| **Platform application** (module with entities, permissions, navigation) | `apps/api/src/platform/manifests/<app>.ts` + `apps/api/src/platform/<app>/application.ts`, registered in `index.ts` (`initializePlatformRuntime`) and `platform/bootstrap.ts` | Manifest v2 (JSON-serializable) + registration handlers; scaffold with `pnpm cli platform create-app <id>`; bump `manifest.version` whenever the serialized manifest changes |
| **Feature flag** (per-user opt-in / opt-out) | `packages/types/src/features.ts` | `FEATURE_FLAGS` entry; guard routes with `requireFeature('<key>')`; the admin toggle appears automatically |
| **Feature point** (what a flag / app owns) | `apps/api/src/platform/feature-points.ts` | Maps a flag or app to its tool ids and capability prefix so one switch controls app + REST + MCP + chat |
| **API route** | `apps/api/src/routes/<resource>.ts`, mounted in `apps/api/src/index.ts` (`mountRoutes`) | Chained Hono routes (they become part of the typed `AppType` contract used by the web client) |
| **Database table + service** | `packages/db/src/schema/<domain>.ts` + `services/<domain>.ts`, one line in `provider.ts` | Drizzle schema → `pnpm drizzle-kit generate` → review SQL → commit; services are typed factories, the provider type is inferred |
| **Web page / navigation** | `apps/web/src/pages/**`, `apps/web/src/lib/nav-registry.ts`, hash routes in `apps/web/src/app.tsx` | Settings/Administration modules come from `nav-registry`; top-level pages are hash routes in `app.tsx`; platform apps surface through the permission-aware catalog (`apps/web/src/platform/`) |
| **Chat card for a tool output** | `apps/web/src/components/tool-call/body-artifacts.tsx` + `tool-call-card.tsx` | Tool results render from the tool's `presentation` metadata; add a body renderer keyed by tool id |
| **Translations** | `apps/web/src/lib/i18n/{en,zh}.ts` | Keys must exist in both locales; `visible-copy.test.ts` rejects hardcoded English in TSX |
| **Workspace setting** (admin-editable runtime config) | `packages/types/src/workspace-settings.ts` | One `WORKSPACE_SETTINGS` entry (`key`, `group`, `type`, `secret?`, `env?`) — the Runtime Config page renders from it, no migration |
| **Model** | `apps/api/src/config/models.yaml` | Catalog entry with a provider chain; `api_key_env` / `model_env` / `base_url_env` name the env vars; unset keys hide the model |
| **Agent profile** | `apps/api/src/profiles/*.yaml` (or a `packs.profiles` directory) | Validated by `@greenhouse/types/profile-manifest`; keep prompts free of tool-specific rules (those belong in tool descriptions) |
| **Skill pack** (first-party skill) | `skillhub/<group>/<name>/SKILL.md` (+ `CHANGELOG.md`, assets), or a `packs.skills` root | Synced into the Skill Center on boot; see `skillhub/README.md` |
| **Automation-eligible write tool** | `packages/types/src/automation-tools.ts` | Opt-in catalog of tools an owner may grant to an unattended run |
| **Upload storage backend** | `apps/api/src/storage/uploads.ts` | Local disk by default; Tencent COS when `TENCENT_CLOUD_COS_*` are set; Skill Center bundles use `SKILLS_S3_*` |
| **Notification transport** | `apps/api/src/notifications/` | Durable delivery attempts per transport (email, WeCom, Feishu) |
| **Integration (OAuth callback, bot)** | `apps/api/src/wecom/`, `apps/api/src/feishu/` as reference implementations | Public callback paths are listed in `auth/middleware.ts` (`PUBLIC_PATHS`) — keep that list minimal |

## Golden rules

1. **Registries, not forks of shared files.** If a change needs an edit to `registry.ts`,
   `index.ts`, `provider.ts` beyond the one-line registration, add the missing seam to the
   registry instead of special-casing your module.
2. **Permissions are declared, not hand-rolled.** Tools declare `requires` and `surface`;
   applications declare capabilities and entity/field policies in the manifest. Transport
   layers (HTTP, chat, proxy, MCP) adapt protocol only — they never make a second permission
   decision. Extensions inherit this: a guard on a route, a flag on a tool, never both halves
   re-deciding.
3. **Declared capabilities must be real.** A tool description, UI option or doc must not claim
   something the code cannot do; unconfigured paths fail explicitly.
4. **Delete with the same discipline as you add.** Removing a module means removing its
   translations, nav entries, docs and tests in the same change.
5. **Generic improvements go upstream.** Anything that could exist without your private
   domain belongs in Greenhouse; keep only genuinely private modules on your branch.

## Recipe: a private module as an extension

1. Copy `apps/api/src/extensions/example` → `apps/api/src/extensions/<id>` and
   `apps/web/src/extensions/example` → `apps/web/src/extensions/<id>`; rename the id everywhere.
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
   extension with `GREENHOUSE_EXTENSIONS=<id>` (see `apps/api/src/extensions/__tests__/seam.test.ts`).

## Recipe: a list/edit page with `@greenhouse/crud`

The low-code CRUD framework turns one declarative schema into a list + filters + add/edit
form + detail + delete.

- **Server:** `createTableCrudService(getDb(), myTable, opts)` (from `@greenhouse/db`) →
  `createCrudRoutes(service, { filterable, sortable, guards, hooks, parseCreate, parseUpdate })`
  (from `@greenhouse/crud/server`) → mount in `index.ts` (or in an extension's `routes`).
  Filter/sort keys are whitelisted fail-loud (unknown key → 400).
- **Client:** `defineCrud<Row>({ dataSource: createRestDataSource('/api/…', authFetch), columns,
  filters, formFields, access, … })` then render `<CrudPage schema={…} />`. Reference
  implementations: `apps/web/src/pages/administration/users.tsx`, `skills.tsx`, `mcp-keys.tsx`.
- **Escape hatches, narrow → wide:** column/field `type: 'custom'` (render fn) → `slots` +
  `tableActions` / `pageActions` → use `CrudPage` / `CrudForm` / `CrudDetail` standalone in a
  bespoke page (`installCrudUi` wires the host's UI kit once, in `app.tsx`).

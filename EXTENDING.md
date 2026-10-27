# Plugins

Greenhouse 4.0 consists of a governance core, official plugins and deployment-specific plugins.
All in-process plugins use the same registries, kits, permission model and migration lane.
Start with [plugins/example](plugins/example); it exercises SDK 2 data sources and SDK 1
compatibility transports. The identifiers `defineExtension`, `/api/extensions` and
`GREENHOUSE_EXTENSIONS` remain the code/API vocabulary.

## Configuration and assembly

| Layer | Purpose |
|---|---|
| `.env` | Infrastructure, secrets, ports and fallback credentials. |
| Runtime Config / Branding Studio | DB-backed live settings and branding; secrets encrypted and write-only. |
| `greenhouse.config.ts` | Compiled packages, active ids, packs, hosting and client station structure. |

```ts
import { defineConfig } from '@greenhouse/types/config';

export default defineConfig({
  plugins: ['./plugins/example'],
  extensions: { enabled: ['example'] },
  packs: { skills: ['packs/skills'], profiles: ['packs/profiles'] },
  clients: { web: 'classic', stations: { mode: 'multi', defaults: [] } },
});
```

This is a minimal deployment, replacing the official package list. To extend a standard install,
append your package and id to the existing lists. All dependencies must be compiled and enabled.

- `plugins` accepts repo-relative paths or installed package names. Workspace names resolve
  without a root dependency; installed packages must be deployment dependencies.
- `GREENHOUSE_PLUGINS` overrides assembly (comma-separated names/paths; empty builds no packages).
- `extensions.enabled` accepts an id list or `'all'`, including SDK 1 in-tree registrations.
  `GREENHOUSE_EXTENSIONS` overrides it at boot; an empty value activates none.
- `pnpm plugins:sync` generates static imports in
  `apps/{api,web}/src/extensions/compiled.generated.ts`. Never edit or commit these ignored files.
  Install, dev, build, checks, tests and CLI commands sync automatically.
  `pnpm plugins:sync --check` checks generated output without replacing it.
- A changed compiled list requires rebuilding; enablement changes require restarting.
  There is no hot loading, directory loader or database-managed enablement switch.
- `clients.web` selects classic or universal at `/`; `/classic/` remains available in both modes.
  `clients.stations` describes client builds; mobile/desktop mirror station settings at build time.

The upstream enabled set is Knowledge, Tables, SkillHub, Feedback and Memory. The other seven
official plugins and Example are compiled but off. See [README](README.md#three-rings) for the
complete lists and [CHANGELOG](CHANGELOG.md#upgrading-from-3x) for the 3.x migration recipe.

## Package layout and kits

```text
plugins/<id>/
  package.json            package metadata, exports and declared dependencies
  manifest.ts             pure JSON-serializable default export
  api/index.ts            default defineExtension export (optional)
  web/index.ts            default defineWebExtension export for classic (optional)
  api/schema.ts           owned tables (when needed)
  api/services.ts         typed accessor for the plugin service bag
  migrations/*.sql        immutable extension migration lane
  ui/                     optional trusted static frontend; ui/dist wins when built
  e2e/*.e2e.ts            browser specs, importing only @playwright/test
  README.md               purpose, defaults, settings/env, tables, tools and routes
```

```json
{
  "name": "@greenhouse/plugin-example",
  "version": "4.0.0-rc.1",
  "type": "module",
  "greenhouse": { "id": "example", "sdk": 2, "api": "./api/index.ts", "web": "./web/index.ts" },
  "exports": { "./manifest": "./manifest.ts", "./api": "./api/index.ts", "./web": "./web/index.ts" }
}
```

A manifest supplies `id`, `name`, `version`, `sdk`, `core`, optional `dependsOn`, `features`,
`client_min`, `surfaces` and `ui`. Import package.json for the package version; do not import
API/web code into the manifest. Package id/SDK/version must agree with the manifest. The folder
is `<id>` (installed packages may use `plugin-<id>`). API/web halves are optional, including a
manifest-only static UI. Cycles, duplicate ids, missing exports and invalid metadata fail assembly.

```ts
import manifest from '../manifest.js';
import { defineExtension, extensionPath } from '@greenhouse/api/extension-kit';

export default defineExtension({
  ...manifest,
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  // Add only contributions the plugin implements.
});
```

Production imports may use:

- Their app's `@greenhouse/api/extension-kit` or `@greenhouse/web/extension-kit`.
- `@greenhouse/types/*`, `@greenhouse/crud`, `@greenhouse/ui/*`, `@greenhouse/ui-tokens`.
- The shared `@greenhouse/knowledge-editor/markdown` leaf for server Markdown conversion.
- Own files, Node builtins, and declared third-party dependencies.
- Plugin package exports declared in both `dependsOn` (ids) and package.json (dependencies).

Relative paths cannot leave a package. Do not import host source, DB, utils or kernel packages
directly; kits expose the needed primitives. Core imports no plugin code except generated
registrations. The AST boundary scanner checks imports, re-exports, import types and computed
loads; SDK 1 retains its separate scanner. Tests may reach host hooks. `pnpm lint` runs the
package guard; `node scripts/check-extension-overlay.mjs --all --strict` also checks seam imports.
Both kit export lists are snapshot-locked; removals/renames update the snapshot and an
`extension-kit:` CHANGELOG entry. Add a symbol only for an actual plugin consumer.

### SDK 1 and SDK 2

SDK 2 is the current declaration revision. SDK 1 remains accepted throughout 4.x, including
`apps/api/src/plugin-host/<id>/` and `apps/web/src/extensions/<id>/` with their existing index
lists. New work uses packages. Declare a `core` semver range that actually includes 4.0
(e.g. `>=4.0.0 <5.0.0`); `>=3.0 <4` excludes this release. Activation checks `APP_VERSION`,
falling back to root package.json; prereleases count as their base release for compatibility.
Declare both fields for new plugins. Missing legacy declarations currently warn (the warning text calls them required from 4.0); incompatible declared SDKs/ranges fail activation.

SDK 1 React pages, tool cards and page context remain classic-only. SDK 2 adds data sources,
Agent context, observations/install hooks and portable station surfaces. Deprecated
`workbenchRecipes`, `meta.surface.workbench` and `WidgetRecipe` remain accepted no-ops in this
checkout; do not use them for new work. They do not provide a Home workbench.

## Data plugins (SDK 2)

The executable definition is [plugins/example/api/index.ts](plugins/example/api/index.ts).
Enable it with `GREENHOUSE_EXTENSIONS=example` for an isolated demonstration. Its original
`ext_example_notes` table, notes endpoints, tools and `#/example/notes/:id` links remain available.
Its member feature defaults off: use a super test account or grant the Example feature before
exercising the plugin as a team member.

1. Define an app with the kit's `defineApp`: modules, entities, fields, `accessScopes` and
   `classification` use the platform kernel DSL. Use the entity id as its module id; derived
   capabilities are `<app>.<entity>.<action>`. The app's `actions: {}` is filled by the data source.
2. Register `dataSources` with per-entity actions, owner/member fields, physical column mappings,
   views and peek. Own the table and migrations yourself; the data kit does not generate DDL.
3. Reuse generated handlers unless a real operation needs customization. Example only customizes
   search and delegates to the already-scoped service.

```ts
// Inside defineExtension; defineApp comes from the API kit.
dataSources: [{
  app: defineApp({
    id: 'notes', title: 'Notes', version: '1.0.0',
    modules: { note: { title: 'Notes' } }, actions: {},
    entities: { note: {
      title: 'Note', module: 'note', table: 'ext_notes_notes', accessScopes: ['own'],
      fields: {
        id: { kind: 'text' },
        body: { kind: 'text', required: true, searchable: true, filterable: true, sortable: true },
        userId: { kind: 'user', classification: 'internal' },
      },
    } },
  }),
  entities: { note: {
    actions: { read: 'team', create: 'team', update: 'team', delete: 'team', export: 'team' },
    ownerField: 'userId', columns: { userId: 'user_id' }, audit: 'all',
    peek: { title: 'body' },
    views: [{ id: 'default', columns: ['body'], filters: ['body'] }],
  } },
}]
```

Table-backed creates need an id field and a database-generated key/default. The manifest's
app version is a schema contract, separate from the product/package version; bump it when the
serialized app definition changes.

| Derived contribution | Existing registry/consumer |
|---|---|
| Application, action capabilities, row/field policies | Platform kernel and role bootstrap |
| App feature point and MCP group | Member access dialog and OAuth consent |
| `<plugin>_query`, optional `<plugin>_mutation` | Tool catalog, chat, Agent API and MCP |
| `/api/ext/<plugin>/entities/<entity>` | Guarded CRUD REST |
| Data counts, search and export | Data catalog, global search and `export_data` |
| `ext:<plugin>:<entity>` routes and peek | Entity links and generic clients |
| Entity list/detail metadata | Station manifest v2 |

Omitted actions are disabled. Read-only sources have no mutation tool. Multiple sources choose
distinct tool ids via `tools.query.id` / `tools.mutation.id`. An explicit entity-kind route wins
over the generated one, so a plugin can preserve old links without duplicate registrations.

### Requests, permissions and writes

REST list protocol: `POST /list` with
`{filter: [{key, method, value: [...]}], sort: [{key, order}], skip, limit}` returns
`{items, total}`. `GET /` accepts JSON-encoded filter/sort query parameters. Also supported:
`GET /:id`, `POST /`, `PATCH /:id` (`PUT` accepted), `DELETE /:id`, `GET /:id/peek`.
Unknown filters/sorts return 400; denied actions 403; unreadable records 404.

Query tools accept `entity`, `action` (`list`, `get`, `search`, `aggregate`), `filters`, `sort`,
`skip`, `limit`, `query`, `id`; aggregate is a scoped count. All transports enter
`runtime.dispatch`: capability → row/field policy → handler → audit. `audit: 'writes'` omits
successful read audits; `'all'` records them. Dispatched denials/failures are recorded.

- `own` requires `ownerField`; `collaborating` requires a JSON-array `memberField`. Scope
  restrictions apply in SQL **before** paging/counting. Policy scopes are OR-ed.
- Default team fields expose public/internal values, mask confidential values and hide
  restricted ones; masked/hidden fields cannot be filtered/sorted to infer their content.
  Export requires its own capability and exportable fields. Super uses the full read policy.
- Writes intersect field grants with the declaration. Ids, storage creation/update/deletion
  timestamps (including physical mappings), internal/confidential/restricted fields and
  `writable: false` are immutable input **even for super**.
- Other business fields are writable by default. Owner/member fields additionally need
  explicit `writable: true`, field permission and the action capability. Create validates input,
  then stamps the effective caller as owner. Unknown/forbidden fields reject atomically with
  400 naming all invalid fields; old broad persisted grants cannot bypass this.
- Clients use the member-specific `writable === true` manifest fields and PATCH only changes,
  preserving untouched null, JSON and timestamp values. Generic `createCrudRoutes` can take
  request-specific `writableFields`, checked before parsers/stamping hooks.
- Custom `handlers.list/get/search/export/create/update/delete` receive `{db, actor, policy,
  service}`. Delegate to `service` for scoped paging and atomic restrictions. External handlers
  own equivalent authorization/transaction correctness; host output still gets scope/field checks.

Writing tools declare `meta.surface.proxy: 'write'`; never label a write as read. MCP records
writes as member-owned runs and previews delete-like actions before `confirm: true` execution.
Agent API writes require confirmation. Handwritten protected routes use guards and the same
platform actions; `recordWrite(request, operation)` binds a registered command. Never put secrets
in audit metadata. `meta.builtin` widens only profile filtering, never member permissions.
`meta.interactiveOnly` and `surface.unattendedDenied` constrain unattended use. Tools need a
real `create()` (static) or `createLazy()` (lazy); invalid declarations fail early.

## Agent context

`agentContext` contributes a stable `promptFragment(ctx)`, MCP `resources` with `read(ctx)`,
and `prompts` with `render(args, ctx)`. The host intersects the member/grant's reachable tools
with the owner's tools and optional `toolIds`; no reach means no contribution. Fragments are
capped at 2,000 characters and must remain session-stable for prompt caching. They cannot
replace the core system prompt or intercept model calls.

Resources use `greenhouse://ext/<id>/<name>` and enter the compact `team_context` bundle
(3,000-character resource excerpts plus full URIs). Prompts use `ext-<id>-<name>`. Dynamic
prompt collections use `list(ctx)` and optional `get(name,args,ctx)` for direct lookup beyond
listing limits. `legacyPromptPrefixes` / explicit `legacyName` preserve existing names;
SkillHub keeps `skill-*` and compatible `prompt-*` access. Listing and reading recheck permissions.

`mcpResources` supports domain URI lists/templates/reads, with the actual actor and reachable
tools; reject unreadable probes without leaking existence. `teamContextSources` contributes
published team-document selection, validation and candidates. Core Markdown settings work
without any plugin; disabled document sources do not clear stored selections. A deployment
allows one document-selection source and one Drive cabinet selector.

## Lifecycle, observations and jobs

`onInstall(ctx)` runs after migrations, before `onBoot`, once per plugin/database. The migration
lane writes its `@onInstall` marker under the advisory lock after success; failures retry.
A crash after a side effect but before the marker can repeat the hook, so it must be idempotent.
`onBoot` prepares a process; `onShutdown` releases its resources. Enablement takes effect at
restart, with no separate enable/disable lifecycle.

Subscribe with `hooks: hooks => { hooks.on('user.created', async ({userId}) => { ... }) }`.
The five events are `user.created`, `user.disabled`, `run.completed`,
`conversation.turn.completed` and `automation.ran`. They carry ids/metadata, run asynchronously
and cannot veto core writes. Each subscriber has an isolated five-second deadline; it does not
cancel external I/O. Runtime observations use committed outbox delivery and can repeat;
consumers must be idempotent and use bounded/cancellable I/O.

`jobs` use croner syntax and the scheduler timezone by default. Run scheduled work through the
host's job claims (`runExtensionJob` for custom planners) so replicas do not duplicate an
occurrence. `workspaceTimeZoneChanged` replans schedules; `schedules[].nextRun` exposes their
administrative next-run metadata. `notify(input)` writes the durable notification center and
queues mobile push/WS; custom kinds register as `ext:<id>:<kind>`.

## Registries

Every contract field feeds a real consumer. Use the typed kit definitions and official packages
for full signatures rather than creating a second registry.

| Contribution | Consumer and rule |
|---|---|
| `tools`, `applications`, `featureFlags`, `featurePoints`, `mcpGroups` | One catalog/permission chain across HTTP, chat, proxy and MCP. Non-global tools belong to one feature point; `applications[].platformTools` hides tools when all relevant actions are denied. |
| `workspaceSettings`, `settingValidators`, `settingValueValidators` | Runtime Config; namespaced keys/group, optional env fallback; raw-value validators handle non-string settings. |
| `services` | DB factory exposed via `db.extensions[id]`; use a typed `getExtensionServices` accessor. This is distinct from pricing. |
| `billableServices`, `toolAvailability` | Price catalog and request-time admission; Computer is the reference. |
| `notificationTransports`, `notificationKinds` | Durable delivery/preferences, password-link mail and skill quarantine hooks. Recipient envelopes are validated; core owns inbox/mobile push. |
| `identityProviders` | Public `/api/auth/providers`, guarded binding/start and state-authenticated callback routes. Only configured providers are discovered. Feishu supports login/binding; WeCom binding only. |
| `channels` | Starts/stops a bot channel; reuse `runAgentTurn` / `channelAgentRuntime` for member permissions and metering. |
| `configurationEnv` | Warns about configured but disabled integrations; never activates them. |
| `retention` | Bounded daily cleanup of owned table/column data; Feishu receipts are the reference. |
| `searchSources`, `exportSources`, `catalogSources` | Permission-filtered search/export/catalog; `replaceDefaultSource` avoids duplicate catalog entries. Source failures stay within their lane. |
| `entityKinds`, `objectRefs` | Deep links/peek and batched title resolution. Do not reveal unreadable titles. Official legacy kinds (`kb_doc`, `project`, `tables_record`) keep their URLs. |
| `discriminators` | Registers `shareResources`, `fileLinkTargets`, `folderScopes`, `auditApps`, `runKinds`, `artifactKinds`; writes validate active values, historical reads remain possible. |
| `driveScopes` | Core Files/folders with plugin authorization, placement, node checks and occupancy; optional `cabinet: true` selects one legacy cabinet. |
| `activity`, `recentChanges` | Write labels/risks, action/target shapes and the bounded team-activity merge. Host destructive-risk classification remains authoritative. |
| `toolResults`, `retiredToolAliases` | Compact transcript/references/relevance and legacy call normalization; exact Runtime evidence remains intact. Stored profile aliases resolve only while their successors are active. |
| `automationTools`, `hubContext`, `promptContext` | Explicit unattended grants, reachable MCP hints and stable context contributions. They never expand member permissions. |
| `summarySources` | Aggregates for system summaries; avoid member names, message text and private titles. |
| `routes`, `publicPaths`, `rateLimits`, `commands` | Guarded plugin HTTP routes, minimal callback/webhook auth exceptions, central admission and CLI commands. New routes use `/api/ext/<id>`; official packages retain legacy prefixes. |
| `migrations`, `resetTables`, `seeds`, `skillPacks` | Owned DDL, test truncation, dependency-ordered seeds and SkillHub content sync when that plugin is active. |

The classic web kit aggregates `pages` (including aliases), `navigation`, `modules`, `tabs`,
`slots`, `messages`, `toolCards`/icons, `entityKinds`, `mcpGroups`, `knowledgeDocPanels`,
identity/transport controls, context providers/resolvers, entity sync, WS/reconnect handlers
and quick actions. Copy belongs under `ext.<id>.*`, registered in both languages. Aliases
preserve tails/query strings and cannot replace core routes. Read-only conversations receive
no mutation action/session handles. Reuse existing editors, forms and inline cell primitives.

## Surfaces and trusted embeds

`manifest.surfaces` is pure data exposed by authenticated `/api/extensions` v2. The host filters
plugins/nav/pages/entities/actions/fields/features/groups/kinds to the member, preserving the
v1 fields. `client_min` is the wire spelling; server `CLIENT_API_LEVEL` and bootstrap
`mobile_api` are 4. The current universal minimum remains 3 with legacy-discovery fallback.

| Page kind | Renderer |
|---|---|
| `native` | A compiled universal screen (`screen`) with a declared classic `fallback_url`. Official adapters live under `apps/client/src/plugins/<id>/` because Expo is outside the workspace. |
| `entity-list` | Derived entity metadata, scoped paging/filter/sort and permitted create actions. |
| `entity-detail` | Member-readable fields and permitted edit/delete actions. |
| `settings-form` | Declared Runtime Config keys; only changed keys submitted. The API remains super-only regardless of `parent`. |
| `embed` | Trusted plugin static UI in an iframe or native WebView. |

Nav declares `primary`/`more`, ordering, labels/icons and a page. The universal client shows
every entry in its rail under the core places (primary first), so keep `label` short (about
ten Latin characters; the page `title` can be longer) and name a lucide icon (`BookOpen`,
`Mail`); clients map it to their own icon set and draw a generic app tile for unknown names.
Role/feature requirements hide inaccessible surfaces. Unknown native/page types use a validated browser fallback.
Classic generic routes are `#/ext/<plugin>/<page>`; entity links remain resolvable. Existing
SDK 1 React injection is confined to classic.

Declare `ui: './ui'` in the manifest (or API `ui: {dir}` for compatibility). Assembly resolves
paths inside the package. `/ext/<id>/ui/` serves `ui/dist` when present, otherwise source UI;
disabled plugins return 404. HTML/mutable files revalidate; fingerprinted assets cache
immutably. Dotfiles/traversal are refused. Static assets are public and must contain no secrets
or member data. `pnpm plugins:ui:build` builds Example's frontend using the real bridge.

`@greenhouse/ui-tokens` exports token names, generated light/dark values, brand resolution and
`connectGreenhouse`. Its source of truth is `packages/ui/src/tokens`; run `pnpm tokens:build`.
Mobile constructs its own payload without importing the workspace package.

```ts
import { connectGreenhouse } from '@greenhouse/ui-tokens';
const host = connectGreenhouse({ onInit: ({ user }) => showMember(user) });
// Use host.token as the Bearer only after init, and only for this plugin's API.
await host.refresh();
host.title('My notes');
host.navigate('#/ext/example/note');
host.sendPrompt('Help me organize these notes'); // opens an editable draft, never submits
// host.disconnect() on unmount
```

The bridge uses `greenhouse:init` (theme, tokens/brand, locale, basic member, route, token),
`greenhouse:ready`, `greenhouse:theme`, `greenhouse:token-refresh` (request),
`greenhouse:token` (renewal response), `greenhouse:title`,
`greenhouse:navigate` and `greenhouse:sendPrompt`. Both sides validate source window and exact
origin. Themes update without replacing the frame. The helper keeps credentials in memory;
refreshes deduplicate and time out after 15 seconds.

`POST /api/ext-ui/token {plugin}` requires the full host session and issues a ten-minute
credential bound to member, auth generation and plugin. It admits only that plugin's
`/api/ext/<id>/*` routes and basic `GET /api/me` (id/name/role). Every request still checks
account/plugin visibility and route permissions. It cannot mint renewal tokens or call unrelated
core APIs. Do not inject full login tokens, store narrow tokens or put credentials in URLs.

The trusted iframe permits scripts/same-origin/forms/popups. This is installed code trust,
not an isolation boundary against a malicious same-origin plugin; ordinary user HTML previews
retain opaque-origin sandboxes and receive no credentials. Static UI CSP permits frame ancestors
`'self' tauri://localhost`. Desktop embeds have no native capabilities and must explicitly
allowlist `host_origin=tauri://localhost` before passing it to `connectGreenhouse({hostOrigin})`.
Never trust arbitrary origin hints. Remote-origin credentialed embeds/OAuth are not implemented.

## Database ownership and migrations

Keep schema/services in the package; core has no plugin service accessor. New tables use
`ext_<id>_*`; retained official tables keep existing names. Core ids are opaque text; never
parse them as numbers. Plugin tables may reference core; core must not acquire plugin FKs.
Use `db.users`, `db.drive`, `db.platform` and kit facades for core data (organization `'default'`).

Core schema owns 49 tables; ten official data plugins own 24. The immutable 3.0 baseline still
creates the original 73 tables even with no plugins enabled. Ownership migrations do not drop
or move them; `0001_adopt.sql` guards table/index/constraint creation. Example's extra table
and the migration ledger are separate. See [DB ownership](packages/db/src/db-schema.md).

Plugin lane files use `NNNN_name.sql` and `--> statement-breakpoint`. They run after the core
chain in `pnpm db:migrate` and idempotently at boot, with checksums/advisory locking in
`extension_migrations`. Never edit applied bytes or create core-owned tables in a lane.
Use a plugin-specific Drizzle config/snapshot that includes only its schema and points to its
migrations directory; review generated SQL. Always set `DATABASE_URL` explicitly. Persistent
and shared databases use migrations, never `push`.

Files headed `-- greenhouse:core-generation 1x` never execute on 4.x: fresh databases record
them as skipped; carried databases require the copied applied row or refuse startup. The marker
is outside the checksum. `migrate-from-1x` copies plugin tables/ledger verbatim into a new DB.
`pnpm cli db baseline --dry-run` is only for adopting an existing matching 3.x-generation
schema, not migrating 1.x; compare DDL first. `--through` leaves later files to actually run.

Disabling retains data and applied ledger. `pnpm seed` loads core plus enabled-plugin seeds
in dependency order; it does not populate disabled plugin modules.

## CLI and administration

```bash
pnpm cli plugins list --json
pnpm cli plugins status --json
pnpm cli plugins drop example          # preview; refuses enabled or unknown owners
pnpm cli plugins drop example --yes    # deliberately deletes owned data and lane
pnpm cli db status
```

`list` needs no DB; status reports migration state and process-local boot facts. CLI inspection
does not run boot hooks (`not-run`). Administration → Plugins (`GET /api/admin/plugins`, super)
is read-only. Migration/boot failures stop startup; no historical error store or one-click
activation is implied. Drop works transactionally under the migration lock, derives owned tables
from current-generation DDL plus resetTables, and refuses core/shared/external dependencies
with `RESTRICT`, never `CASCADE`. Review its preview and back up before running deletion.

## Testing a plugin

- Put unit tests beside logic; they must not touch PostgreSQL.
- Use `*.db.test.ts` for real transactional DB behavior, rollback per test.
- Use `*.db-commit.test.ts` only for cross-connection commits/DDL/locks; state
  `@db-commit-reason`, use isolated fixtures and clean up.
- Test enabled and disabled contributions, permission denials, scopes/field masks, write
  allowlists, audit, deletion preview/confirmation, compatibility endpoints and generated pages.
- Put Playwright specs in `plugins/<id>/e2e/*.e2e.ts`, importing only `@playwright/test`.
  The extensions project discovers compiled packages; the classic surface sweep opens every
  registered hash. Enable your plugin for the browser stack. Universal specs are under
  `tests/client-e2e` and run with `pnpm test:e2e:client`.

```bash
pnpm typecheck
pnpm lint
pnpm plugins:sync --check
node scripts/check-extension-overlay.mjs --all --strict
TEST_DATABASE_URL=<loopback-test-url> VITEST_UNIT_MAX_WORKERS=4 VITEST_DB_MAX_WORKERS=3 pnpm test
DATABASE_URL=<loopback-test-url> E2E_NO_LLM=1 pnpm test:e2e:ci
pnpm test:core
pnpm web:build
```

`test:core` temporarily assembles zero packages, checks core types/tests and boots a real API,
then restores normal registrations. Run it sequentially with other assembly/build commands.
DB targets must be explicit loopback test/e2e databases. A populated 3.0 upgrade rehearsal
in `tests/db/plugin-upgrade.db-commit.test.ts` verifies all 24 extracted tables by row count
and full-row hashes, including Knowledge off/on. Browser tests and the screenshot tour require
an environment that can launch Chromium; collection alone is not browser acceptance.

## Downstream overlay workflow

Keep private packages in `plugins/`, legacy SDK 1 modules in the seam, content in `packs/`,
deployment files in `deploy/` and structural choices in `greenhouse.config.ts`. Merge
`upstream/main`, then run:

```bash
node scripts/check-extension-overlay.mjs --base upstream/main --strict
# OVERLAY_UPSTREAM_REF may supply the base instead.
```

The guard rejects core edits and deep imports. Add generic missing hooks upstream, with an
Example consumer and seam tests. Fork-specific CI/CD belongs in `.github/workflows/fork-*.yml`;
upstream workflows are repository-gated. Dependency manifests/lockfiles may change for packages
under the guard's rules. In-process plugins can access the process/DB: trust comes from review,
pinned dependencies and boundary checks, not from the kit being a sandbox. Never load plugin
code from requests, DB rows or untrusted uploads.

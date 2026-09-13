# Extending Greenhouse

Greenhouse is meant to be extended with your own tools, applications and integrations. Every
capability plugs into a **registry** that already drives chat, the `/api/agent` proxy, the
`/api/mcp` server, permissions and the admin UI — so an extension is almost always "one new
file + one registry line", never a scattered set of edits.

> Earlier releases (≤ 0.6) shipped a separate family of `*.extensions.*` seam files that were
> pinned empty upstream. Those seams were retired: the registries below are the extension
> points now, and a downstream fork simply keeps its additions on its own branch.

## Extension points

| Add a… | Where | Mechanism |
|---|---|---|
| **Agent tool** (auto-exposed on chat, `/api/agent`, `/api/mcp`) | `apps/api/src/tools/<name>.ts` + one line in `tools/registry.ts` | `defineTool({ meta, kind, requires?, create })`; `meta.surface` decides proxy / MCP exposure and the workbench binding; `meta.is_global` decides default availability |
| **Platform application** (module with entities, permissions, navigation) | `apps/api/src/platform/manifests/<app>.ts` + `apps/api/src/platform/<app>/application.ts`, registered in `index.ts` (`initializePlatformRuntime`) | Manifest v2 (JSON-serializable) + registration handlers; scaffold with `pnpm cli platform create-app <id>`; bump `manifest.version` whenever the serialized manifest changes |
| **Feature flag** (per-user opt-in / opt-out) | `packages/types/src/features.ts` | `FEATURE_FLAGS` entry; guard routes with `requireFeature('<key>')`; the admin toggle appears automatically |
| **Feature point** (what a flag / app owns) | `apps/api/src/platform/feature-points.ts` | Maps a flag or app to its tool ids and capability prefix so one switch controls app + REST + MCP + chat |
| **API route** | `apps/api/src/routes/<resource>.ts`, mounted in `apps/api/src/index.ts` (`mountRoutes`) | Chained Hono routes (they become part of the typed `AppType` contract used by the web client) |
| **Database table + service** | `packages/db/src/schema/<domain>.ts` + `services/<domain>.ts`, one line in `provider.ts` | Drizzle schema → `pnpm drizzle-kit generate` → review SQL → commit; services are typed factories, the provider type is inferred |
| **Web page / navigation** | `apps/web/src/pages/**`, `apps/web/src/lib/nav-registry.ts`, hash routes in `apps/web/src/app.tsx` | Settings/Administration modules come from `nav-registry`; top-level pages are hash routes in `app.tsx`; platform apps surface through the permission-aware catalog (`apps/web/src/platform/`) |
| **Chat card for a tool output** | `apps/web/src/components/tool-call/body-artifacts.tsx` + `tool-call-card.tsx` | Tool results render from the tool's `presentation` metadata; add a body renderer keyed by tool id |
| **Translations** | `apps/web/src/lib/i18n/{en,zh}.ts` | Keys must exist in both locales; `visible-copy.test.ts` rejects hardcoded English in TSX |
| **Workspace setting** (admin-editable runtime config) | `packages/types/src/workspace-settings.ts` | One `WORKSPACE_SETTINGS` entry (`key`, `group`, `type`, `secret?`, `env?`) — the Runtime Config page renders from it, no migration |
| **Model** | `apps/api/src/config/models.yaml` | Catalog entry with a provider chain; `api_key_env` / `model_env` / `base_url_env` name the env vars; unset keys hide the model |
| **Agent profile** | `apps/api/src/profiles/*.yaml` | Validated by `@greenhouse/types/profile-manifest`; keep prompts free of tool-specific rules (those belong in tool descriptions) |
| **Skill pack** (first-party skill) | `skillhub/<group>/<name>/SKILL.md` (+ `CHANGELOG.md`, assets) | Synced into the Skill Center on boot; see `skillhub/README.md` |
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
   decision.
3. **Declared capabilities must be real.** A tool description, UI option or doc must not claim
   something the code cannot do; unconfigured paths fail explicitly.
4. **Delete with the same discipline as you add.** Removing a module means removing its
   translations, nav entries, docs and tests in the same change.
5. **Generic improvements go upstream.** Anything that could exist without your private
   domain belongs in Greenhouse; keep only genuinely private modules on your branch.

## Recipe: a private module

1. Scaffold the application: `pnpm cli platform create-app crm --title "CRM" --dry-run`, then
   fill in the manifest (entities, fields, actions) and the registration handlers.
2. Add its tools as a query / mutation pair (`crm_query`, `crm_mutation`) with `defineTool`,
   declaring `surface.proxy` and an MCP resource group; list them in `TOOL_MODULES`.
3. Add a feature flag (`packages/types/src/features.ts`) and a feature point that owns the two
   tools and the `crm.*` capability prefix.
4. Schema + service in `packages/db`, migration via `drizzle-kit generate`.
5. Web: pages under `apps/web/src/pages/crm/`, a hash route in `app.tsx`, translations, and an
   `entity-links` kind if records should open as peeks from chat.
6. Tests: a `*.db.test.ts` for the service, a route test, and an entry in the tool-surface
   guard test so the exposed set changes consciously.

## Recipe: a list/edit page with `@greenhouse/crud`

The low-code CRUD framework turns one declarative schema into a list + filters + add/edit
form + detail + delete.

- **Server:** `createTableCrudService(getDb(), myTable, opts)` (from `@greenhouse/db`) →
  `createCrudRoutes(service, { filterable, sortable, guards, hooks, parseCreate, parseUpdate })`
  (from `@greenhouse/crud/server`) → mount in `index.ts`. Filter/sort keys are whitelisted
  fail-loud (unknown key → 400).
- **Client:** `defineCrud<Row>({ dataSource: createRestDataSource('/api/…', authFetch), columns,
  filters, formFields, access, … })` then render `<CrudPage schema={…} />`. Reference
  implementations: `apps/web/src/pages/settings/users.tsx`, `skills.tsx`, `mcp-keys.tsx`.
- **Escape hatches, narrow → wide:** column/field `type: 'custom'` (render fn) → `slots` +
  `tableActions` / `pageActions` → use `CrudPage` / `CrudForm` / `CrudDetail` standalone in a
  bespoke page (`installCrudUi` wires the host's UI kit once, in `app.tsx`).

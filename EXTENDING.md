# Extending Greenhouse (downstream forks)

Greenhouse is designed to be **forked and personalized** without diverging from upstream. A downstream fork adds its private tools, routes, tables, pages, profiles, providers and translations through **extension points** — small files that ship **empty upstream** and are spliced into the central registries. Because the fork edits only these extension files (and adds new files of its own), the shared registry files (`registry.ts`, `index.ts`, `app.tsx`, `provider.ts`, …) stay **byte-identical to upstream** and never conflict when you pull a new Greenhouse release.

Every extension point is guarded by a test that pins it **empty in this repo**, so an open-source build can never ship private code.

## The boundary model

| Layer | What it is | How a fork extends it |
|---|---|---|
| **Versioned packages** — `@greenhouse/{agent-core, types, utils, contract, knowledge-editor}` | Consumed over npm; the fork **cannot** edit them | **Runtime `register*()` / DI hooks** called at startup |
| **Consumer-owned source** — `apps/api`, `apps/web`, `packages/db` | The fork keeps its own synced copy | **Designated `*.extensions.*` files** spliced into the central file |

## Extension points

| # | Add a private… | Edit this file | Mechanism |
|---|---|---|---|
| S1 | agent tool (auto-exposed on chat + `/api/agent` + `/api/mcp`) | `apps/api/src/tools/extensions.ts` | `EXTENSION_TOOL_MODULES` |
| S2 | API route | `apps/api/src/routes/extensions.ts` | `EXTRA_ROUTES` (mounted out of the `AppType` contract, like `/api/client-tools`) |
| S3 | LLM provider / provider options / model middleware (re-add DeepSeek/Anthropic/DSML) | *(fork startup code)* | `registerProviderFactory` / `registerProviderOptionsBuilder` / `registerProviderMiddleware` from `@greenhouse/agent-core` |
| S4-db | DB table + service (typed `db.x.*`) | `packages/db/src/extensions.ts` | `createExtensionServices` + `EXTENSION_RESET_TABLES` (flow into the inferred `DatabaseProvider`) |
| S4-profile | system profile | `apps/api/src/profiles/extensions.ts` | `EXTENSION_SYSTEM_PROFILES` |
| S5 | settings nav section / translations | `apps/web/src/lib/nav-registry.extensions.ts` / `registerLocaleMessages` | `EXTENSION_SETTINGS_SECTIONS` / i18n fallback |
| S6 | branding (name / logo / theme tokens) | `apps/web/src/branding.extensions.tsx` + `apps/web/src/branding.css` + *(env)* | `BRANDING` (product name + logo mark); design-token CSS overrides — generate with Settings → Branding Studio (super) and paste into `branding.css`; `PRODUCT_NAME` env sets the document title + `BRANDING` default; replace `public/favicon.*` assets. Env-only knobs: `CORS_ALLOWED_ORIGINS`, storage/vision env |
| S7 | feature flag | *(fork startup code)* | `registerFeatureFlags()` from `@greenhouse/types` |
| S8 | top-level page + settings panel | `apps/web/src/lib/page-registry.tsx` + `apps/web/src/pages/settings/panels.extensions.tsx` | `EXTRA_PAGES` / `findSettingsPanel` |
| S9 | custom chat card for a tool output | `apps/web/src/components/tool-call/artifact-renderers.ts` | `ARTIFACT_RENDERERS` |
| S10 | Global-Agent page context (URL → PageContext) | `apps/web/src/lib/context-resolvers.ts` | `registerUrlContextResolver` |
| S11 | pipeline-step summary for a tool | *(fork startup code)* | `registerToolOutputSummarizer()` from `@greenhouse/agent-core` |
| S12 | CRUD field/column widget type (for `@greenhouse/crud`) | `apps/web/src/lib/crud.extensions.ts` | `registerCrudField` / `registerCrudColumn` (called from `registerCrudExtensions()`, wired in `app.tsx`); reference in a schema via `{ type: 'extension', name }` |
| G0 | **wire the runtime hooks at startup** | `apps/api/src/bootstrap.extensions.ts` + `apps/web/src/bootstrap.extensions.ts` | `bootstrapForkExtensions()` (api) — the call-site for every `register*()` below |
| G1 | upload storage backend (S3 / COS) | `apps/api/src/storage/extensions.ts` | `registerStorageDriver()` |
| G2 | email connector (Gmail / Outlook) | `apps/api/src/email/extensions.ts` | `registerEmailConnector(provider, factory)` |
| G3 | public (auth-skipped) path — OAuth callbacks | `apps/api/src/auth/extensions.ts` | `EXTENSION_PUBLIC_PATHS` / `EXTENSION_PUBLIC_PATH_PREFIXES` |
| G4 | SSO identity connector (private IdP: DingTalk / corporate OIDC / …) | `apps/api/src/auth/sso/extensions.ts` | `EXTENSION_SSO_CONNECTORS` — implement `SsoConnector` (authorize URL + code→identity); login/bind/JIT flows, routes, and `/api/auth/sso/:id/*` public paths come for free |
| G5 | CSP `connect-src` for external origins | *(env)* | `CSP_CONNECT_SRC` (space/comma-separated) — no code edit |

**Startup wiring (G0):** the `*.extensions.*` **array** seams are auto-imported by their central file — no wiring needed. The **runtime `register*()`** seams (S3, S5-i18n, S7, S10, S11, G1, G2) must be *called* at startup: put every API call inside `bootstrapForkExtensions()` in `apps/api/src/bootstrap.extensions.ts` (invoked at the start of `main()`), and every web call in `apps/web/src/bootstrap.extensions.ts` (imported first by `app.tsx`). This is the one place a fork wires them — `index.ts` / `app.tsx` stay untouched.

DB migrations for private tables live in the **fork's own** drizzle namespace (e.g. `drizzle-fork/`, timestamp-prefixed filenames) — never in this package's `drizzle/` chain.

## Golden rules (keep upstream mergeable)

1. **Generic improvements go upstream first.** Anything that could exist without your private domain lands in Greenhouse and comes back via a version bump — this is what stops the core from re-diverging.
2. **Private code = new files + one extension file.** Never edit a shared file except through an extension point. If a private need forces a shared-file edit, that's the signal to add/extend a seam **upstream**, not to patch downstream.
3. **Scope stays split.** Core packages stay `@greenhouse/*` and are consumed verbatim; private packages are your own scope. Never re-scope core.
4. **Seam changes are upstream-only.** Adding or widening an extension point is a core change → upstream → version bump. Never widen a seam locally.

## Recipe: add a private module (e.g. CRM)

1. `apps/api/src/tools/crm/*.ts` (`defineTool`) → list in `tools/extensions.ts`.
2. `apps/api/src/routes/crm.ts` → add to `EXTRA_ROUTES` in `routes/extensions.ts`.
3. `packages/db/src/services/crm.ts` + schema files → return from `createExtensionServices` in `db/extensions.ts`; add table names to `EXTENSION_RESET_TABLES`; generate migrations in `drizzle-fork/`.
4. `apps/web/src/pages/crm/*` → register in `page-registry.tsx` (top-level tab) and/or `panels.extensions.tsx` + `nav-registry.extensions.ts` (settings module).
5. Optional: `registerFeatureFlags([{ key: 'crm', … }])` to gate it; `registerUrlContextResolver('crm', …)` for Global-Agent context; `registerLocaleMessages('zh', { crm: … })` for i18n.

## Recipe: build a list/edit page with `@greenhouse/crud`

The low-code CRUD framework turns one declarative schema into a list + filters + add/edit form + detail + delete. See the reference at `apps/web/src/pages/settings/crud-example.tsx` (+ `apps/api/src/routes/crud-demo.ts`).

- **Server (own a table):** `createTableCrudService(getDb(), myTable, opts)` (from `@greenhouse/db`) → `createCrudRoutes(service, { filterable, sortable, guards, hooks, parseCreate, parseUpdate })` (from `@greenhouse/crud/server`) → mount in `routes/extensions.ts`. Filter/sort keys are whitelisted **fail-loud** (unknown key → 400).
- **Server (proxy an external API):** implement `CrudService` yourself (forward to the upstream admin API); the protocol matches, so the translation is thin — no table required.
- **Client:** `defineCrud<Row>({ dataSource: createRestDataSource('/api/…', authFetch), columns, filters, formFields, access, … })` then render `<CrudPage schema={…} />`. Adapt an existing hc route by hand-writing a `CrudDataSource` instead of `createRestDataSource` (see `settings/prompts.tsx`).
- **Escape hatches, narrow → wide:** column/field `type: 'custom'` (render fn) → `type: 'extension'` (S12 registered widget) → `slots` (toolbar / banner / rowExpand) + `tableActions` / `pageActions` → use `CrudPage` / `CrudForm` / `CrudDetail` standalone in a bespoke page (see `settings/mcp-keys.tsx`).

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
| S6 | branding | *(env)* | `PRODUCT_NAME`, `CORS_ALLOWED_ORIGINS`, storage/vision env — no code edit |
| S7 | feature flag | *(fork startup code)* | `registerFeatureFlags()` from `@greenhouse/types` |
| S8 | top-level page + settings panel | `apps/web/src/lib/page-registry.tsx` + `apps/web/src/pages/settings/panels.extensions.tsx` | `EXTRA_PAGES` / `findSettingsPanel` |
| S9 | custom chat card for a tool output | `apps/web/src/components/tool-call/artifact-renderers.ts` | `ARTIFACT_RENDERERS` |
| S10 | Global-Agent page context (URL → PageContext) | `apps/web/src/lib/context-resolvers.ts` | `registerUrlContextResolver` |
| S11 | pipeline-step summary for a tool | *(fork startup code)* | `registerToolOutputSummarizer()` from `@greenhouse/agent-core` |

For runtime hooks (S3, S7, S11) call the `register*()` functions **once at startup**, before the first request — from `apps/api/src/index.ts`'s `main()` (server) or the web app's bootstrap.

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

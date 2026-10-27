# Greenhouse contributor rules

## Product and ownership

- Greenhouse is an internal Agent hub: governance core, official plugins and deployment-specific plugins.
- Core owns identity/permissions, conversations/Agents, models/budgets/gateway, tools/runs/audit, MCP/connectors, automations, Files, notifications/push, settings/branding, plugin host, administration and CLI.
- Knowledge, Tables, Skills, Feedback and Memory are default-on plugins; Projects, Reports, Email, Feishu, WeCom, Computer, Retro and Example are compiled but default-off.
- Retro depends on Knowledge; saved prompts, `/api/prompts` and `task_capture` remain core independently of SkillHub.
- Core consumes active registries and never imports plugins or branches on plugin ids.
- Public docs describe implemented behavior and contain no private company/customer information.

## Work discipline

- Read the nearest applicable AGENTS.md and reuse existing implementations before adding one.
- Prefer MCP graph tools for code discovery; use rg for literals/config/docs or insufficient/unavailable graph tools.
- Write a spec before non-trivial cross-cutting work in local-only `docs/specs/YYYYMMDD-<name>.md`, with status, decisions, acceptance criteria and index entry.
- Update README/AGENTS for behavior/convention changes and `apps/api/src/profiles/agent-profiles.md` for profile changes.
- Deletions cascade to orphan consumers, types, copy, routes, navigation, tests and docs.
- Register why an existing implementation cannot be extended before adding a parallel one; no speculative abstractions or unused columns.
- Declared capabilities must work; unsupported/unconfigured paths error explicitly.
- Use existing `@greenhouse/utils/*` helpers for date, JSON, concurrency, logger, crypto, ids, semver, HTML, errors and rich-output prompts.
- Use `nowIso`, `safeJsonParse`, `extractJson`, `runWithConcurrency`, `logger`, `encrypt/decrypt/parseHexKey`, `toErrorMessage`, `isUniqueViolation`, `randomDocId`, semver helpers, `escapeHtml` and `composeRichOutput` instead of copies.
- Cross-package imports use `@greenhouse/<package>`; intra-package Node ESM imports use relative paths plus `.js`.

## Repository map

- `apps/api/` is Hono governance/runtime/CLI; read [backend rules](apps/api/src/AGENTS.md).
- `apps/web/` is classic React/Vite; read [frontend rules](apps/web/src/AGENTS.md) and [settings rules](apps/web/src/pages/settings/AGENTS.md).
- `apps/mobile/` is isolated Expo for web/iOS/Android; read [universal client rules](apps/mobile/AGENTS.md).
- `apps/desktop/` is the Tauri macOS shell; read [desktop rules](apps/desktop/AGENTS.md).
- `packages/agent-core/` owns the model loop/factory; `packages/platform-kernel/` owns pure manifests/actors/authz/dispatch.
- `packages/db/` owns core schema/services/migrations (`packages/db/migrations/`); read [DB rules](packages/db/src/AGENTS.md) and [schema](packages/db/src/db-schema.md).
- `packages/types/`, `packages/utils/`, `packages/contract/` own shared protocols/helpers and typed API exports; contract's API dependency is type-only.
- `packages/crud/` owns shared list/form/detail and server CRUD; `packages/knowledge-editor/` owns editor schema/Markdown conversion.
- `packages/ui/` owns shared tokens/brand/plant avatars; `packages/ui-tokens/` owns generated themes/trusted embed bridge.
- `plugins/<id>/` owns manifest/API/web/schema/services/migrations/seeds/copy/tests; read its AGENTS.md.
- `skillhub/` holds skill-pack sources; read [pack format](skillhub/README.md).
- `scripts/` owns build/assembly/ops/gates; `tests/` owns shared test layers.

## Configuration and plugins

- `.env` owns infrastructure/secrets; DB Runtime Config owns live settings; `greenhouse.config.ts` owns structure; do not add a fourth layer.
- `plugins` selects compiled packages; `extensions.enabled` selects active ids; GREENHOUSE_PLUGINS overrides assembly and GREENHOUSE_EXTENSIONS overrides enablement.
- New plugins use `plugins/<id>/`; pure-data manifest id/SDK/version must agree with package metadata.
- Run `pnpm plugins:sync` after assembly inputs change; never edit or commit ignored `extensions/compiled.generated.ts` files.
- Rebuild for compilation changes and restart for enablement changes; Administration → Plugins is read-only.
- SDK 2 is current; SDK 1 packages/in-tree index lists remain accepted in 4.x; declare matching sdk/core ranges and preserve wire fields.
- Missing legacy compatibility declarations currently warn; mismatching declared SDK/core refuses activation.
- Package production imports use only host kits, shared types, CRUD, UI, ui-tokens, the Markdown conversion leaf, own files and declared plugin/third-party dependencies.
- Relative imports cannot escape a package; plugin dependencies require both dependsOn and package.json; tests may reach host hooks.
- Kit exports are snapshot-locked; removals/renames require the snapshot and an `extension-kit:` CHANGELOG entry.
- Add hooks only with a real registry consumer, Example coverage and seam tests; never add per-module core cases.
- Plugin copy belongs under `ext.<id>.*` in both languages; do not add plugin copy to core locales.
- Prefer dataSources for table-backed entities; REST/tools/runtime share capability, row-scope, field-policy, export and audit checks.
- Custom handlers use scoped services or enforce equivalent restrictions before paging/counting and external I/O.
- Writes reject unknown/immutable/forbidden fields atomically, even for super; ids/storage timestamps/internal/confidential/restricted fields are never caller input.
- Owner/member input requires explicit writable metadata and grants; creation validates then stamps effective ownership.
- Forms use member-specific writable metadata and PATCH only changed fields; refresh retains loaded rows/totals/paging.
- Writing tools declare surface.proxy=write; static/lazy tools implement create/createLazy; builtin metadata never grants permissions.
- Custom protected commands use runtime/recordWrite and notifications use notify; do not create a parallel permission/audit plane.
- Agent context is stable, capped and reach-filtered; resources/prompts recheck grants on each request.
- Observations carry ids/metadata, cannot veto, and have isolated five-second deadlines; use bounded I/O and tolerate retries.
- onInstall runs migration-locked after migrations; install/outbox consumers must be crash/retry idempotent.
- Scheduled work uses host job claims; register transport/identity/channel/retention/pricing/search/catalog/entity/discriminator contributions.
- Deprecated workbenchRecipes, surface.workbench and WidgetRecipe remain no-ops; do not use them for new work.
- Preserve official URLs/tool ids/MCP groups/legacy kinds; aliases belong to plugins and cannot replace core routes.
- Downstream changes stay in plugins/seam, packs, deploy, config and fork workflows; generic improvements go upstream.

## Clients, permissions and security

- clients.web selects classic (default) or universal at `/`; `/classic/` always exists and API/plugin paths never fall through to SPA HTML.
- `pnpm web:build` preserves public/app; `pnpm app:build` exports isolated Expo there without developer/desktop station overrides.
- Keep mobile outside the root workspace with its own lockfile; Docker installs/exports it in a separate stage.
- `/api/extensions` v2 is member-filtered and keeps v1 fields; server client API is 4, current universal minimum is 3.
- Surfaces use native/entity-list/entity-detail/settings-form/embed; SDK 1 React injection remains classic-only.
- Settings forms do not weaken super-only settings APIs; unknown pages use validated browser fallbacks.
- Regenerate shared themes with `pnpm tokens:build`; never hand-edit generated tokens.
- Embeds receive ten-minute member/plugin credentials from `/api/ext-ui/token`, scoped to the plugin API and basic GET /api/me.
- Validate bridge window/exact origin; never inject full login tokens, persist credentials or submit assistant drafts automatically.
- Same-origin installed plugin frames share code trust; user HTML previews remain opaque-origin and credential-free.
- Desktop CORS/framing trusts exactly tauri://localhost; plugin frames have no native capabilities and explicitly allowlist the parent hint.
- All business surfaces bind real active internal team/super accounts; reject anonymous/disabled/deleted/external/stale-generation identities.
- TOKEN_SIGNING_KEY is mandatory; stored secrets need PROVIDER_TOKEN_ENCRYPTION_KEY; secret settings are encrypted/write-only.
- Permissions only narrow from member to profile/grant/transport; runtime.dispatch is the protected-action boundary.
- MCP writes run as the member with evidence and delete preview/confirm; Agent API requires confirm on each write.
- Core feature flags are empty; plugins contribute flags through user_grants/feature points; UI hiding never replaces route checks.
- Settings resolve DB → env → unset; validate batch writes atomically and preserve masked secrets.
- Core models.yaml defines models; billableServices augments pricing; paid calls always use budget admission/metering.
- Active chat runs, presence and some provider caches remain process-local; keep multi-replica limitations explicit.

## Database and seeds

- Core history starts at immutable packages/db/migrations/0000_v4_baseline.sql (49 core tables); archive-3x is byte-frozen and only bridges 3.x databases.
- Persistent/shared databases use `pnpm db:migrate`, never push; always set the intended DATABASE_URL explicitly.
- Worktrees use isolated databases, never the owner's main DB; let run-dev arbitrate ports without killing unrelated processes.
- Schema changes require generated/reviewed SQL and relevant AGENTS/schema docs; never edit applied migration bytes.
- Plugin DDL uses its own checksummed lane/statement-breakpoints; do not create core tables or append plugin DDL to the core chain.
- Fresh installs create only core tables; each plugin's 0001 lane file creates its tables when enabled and adopts 3.x tables in place without DROP/move.
- Disablement retains data; explicit `cli plugins drop` previews/deletes only disabled owned tables/lane with RESTRICT.
- Core cannot acquire plugin FKs; historical discriminator reads survive disablement and writes validate active registries.
- `pnpm db:migrate` upgrades 3.x in place under its advisory lock (finish archive-3x, stamp the 4.0 baseline); it never drops data, plugin/overlay lane rows or drizzle.greenhouse_carry.
- A fresh 4.0 install with all official plugins must match a bridged 3.x database (schema-equivalence test); record intended differences there.
- 1.x/2.x/half-carried DBs refuse migration/boot: upgrade to 3.0.2 first, then to 4.0; boot also refuses an unbridged 3.x DB.
- `db baseline` adopts only DBs already on the 4.0 schema (dry run first); 3.x DBs go through `db:migrate`.
- Core seeds live in data/examples, plugin seeds in plugins; update dataset README/load order and load in dependency order.
- Seed refuses non-empty DBs without keep/reset; destructive reset needs explicit confirmation; fixtures contain no encrypted auth secrets.

## Verification and operations

- Run pnpm typecheck/pnpm lint after every change, pnpm test after functional changes and all task gates before handoff.
- pnpm test includes unit, transactional DB and committed-state DB; never trim the default suite.
- Units use forks/no PostgreSQL; DB tests roll back; committed-state tests need @db-commit-reason and isolated cleanup.
- Restore mocks/timers/env/registries and build fixtures with returned opaque ids, not fixed ids.
- Local DB tests require loopback TEST_DATABASE_URL with test/e2e in the name; use VITEST_UNIT_MAX_WORKERS/VITEST_DB_MAX_WORKERS.
- For plugin changes run strict overlay guard, plugins:sync --check and test:core; core assembly runs sequentially with other generators.
- HTTP security uses test:e2e:ci with migrated test DB/dead LLM; model-dependent cases honor E2E_NO_LLM.
- Classic/plugin browser tests use test:e2e:ui; universal uses test:e2e:client; package browser specs import only @playwright/test.
- Root checks skip isolated mobile type/lint; run both inside apps/mobile for mobile changes.
- Product captures use scripts/capture-screens.mjs against seeded real UI; never mock or hand-edit captures.
- Tour uses /classic and active plugin discovery; enable intended plugins before migration/seed; label old images until replaced.
- docs/index.html is bilingual: data-i18n keys need ZH entries; rebuild landing CSS after utility-class changes.
- Keep gitleaks allowlists narrow/commented and CI gates complete.
- One product version spans root/apps/packages/plugins/mobile/desktop via release-please extra-files; routine bumps/releases are automated.
- Candidate config uses prerelease strategy/rc; RELEASING.md documents operator publication and stable promotion.
- Tags define releases; APP_VERSION/APP_REVISION and OCI labels stamp images; /health does not expose the version.
- Stable tags publish exact/minor/latest, rc only exact rc, main only edge/main-sha.
- Use Conventional squash commits; do not hand-edit released CHANGELOG sections or versions outside an authorized cut.
- Local build authorization never implies push/tag/deploy/EAS publication or desktop signing/feed activation.
- Keep desktop bundle id/updater public key and mobile native identity unchanged.
- Keep Compose topologies aligned, migrate before startup, and use scripts/backup-db.sh with integrity/rotation checks.
- Upstream publishing workflows are repository-gated; forks use fork-*.yml.

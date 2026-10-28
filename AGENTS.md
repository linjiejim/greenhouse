# Greenhouse contributor rules

## Product and ownership

- Greenhouse is a self-hosted internal Agent hub: a governance core, official plugins and deployment-specific plugins.
- Core owns identity/permissions, conversations/Agents, models/budgets/gateway, tools/runs/audit, MCP/connectors, automations, saved prompts, Files, notifications/push, settings/branding, the plugin host, administration and CLI.
- Knowledge, Tables, Skills, Feedback and Memory are default-on plugins; Projects, Reports, Email, Feishu, WeCom, Computer, Retro and Example are compiled but default-off.
- Retro depends on Knowledge; saved prompts, `/api/prompts` and `task_capture` stay core without SkillHub.
- Core consumes active registries and never imports plugins or branches on plugin ids.
- There is one client, the universal client in `apps/client` (web, iOS, Android; `apps/desktop` wraps it); there is no second web app.
- Public docs describe implemented behavior and contain no private company/customer information.

## Work discipline

- Read the nearest AGENTS.md and reuse existing implementations before adding one.
- Prefer MCP graph tools for code discovery; use rg for literals/config/docs or when graph tools are insufficient.
- Write a spec before non-trivial cross-cutting work in local-only `docs/specs/YYYYMMDD-<name>.md` (status, decisions, acceptance criteria, index entry).
- Update README/AGENTS for behavior/convention changes and `apps/api/src/profiles/agent-profiles.md` for profile changes.
- Deletions cascade to orphan consumers, types, copy, routes, navigation, tests and docs.
- Record why an existing implementation cannot be extended before adding a parallel one; no speculative abstractions or unused columns.
- Declared capabilities must work; unsupported or unconfigured paths error explicitly.
- Use `@greenhouse/utils/*` helpers (`nowIso`, `safeJsonParse`, `extractJson`, `runWithConcurrency`, `logger`, `encrypt/decrypt/parseHexKey`, `toErrorMessage`, `isUniqueViolation`, `randomDocId`, semver, `escapeHtml`, `composeRichOutput`) instead of copies.
- Cross-package imports use `@greenhouse/<package>`; intra-package Node ESM imports use relative paths plus `.js`.

## Repository map

- `apps/api/` is the Hono governance API, runtime, plugin host (`src/plugin-host/`) and CLI; read [backend rules](apps/api/src/AGENTS.md).
- `apps/client/` is the isolated Expo universal client; read [client rules](apps/client/AGENTS.md) and [design rules](apps/client/DESIGN.md).
- `apps/desktop/` is the Tauri macOS shell around the client; read [desktop rules](apps/desktop/AGENTS.md).
- `packages/agent-core/` owns the model loop/factory; `packages/platform-kernel/` owns pure manifests/actors/authz/dispatch.
- `packages/db/` owns core schema/services/migrations (`packages/db/migrations/`); read [DB rules](packages/db/src/AGENTS.md) and [schema](packages/db/src/db-schema.md).
- `packages/types/` and `packages/utils/` own shared protocols and helpers; `packages/crud/` owns the list protocol and server CRUD (`@greenhouse/crud/server`).
- `packages/knowledge-editor/` owns the editor schema/Markdown conversion; `packages/ui/` owns token sources, brand and plant avatars; `packages/ui-tokens/` owns generated themes and the embed bridge.
- `plugins/<id>/` owns manifest, API half, schema/services, migrations, seeds and tests; read its AGENTS.md.
- `skillhub/` holds skill-pack sources ([pack format](skillhub/README.md)); `scripts/` owns build/assembly/ops/gates; `tests/` owns shared test layers.

## Configuration

- `.env` owns infrastructure/secrets; DB Runtime Config owns live settings; `greenhouse.config.ts` owns structure; do not add a fourth layer.
- `greenhouse.config.ts` has `plugins`, `extensions.enabled`, `packs`, `conversations.sharing` and `clients.stations`; `clients.web` is a boot error.
- `plugins` selects compiled packages; `extensions.enabled` selects active ids; GREENHOUSE_PLUGINS overrides assembly and GREENHOUSE_EXTENSIONS replaces (not appends to) enablement.
- Rebuild for compilation changes and restart for enablement changes; Administration → Plugins is read-only; credentials alone never enable a plugin.
- Settings resolve DB → env → unset; batch writes validate atomically and preserve masked secrets.

## Plugins

- New plugins are packages in `plugins/<id>/` with SDK 2: an api half (`api/index.ts`, `defineExtension`) and a pure-data `manifest.ts`; there is no web half.
- Manifest id/sdk/version must agree with package.json; declare `sdk: 2` and a `core` range that includes the running release; a missing or mismatching declaration refuses activation.
- Run `pnpm plugins:sync` after assembly inputs change; never edit or commit `apps/api/src/plugin-host/compiled.generated.ts`.
- Production imports use only `@greenhouse/api/extension-kit`, `@greenhouse/types/*`, `@greenhouse/crud`, `@greenhouse/ui-tokens`, `@greenhouse/knowledge-editor/markdown`, own files, Node builtins and declared dependencies (`scripts/lib/plugin-imports.mjs`).
- Relative imports cannot escape a package; plugin dependencies need both `dependsOn` and package.json; tests may reach host hooks; `pnpm lint` runs the boundary scanner.
- Kit exports are snapshot-locked (`apps/api/src/__tests__/extension-kit.snapshot.test.ts`); removals/renames update the snapshot and add an `extension-kit:` CHANGELOG entry.
- Add hooks only with a real registry consumer, Example coverage and seam tests; never add per-module core cases.
- Client UI comes from manifest `surfaces` (nav, pages: native, entity-list, entity-detail, settings-form, embed) and an optional static `ui/`; Admin sections use `parent: 'administration'`.
- Client-facing plugin copy is manifest `LocalizedText` (`{ en, zh }`); official native screens live in `apps/client/src/plugins/<id>/` and use the client catalogs.
- Prefer `dataSources` for table-backed entities; REST/tools/runtime share capability, row-scope, field-policy, export and audit checks.
- Custom handlers use scoped services or enforce equivalent restrictions before paging/counting and external I/O.
- Writes reject unknown/immutable/forbidden fields atomically, even for super; ids, storage timestamps and internal/confidential/restricted fields are never caller input.
- Owner/member input requires explicit writable metadata and grants; creation validates, then stamps effective ownership.
- Writing tools declare `surface.proxy: 'write'`; static/lazy tools implement `create`/`createLazy`; builtin metadata never grants permissions.
- Custom protected commands use kit `recordWrite` and notifications use `notify`; do not create a parallel permission/audit plane.
- Agent context is stable, capped and reach-filtered; resources/prompts recheck grants on each request.
- Observations carry ids/metadata, cannot veto and have isolated five-second deadlines; use bounded I/O and tolerate retries.
- `onInstall` runs migration-locked after migrations; install/outbox consumers must be crash/retry idempotent.
- Scheduled work uses host job claims (`runExtensionJob`); register transport/identity/channel/retention/pricing/search/catalog/entity/discriminator contributions.
- Preserve official URLs, tool ids, MCP groups, legacy entity kinds and `fallback_url` values; aliases belong to plugins and cannot replace core routes.
- Downstream changes stay in plugins, packs, deploy, config and fork workflows; generic improvements go upstream with an Example consumer.

## Clients, permissions and security

- The API serves the hosted client from `public/app` at `/`; `/classic` redirects to `/`; API, plugin and OAuth paths never fall through to SPA HTML.
- `pnpm app:build` exports the isolated Expo app into `public/app` without developer/desktop station overrides.
- Keep `apps/client` outside the root workspace with its own lockfile; Docker installs and exports it in a separate stage.
- `/api/extensions` v2 is member-filtered; server client API is 4, the client's minimum is 3.
- Server-made browser links use `@greenhouse/types/client-routes` with secrets in the fragment; old `#/…` links are mapped by `apps/client/src/shell/legacy-links.ts`.
- Settings forms never weaken super-only settings APIs; unknown pages use validated fallbacks.
- Regenerate shared themes with `pnpm tokens:build`; never hand-edit generated tokens.
- Embeds receive ten-minute member/plugin credentials from `/api/ext-ui/token`, scoped to the plugin API and basic `GET /api/me`.
- Validate bridge window and exact origin; never inject full login tokens, persist credentials or submit assistant drafts automatically.
- Same-origin installed plugin frames share code trust; user HTML previews stay opaque-origin and credential-free.
- Desktop CORS/framing trusts exactly `tauri://localhost`; plugin frames get no native capabilities and explicitly allowlist the parent hint.
- All business surfaces bind real active internal team/super accounts; reject anonymous/disabled/deleted/external/stale-generation identities.
- `TOKEN_SIGNING_KEY` is mandatory; stored secrets need `PROVIDER_TOKEN_ENCRYPTION_KEY`; secret settings are encrypted and write-only.
- Permissions only narrow from member to profile/grant/transport; `runtime.dispatch` is the protected-action boundary.
- MCP writes run as the member with evidence and delete preview/confirm; the Agent API requires `confirm` on each write.
- Core feature flags are empty; plugins contribute flags through feature points; UI hiding never replaces route checks.
- `models.yaml` defines models; `billableServices` augments pricing; paid calls always use budget admission and metering.
- Active chat runs, presence and some provider caches are process-local; keep multi-replica limits explicit.

## Database and seeds

- Core history starts at immutable `packages/db/migrations/0000_v4_baseline.sql` (49 core tables); `archive-3x` is byte-frozen and only bridges 3.x databases.
- Persistent/shared databases use `pnpm db:migrate`, never push; always set the intended `DATABASE_URL` explicitly.
- Worktrees use isolated databases, never the owner's main DB; let run-dev arbitrate ports without killing unrelated processes.
- Schema changes need generated, reviewed SQL and updated schema docs; never edit applied migration bytes.
- Plugin DDL uses its own checksummed lane with statement breakpoints; never create core tables or append plugin DDL to the core chain.
- Fresh installs create only core tables; each plugin's `0001_adopt.sql` creates its tables when enabled and adopts 3.x tables in place without DROP or copy.
- Disablement retains data; `pnpm cli plugins drop` previews, then deletes only disabled owned tables/lane with RESTRICT.
- Core cannot acquire plugin FKs; historical discriminator reads survive disablement and writes validate active registries.
- `pnpm db:migrate` upgrades 3.x in place under its advisory lock and never drops data, plugin/overlay lane rows or `drizzle.greenhouse_carry`; the API refuses an unbridged 3.x DB.
- A fresh 4.0 install with all official plugins must match a bridged 3.x database (`tests/db/schema-equivalence.db-commit.test.ts`); record intended differences there.
- 1.x/2.x/half-carried databases are refused: upgrade to 3.0.2 first, then to 4.0; `db baseline` adopts only DBs already on the 4.0 schema (dry run first).
- Core seeds live in `data/examples`, plugin seeds in `plugins/<id>/seeds`; load in dependency order and keep the dataset README current.
- Seed refuses non-empty DBs without keep/reset; destructive reset needs explicit confirmation; fixtures contain no encrypted auth secrets.

## Verification

- Run `pnpm typecheck` and `pnpm lint` after every change, `pnpm test` after functional changes and every task gate before handoff.
- `pnpm test` includes unit, transactional DB and committed-state DB layers; never trim the default suite.
- Units use forks and no PostgreSQL; DB tests roll back; committed-state tests need `@db-commit-reason` and isolated cleanup.
- Restore mocks/timers/env/registries and build fixtures with returned opaque ids, not fixed ids.
- DB tests need a loopback `TEST_DATABASE_URL` with test/e2e in the name; tune `VITEST_UNIT_MAX_WORKERS`/`VITEST_DB_MAX_WORKERS`.
- Plugin changes also run `pnpm plugins:sync --check` and `pnpm test:core` (zero packages, sequential with other generators).
- HTTP security uses `pnpm test:e2e:ci` against a migrated test DB and a dead LLM endpoint.
- Browser tests are `pnpm test:e2e:client` (`tests/client-e2e`, `playwright.client.config.ts`; ports and DB via `CLIENT_E2E_*`); specs import only `@playwright/test`.
- Root checks skip the isolated client's types and lint: run `pnpm typecheck` and `pnpm lint` inside `apps/client` for client changes.
- `docs/index.html` is bilingual: `data-i18n` keys need ZH entries; run `scripts/build-landing.sh` after utility-class changes.
- Never mock or hand-edit product screenshots.
- Keep gitleaks allowlists narrow/commented and CI gates complete.

## Releases and operations

- One product version spans root/apps/packages/plugins/client/desktop via release-please extra-files; routine bumps and releases are automated.
- Candidate config uses the prerelease strategy (rc); [RELEASING.md](RELEASING.md) documents operator publication and stable promotion.
- Tags define releases; `APP_VERSION`/`APP_REVISION` and OCI labels stamp images; `/health` does not expose the version.
- Stable tags publish exact/minor/latest, rc only the exact rc, main only edge/main-sha.
- Use Conventional squash commits; do not hand-edit released CHANGELOG sections or versions outside an authorized cut.
- Local build authorization never implies push/tag/deploy/EAS publication or desktop signing/feed activation.
- Keep the desktop bundle id/updater public key and the native app identity unchanged.
- Keep Compose topologies aligned, migrate before startup, and back up with `scripts/backup-db.sh` (integrity/rotation checks).
- Upstream publishing workflows are repository-gated; forks use `fork-*.yml` and `node scripts/check-extension-overlay.mjs --base upstream/main --strict`.

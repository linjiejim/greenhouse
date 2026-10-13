# Greenhouse agent rules

Greenhouse is an open-source, self-hosted platform where a team works with its own AI Agents on shared knowledge, tables and apps. It serves one internal team: every login and integration acts as a real internal account. There is no guest or anonymous access.

## Truth and v2
- This is the v2 branch: a top-down rewrite with no backward compatibility. v1 lives on main and is the reference to port from (`git show main:<path>`).
- Product truth is docs/product/: prd.md (scope, objects, glossary in §5), features.md (one row per feature: ID, v2 decision, status), providers.md, api.md, data-model.md, migration-v1.md, roadmap.md (slice order and gates).
- A new feature starts as a features.md row naming its object and why nothing existing can be reused. The change that ships or deletes it updates that row's status.
- Copy, docs and code use only the glossary: agent, admin, member, conversation, run, request. Never reintroduce bot, super or team.
- Design truth is docs/design-system/. Tokens have one source, packages/ui/src/tokens/haven.ts; run `pnpm tokens:build` after editing it.
- apps/design is the prototype on mock data only (apps/design/AGENTS.md). Artboards and the prototype never prove a feature shipped.
- Specs for non-trivial cross-cutting work go in docs/specs/YYYYMMDD-name.md. That directory is gitignored, so committed files never link to it.

## Repo map
- apps/api: the v2 API (Hono). app.ts composes services and routes; modules/<domain>/ holds routes.ts, service.ts and later tools.ts.
- packages/contract: zod schemas and types for every request and response; the web, mobile and extension clients import it.
- packages/db: the v2 schema (data-model.md), ids, migrations and test support. drizzle/ holds the single baseline.
- apps/design: prototype and component lab. apps/desktop: Tauri shell (apps/desktop/AGENTS.md). apps/bot-computer: the Agent computer image.
- apps/mobile: v1 Expo app outside the pnpm workspace and the root checks until roadmap M4 (apps/mobile/AGENTS.md).
- packages/agent-core: agent loop and stream collectors. packages/knowledge-editor: Tiptap schema and Markdown conversion.
- packages/types: plant avatars, rich-output blocks, entity links, deployment config shape. packages/ui: tokens, brand mark, plant avatars, component kit. packages/utils: shared helpers.

## Commands
- `pnpm typecheck`, `pnpm lint` (`pnpm lint:fix`) and `pnpm test` must pass before every commit.
- `pnpm test` runs the unit and db projects. db tests need TEST_DATABASE_URL pointing at a loopback database whose name contains test; it is wiped and migrated once per run.
- `pnpm api` starts the API (port 3000). Give it its own DATABASE_URL; it refuses a v1 database. Required env: TOKEN_SIGNING_KEY and PROVIDER_TOKEN_ENCRYPTION_KEY (64 hex each, `openssl rand -hex 32`).
- BOOTSTRAP_ADMIN_EMAIL creates the first admin once and logs a one-time activation link. MIGRATE_ON_START=1 applies migrations at boot.
- Schema change: edit packages/db/src/schema/*, then `pnpm db:baseline` to regenerate drizzle/0000_v2_baseline.sql (one baseline until v2.0) and recreate local dev databases.
- drizzle.config.ts has no default URL, so drizzle-kit never reaches a shared database by accident.
- `pnpm design:dev` (127.0.0.1:4518), `pnpm design:build` and `pnpm test:design-ui` for the prototype.
- Commits run husky and lint-staged (eslint --fix, prettier --write on staged files).

## Code rules
- Delete instead of deprecating; after a deletion, delete whatever lost its last consumer. Never add compatibility placeholders.
- Reuse before adding; no speculative abstraction without a second real consumer.
- Declared capabilities must be real: tool descriptions, UI options and docs never claim what the code cannot do.
- One source of truth per concept; extend the existing registry or schema instead of a parallel list.
- Only apps/api/src/config reads process.env; everything else receives values from it.
- Routes parse input with the contract's zod schemas (readJson, readQuery) and call a service. Services own queries, transactions and permission checks; routes and Agent tools call the same service.
- Fail with ApiError (http/errors.ts): every error leaves as `{ error: { code, message, details? } }` with a stable snake_case code.
- JSON is snake_case and maps from rows through view functions in the service; never return a database row.
- Lists use cursor pagination (http/pagination.ts): fetch limit + 1 rows ordered by id, return `{ items, next_cursor }`.
- Ids come from newId(kind) in @greenhouse/db: a type prefix plus a ULID.
- Check packages/utils/src/ before writing a helper. Server code logs through @greenhouse/utils/logger, never console.
- Import other packages by name. Relative imports end in .js in Node-run code and omit it in Vite-bundled code.
- Sync docs in the same change: README.md for humans, the nearest AGENTS.md for rules, features.md for status, data-model.md for the schema.

## Auth and permissions
- Roles are admin and member. Public endpoints are /health, /api/bootstrap and /api/auth/*; everything else under /api requires a member, and /api/admin/* an admin.
- requireMember re-reads role, status and auth_version on every request: disabling a member or changing a password ends their sessions at once.
- Refresh tokens are single use; replaying a used one revokes all of that member's sessions. One-time links and refresh tokens are stored only as keyed hashes.
- The first-admin bootstrap never promotes or revives an existing account and does nothing once an admin exists.
- Keep at least one active admin; a member cannot disable themselves.
- Enforce access in services, never only in the UI. Writes record the acting member.

## Database
- Tables use text ids, timestamptz read as ISO strings, and jsonb that is never null unless null means something.
- Owned children cascade; logs, audit, usage, notifications and run history keep logical references only.
- Use getDb() inside services and getDb().transaction for multi-statement writes; a transaction satisfies the same Db type.
- Tests run in a per-test transaction. A statement expected to fail must run in a savepoint (getDb().transaction), or it aborts the test transaction.

## Brand and avatars
- Brand geometry has one source, packages/ui/src/assets/greenhouse-mark.svg; regenerate icons with `python3 scripts/build-brand-assets.py`.
- Agent avatars come from one SVG builder in packages/ui/src/components/plant-avatar/; check changes with `node --import tsx scripts/plant-avatar-gallery.mjs`.
- docs/index.html is the GitHub Pages site; run scripts/build-landing.sh after changing its Tailwind classes.

## Release and deploy
- Releases are cut from main only (RELEASING.md); the v2 branch publishes nothing until it merges back at v2.0.
- Every commit that lands on main is a Conventional Commit; release-please derives the version and changelog from them.
- Workflows that publish or deploy run only in linjiejim/greenhouse.

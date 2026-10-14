# Greenhouse agent rules

Greenhouse is an open-source, self-hosted platform where a team works with its own AI Agents on shared knowledge, tables and apps. It serves one internal team: every login and integration acts as a real internal account. There is no guest or anonymous access.

## Truth and v2
- This is the v2 branch: a top-down rewrite with no backward compatibility. v1 lives on main and is the reference to port from (`git show main:<path>`).
- Product truth is docs/product/: prd.md (scope, objects, glossary in §5), features.md (one row per feature: ID, v2 decision, status), always-on.md (wake-ups, approval tiers, background work, reliability and cost), providers.md, api.md, data-model.md, migration-v1.md, roadmap.md (slice order and gates).
- A new feature starts as a features.md row naming its object and why nothing existing can be reused. The change that ships or deletes it updates that row's status.
- Copy, docs and code use only the glossary: agent, admin, member, conversation, run, request. Never reintroduce bot, super or team.
- Design truth is docs/design-system/. Tokens have one source, packages/ui/src/tokens/haven.ts; run `pnpm tokens:build` after editing it.
- apps/design is the prototype on mock data only (apps/design/AGENTS.md). Artboards and the prototype never prove a feature shipped.
- Specs for non-trivial cross-cutting work go in docs/specs/YYYYMMDD-name.md. That directory is gitignored, so committed files never link to it.

## Repo map
- apps/api: the v2 API (Hono). app.ts composes services and routes; modules/<domain>/ holds routes.ts and service.ts; engine/ runs turns and tools (engine/AGENTS.md); realtime/ is the WebSocket hub.
- packages/contract: zod schemas and types for every request and response; web and extension import it, while mobile vendors its subset with parity tests.
- packages/db: the v2 schema (data-model.md), ids, migrations and test support. drizzle/ holds the single baseline.
- packages/providers: adapters per capability (llm, search, stt, tts, image, storage, sandbox: docker and e2b, mail: resend and mailgun; smtp is registered from apps/api/src/modules/mail), presets, the adapter registry and pinnedFetch (an instance's origins; `https://*.<domain>` allows every name under a domain, as E2B serves each sandbox under its own). apps/api/src/providers: env parsing, resolution order, sealed secrets, usage metering and the provider routes (docs/product/providers.md).
- apps/web: the v2 web app (Vite, React 19, TanStack Query; apps/web/AGENTS.md). The API serves its build from public/.
- apps/design: prototype and component lab. apps/desktop: Tauri shell (apps/desktop/AGENTS.md). apps/bot-computer: the Agent computer image (e2b/ is its hosted layer for the E2B template: the two bridges, their units, boot and hardening).
- apps/mobile: API v2 Expo app outside the pnpm workspace and root type/lint checks; native checks run separately (apps/mobile/AGENTS.md).
- packages/agent-core: agent loop and stream collectors. packages/knowledge-editor: Tiptap schema, Markdown conversion and the browser editor (editor.ts: `/` blocks, `[[` doc links, `@` mentions, pictures; the app draws the menus).
- packages/types: plant avatars, rich-output blocks, entity links, deployment config shape. packages/utils: shared helpers.
- packages/ui: tokens, brand mark, plant avatars and the component kit (src/kit, imported as @greenhouse/ui/kit with @greenhouse/ui/kit/kit.css; docs/design-system/components.md). The kit's CSS uses tokens only and its words come from src/kit/strings.ts in zh and en.

## Commands
- `pnpm typecheck`, `pnpm lint` (`pnpm lint:fix`) and `pnpm test` must pass before every commit.
- `pnpm test` runs the unit, db and db-commit projects. db tests need TEST_DATABASE_URL pointing at a loopback database whose name contains test; it is wiped and migrated once per run.
- db tests run inside one rolled-back transaction each. Races between processes need real commits: write them as `*.db-commit.test.ts`, which run on a real pool, one file at a time (their engines share the job and run queues), and clean up after themselves.
- `pnpm api` starts the API (port 3000). Give it its own DATABASE_URL; it refuses a v1 database. Required env: TOKEN_SIGNING_KEY and PROVIDER_TOKEN_ENCRYPTION_KEY (64 hex each, `openssl rand -hex 32`); VAULT_ENCRYPTION_KEY (the same form) turns the password vault on.
- BOOTSTRAP_ADMIN_EMAIL creates the first admin once and logs a one-time activation link. MIGRATE_ON_START=1 applies migrations at boot.
- Schema change: edit packages/db/src/schema/*, then `pnpm db:baseline` to regenerate drizzle/0000_v2_baseline.sql (one baseline until v2.0) and recreate local dev databases.
- drizzle.config.ts has no default URL, so drizzle-kit never reaches a shared database by accident.
- `pnpm web:dev` (proxies /api to GREENHOUSE_API, default 127.0.0.1:3000), `pnpm web:build` and `pnpm test:web-e2e` (a real API and database with a fake model; apps/web/AGENTS.md).
- `pnpm design:dev` (127.0.0.1:4518), `pnpm design:build` and `pnpm test:design-ui` for the prototype.
- Commits run husky and lint-staged (eslint --fix, prettier --write on staged files).

## Code rules
- Delete instead of deprecating; after a deletion, delete whatever lost its last consumer. Never add compatibility placeholders.
- Reuse before adding; no speculative abstraction without a second real consumer.
- Declared capabilities must be real: tool descriptions, UI options and docs never claim what the code cannot do.
- One source of truth per concept; extend the existing registry or schema instead of a parallel list.
- Only apps/api/src/config reads process.env; everything else receives values from it.
- External services come only from services.providers (resolve, languageModel). Never build a vendor SDK client or handle a vendor key anywhere else; the client it returns records usage and can only reach its configured address.
- The one other way out is connectors, the MCP servers an admin installs: only modules/connectors reaches them, through its guarded fetch (https, public addresses in production, deadlines). Its built-in mailbox connector reaches a member's own IMAP and SMTP servers the same way: resolved and checked first (never a private network; loopback only outside production), connected to the checked address.
- Routes parse input with the contract's zod schemas (readJson, readQuery) and call a service. Services own queries, transactions and permission checks; routes and Agent tools call the same service.
- Fail with ApiError (http/errors.ts): every error leaves as `{ error: { code, message, details? } }` with a stable snake_case code.
- JSON is snake_case and maps from rows through view functions in the service; never return a database row.
- Lists use cursor pagination (http/pagination.ts): fetch limit + 1 rows ordered by id, return `{ items, next_cursor }`.
- Ids come from newId(kind) in @greenhouse/db: a type prefix plus a ULID.
- Check packages/utils/src/ before writing a helper. Server code logs through @greenhouse/utils/logger, never console.
- Import other packages by name. Relative imports end in .js in Node-run code and omit it in Vite-bundled code.
- Sync docs in the same change: README.md for humans, the nearest AGENTS.md for rules, features.md for status, data-model.md for the schema.
- Background work goes through the one `jobs` queue (apps/api/src/jobs.ts): enqueue in the transaction that causes it, claim with a lease, settle only as the lease holder.
- Notifications leave the server only as the delivery jobs `notifications.publish` queues; modules/channels sends them through providers: email through the mail capability (its order, with fallback) and push. Feishu and WeCom keep their code but stay out of the UI until the IM channels. Without the member's previews they name no subject, and never carry the body of a needs-you card or a reply.
- Mail (modules/mail): system mail and every Agent's mailbox go through the `mail` capability. A vendor's notice at the public `/api/mail/inbound/:instance` is verified first and is only a signal: the mail is fetched from the vendor with the instance's key. Received mail is untrusted input: stored once, its HTML and attachments as files, and it wakes an Agent only from a sender it may hear from whose From domain the receiving server verified.

## Auth and permissions
- Roles are admin and member. Public endpoints are /health, /api/bootstrap and /api/auth/*; everything else under /api requires a member, and /api/admin/* an admin.
- External access (modules/oauth, modules/mcp): /.well-known/*, /oauth/* and /api/mcp are public routes with their own credentials. /api/mcp accepts only OAuth access tokens and personal access tokens, never the app's tokens, and every tool calls the same service as the HTTP route, as that member. The OAuth endpoints answer errors as RFC 6749 `{ error, error_description }`, not the API envelope.
- OAuth codes, access, refresh and personal tokens and client secrets are stored only as keyed hashes and carry the member's auth_version. A spent code or refresh token presented again revokes every token of its grant. A grant keeps the scopes exactly as approved, and a token never reaches beyond its grant and its client's cap.
- A machine client an admin binds to another member acts as them only after that member approves it, so an admin can never read a member's data through a client.
- File bytes are read only through signed URLs (`GET /api/files/:id/content?exp=&m=&sig=`), because an `<img>` or a link cannot send a bearer header. A URL is minted per request for one member, ends within one to two hours, and serving it checks again that the member is active and may read the file. Only the workspace logo gets a URL that names no member.
- requireMember re-reads role, status and auth_version on every request: disabling a member or changing a password ends their sessions at once.
- Refresh tokens are single use; replaying a used one revokes all of that member's sessions. One-time links and refresh tokens are stored only as keyed hashes.
- The first-admin bootstrap never promotes or revives an existing account and does nothing once an admin exists.
- Keep at least one active admin; a member cannot disable themselves.
- Enforce access in services, never only in the UI. Writes record the acting member.
- Admin changes to members, groups, branding, providers, budgets, public Agents and team skill reviews call audit() (apps/api/src/audit.ts) in the same transaction, and so does publishing an Agent. Summaries name fields, never values or secrets.

## Database
- Tables use text ids, timestamptz read as ISO strings, and jsonb that is never null unless null means something.
- Owned children cascade; logs, audit, usage, notifications and run history keep logical references only.
- Use getDb() inside services and transaction(fn) from @greenhouse/db for multi-statement writes. Inside fn, getDb() returns the transaction, so services called from it join it.
- Tests run in a per-test transaction. A statement expected to fail must run in transaction(fn) (a savepoint), or it aborts the test transaction.

## Brand and avatars
- Brand geometry has one source, packages/ui/src/assets/greenhouse-mark.svg; regenerate icons with `python3 scripts/build-brand-assets.py`.
- Agent avatars come from one SVG builder in packages/ui/src/components/plant-avatar/; check changes with `node --import tsx scripts/plant-avatar-gallery.mjs`.
- docs/index.html is the GitHub Pages site; run scripts/build-landing.sh after changing its Tailwind classes.

## Release and deploy
- Releases are cut from main only (RELEASING.md); the v2 branch publishes nothing until it merges back at v2.0.
- Every commit that lands on main is a Conventional Commit; release-please derives the version and changelog from them.
- Workflows that publish or deploy run only in linjiejim/greenhouse.

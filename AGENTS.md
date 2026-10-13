# Greenhouse agent rules

Greenhouse is an open-source, self-hosted platform where a team works with its own AI Agents on shared knowledge, tables and apps.
It serves one internal team: every login and integration (web, chat, MCP, CLI) acts as a real internal account. There is no guest or anonymous access.

## Truth and v2
- Product truth is docs/product/: prd.md (scope, objects, glossary in §5), features.md (one row per feature: ID, v2 decision, status), providers.md, api.md, data-model.md, migration-v1.md, roadmap.md.
- v2 is a top-down rewrite with no backward compatibility: a fresh database baseline, bot→agent, super/team→admin/member, and every features.md row marked 删除 removed outright.
- Deleted in v2: Missions, Workflows, the workbench, Eval, Frictions, Feature Requests, the LLM relay and AI gateway, /api/agent, session tags, folders, sharing and ratings, per-member feature switches.
- Until v2 lands, v1 code keeps working under its current rules. Fix v1 bugs, but never extend a module whose features.md row says 删除 or 合并.
- Branches, slice order and per-slice gates: docs/product/roadmap.md.
- A new feature starts as a features.md row naming its object and why nothing existing can be reused. The PR that ships or deletes it updates that row's status.
- Copy, docs and new v2 code use only the glossary. v1 code keeps its identifiers (bot, super, team) until the one-time v2 rename; never rename them piecemeal.
- Design truth is docs/design-system/, the v2 target. v1 screens keep their module rules until rewritten; do not mix v2 tokens or patterns into them.
- Tokens have one source, packages/ui/src/tokens/haven.ts. Run `pnpm tokens:build` after editing it; a unit test fails on a stale haven.css or a failing contrast pair.
- apps/design is the v2 prototype on mock data only (rules in apps/design/AGENTS.md). Artboards and the prototype never prove a feature shipped.
- Specs for non-trivial cross-cutting work go in docs/specs/YYYYMMDD-name.md. That directory is gitignored, so committed files never link to it.

## Repo map
- apps/api: Hono API, agent runtime, scheduler and CLI; serves the built SPA. Rules: apps/api/src/AGENTS.md, apps/api/src/bots/AGENTS.md.
- apps/web: v1 React SPA, rewritten in v2 (roadmap M1 to M3). Rules: apps/web/src/AGENTS.md.
- apps/design: v2 interactive prototype and component lab; no backend. Rules: apps/design/AGENTS.md.
- apps/mobile: Expo app outside the pnpm workspace (own lockfile, `pnpm mobile:install`). Rules: apps/mobile/AGENTS.md.
- apps/desktop: Tauri shell around apps/web. Rules: apps/desktop/AGENTS.md.
- apps/browser: MV3 browser extension. Rules: apps/browser/src/AGENTS.md.
- apps/agent-runner: Mission sandbox runner (deleted in v2), built into an image only; server code never imports it.
- apps/bot-computer: Agent computer image (desktop, Chromium, shell); image only.
- packages/db: Drizzle schema and domain services. Rules: packages/db/src/AGENTS.md.
- packages/agent-core: agent loop, model factory and provider quirks.
- packages/platform-kernel: manifests, actor context and authorization; no DB, Hono or React.
- packages/types: shared types and registries.
- packages/utils: shared helpers.
- packages/ui: shared presentational React kit and the v2 tokens; no stores or router.
- packages/crud: low-code CRUD (defineCrud, CrudPage).
- packages/knowledge-editor: Tiptap schema and Markdown conversion; Markdown is canonical.
- packages/contract: typed API client. It imports only types from @greenhouse/api, because a value import starts the server.
- drizzle/ core migrations, data/examples/ demo dataset, tests/ cross-app suites, scripts/ dev, CI and ops scripts.
- skillhub/ skill pack format (skillhub/README.md), connectors/ official MCP connector catalog, .claude/skills/ recipes for common changes.

## Commands
- Run `pnpm typecheck` and `pnpm lint` after every change (`pnpm lint:fix` fixes) and `pnpm test` after functional changes. All must pass.
- `pnpm dev` serves the web on :3100 with HMR and proxies /api to the API on :3000 (WEB_PORT, API_PORT override). The API does not hot-reload: restart it after server edits.
- `pnpm run-dev up|stop|status` runs Postgres, API and web with logs in .run-dev/logs/ and moves ports by +10 on conflict. Never kill processes by port.
- In a git worktree, start the stack with `pnpm run-dev up`: it uses its own database `greenhouse_wt_<slug>`, while the .env copied from the main tree still points at the main one.
- `DATABASE_URL=<url> npx drizzle-kit migrate` from the repo root. Never run it bare: drizzle.config.ts falls back to the main local database, which a worktree must never touch.
- `pnpm drizzle-kit generate` from the repo root after schema edits; see packages/db/src/AGENTS.md.
- `pnpm seed` loads data/examples/ into an empty database (`--reset` or `--keep` otherwise).
- `pnpm cli <command>` is the admin console; `pnpm admin:create` creates an administrator.
- `pnpm design:dev` (127.0.0.1:4518), `pnpm design:build` and `pnpm test:design-ui` for the prototype.
- `pnpm web:build` writes the SPA to public/, which the API serves in production.
- Commits run husky and lint-staged (eslint --fix, prettier --write on staged files).
- Local accounts: super@greenhouse.local (super) and team@greenhouse.local (team), password greenhouse, created by run-dev; extra ones are `<purpose>@greenhouse.local`.
- Those accounts are local fixtures: never seed them from migrations, compose files, the image or a release.
- Production's first admin comes only from BOOTSTRAP_ADMIN_EMAIL (one-time link in the log) or `pnpm admin:create`.

## Code rules
- Delete instead of deprecating: removing a feature removes its nav, routes, tools, i18n keys, tests, seeds, docs and screenshots in the same change.
- After a deletion, grep the dependents and delete whatever lost its last consumer.
- Never bring back removed tables, columns, routes or flags as compatibility placeholders.
- Reuse before adding: extend the existing implementation instead of writing a second one. A parallel implementation needs its reason recorded in the owning AGENTS.md.
- No speculative abstraction: no interface layers, multi-backend seams or future columns without a second real consumer.
- Declared capabilities must be real. Tool descriptions, UI options and docs never claim what the code cannot do; unconfigured paths fail explicitly.
- One source of truth per concept: extend the existing registry (WORKSPACE_SETTINGS, RICH_BLOCKS, CORE_TOOL_MODULES, nav-registry, models.yaml, @greenhouse/utils/prompts), never a parallel list.
- Check packages/utils/src/ before writing a helper (nowIso, safeJsonParse, escapeHtml, encrypt and decrypt, runWithConcurrency and more).
- Detect unique-key conflicts with isUniqueViolation from @greenhouse/utils/error; drizzle nests the PostgreSQL code in err.cause.
- Server code logs through logger from @greenhouse/utils/logger, never console; CLI output is the exception.
- Import other packages by name (`@greenhouse/<pkg>/<subpath>`). Relative imports end in .js in Node-run code (apps/api, packages other than ui) and omit it in Vite-bundled code (apps/web, apps/browser, packages/ui).
- User-visible copy goes through the client's i18n catalogs, with the same keys in English and Chinese.
- Sync docs in the same change: README.md for humans, the nearest AGENTS.md for rules, docs/product/features.md for feature status, packages/db/src/db-schema.md for the schema.

## Auth and permissions
- v1 roles are super > team. The retired external role is disabled and its tokens are rejected.
- TOKEN_SIGNING_KEY (64 hex chars) is required in every environment; the API refuses to start without it. Stored secrets also need PROVIDER_TOKEN_ENCRYPTION_KEY.
- Enforce access on the server. Hiding UI is not access control.
- Permissions are declared once (tool surface and is_global, feature points, manifest capabilities). HTTP, chat and MCP adapt the protocol and never decide again.
- External agents reach Greenhouse through /api/mcp (OAuth 2.1) as their bound member and can only narrow that member's permissions.
- Every route requires auth except PUBLIC_PATHS in apps/api/src/auth/middleware.ts; keep that list minimal. The whole /api/mcp prefix skips central auth, so never mount another route under it.
- Writes record the acting user's id. Secrets are write-only: no read API returns them.
- Route guards, tool exposure, MCP scopes and the platform kernel: apps/api/src/AGENTS.md.

## Configuration and extensions
- Three config layers, never a fourth: greenhouse.config.ts for structure (extensions, packs, client stations), .env for secrets and infrastructure, workspace settings in the database for live product knobs.
- Workspace settings are declared in WORKSPACE_SETTINGS and written only through validateWorkspaceValue. A save overlays process.env in that API process only; other processes need a restart.
- Models are declared only in apps/api/src/config/models.yaml, which names env vars and never holds keys.
- Extensions live in `apps/api/src/extensions/<id>/` and `apps/web/src/extensions/<id>/`, each listed once in its extensions/index.ts; GREENHOUSE_EXTENSIONS overrides the enabled list. Contract and recipes: EXTENDING.md.
- Core never references an extension by id. A missing hook goes into the contract and its registry, with the example extension and both seam tests updated.
- Extension tables use the extension's own `migrations/*.sql` lane, never drizzle/. Applied files are checksummed: add a new file instead of editing one.
- Extension copy lives under `ext.<id>.*`; core i18n catalogs stay untouched.
- The example extension is the reference and the test fixture; keep it exercising every contract field.
- Forks keep private modules under the extension seam and content under packs/. scripts/check-extension-overlay.mjs must pass against upstream/main; generic changes go upstream first.
- clients.stations is compiled into the browser extension; the mobile app mirrors it with EXPO_PUBLIC_STATIONS_MODE and EXPO_PUBLIC_API_BASE_URL.

## Testing
- `pnpm test` runs the unit, db and db-commit Vitest projects; never trim real tests from it.
- unit: `*.test.ts(x)`, no PostgreSQL. db: `*.db.test.ts`, each test in a rolled-back transaction. db-commit: `*.db-commit.test.ts`, serial, file header @db-commit-reason.
- Quick loops: `pnpm test:unit` and `pnpm test:db`. VITEST_MAX_WORKERS caps the shared fork pool.
- Tests live in `tests/<area>/` or next to the code (`__tests__/`, `*.test.ts`); tests/api/test-classification.test.ts enforces the naming.
- DB tests need a migrated database at TEST_DATABASE_URL (default greenhouse_test on localhost). A parallel worktree uses its own `greenhouse_test_<slug>`. How to write them: packages/db/src/AGENTS.md.
- Restore mocks, fake timers, process.env, singletons and registries inside each file. Never depend on file order or another file's leftovers.
- `pnpm test:e2e:ci` boots the real API against a migrated test database and a dead LLM endpoint. tests/e2e asserts boundaries (auth, isolation, escalation, injection), never model output.
- `pnpm test:e2e:ui` runs Playwright on tests/e2e-ui and `apps/*/src/extensions/<id>/e2e/*.e2e.ts` against `pnpm dev` with GREENHOUSE_EXTENSIONS=example.
- Playwright specs locate by data-testid or role, prefix their writes per run and clean them up. Extension e2e specs import only @playwright/test.
- CI (.github/workflows/ci.yml) runs lint, typecheck, test, e2e, e2e-ui and gitleaks on main and every PR, building each database with migrate.
- The Bots browser suites drive Chromium (`pnpm exec playwright install --with-deps --only-shell chromium`). Under CI they fail without it unless BOTS_BROWSER_TESTS=skip.
- Never commit real credentials. A confirmed gitleaks false positive gets a narrow, commented entry in .gitleaks.toml.
- After visible UI changes, re-run `node scripts/capture-screens.mjs` against a seeded dev stack (needs ffmpeg and cwebp). Never hand-edit or mock docs/assets/screens/.
- docs/evals/agent-scenarios.md and agent-scenarios.yaml are one hand-run bank: change both together. Every fact must match data/examples/ and every assumed tool capability must be real.

## Brand, avatars, landing page, demo data
- Brand geometry has one source, packages/ui/src/assets/greenhouse-mark.svg. Regenerate every icon with `python3 scripts/build-brand-assets.py` (see logos/README.md); render the mark with GreenhouseMark (web: AppLogo).
- Agent avatars come from one SVG builder in packages/ui/src/components/plant-avatar/. After changes, render `node --import tsx scripts/plant-avatar-gallery.mjs` and look at it.
- After silhouette edits, rerun the gallery with --fit and refresh the golden digests with `vitest -u`.
- Stored avatar JSON is never rewritten (Agent versions are hashed). Writers use the `with*` helpers and plantAvatarConfig from @greenhouse/types/plant-avatar.
- docs/index.html is the GitHub Pages site. Run scripts/build-landing.sh after changing its Tailwind classes and commit docs/tailwind.css; every data-i18n key needs an entry in the inline ZH dictionary.
- data/examples/ is the demo dataset loaded by apps/api/src/cli/commands/seed.ts. When a seeded table or column changes, update its JSON file, data/examples/README.md and LOAD_ORDER (FK-safe order). It never holds real secrets.

## Release and deploy
- Runbook: RELEASING.md. A tag vX.Y.Z is the release. release-please bumps the root package.json version (the web build reads it) and the mobile app versions; never hand-edit those or released CHANGELOG.md sections.
- Every commit that lands on main is a Conventional Commit, because release-please derives the bump and changelog from them. The default merge is squash (one commit per PR).
- A PR with the `parked` label has an accepted direction but is not ready: keep it rebased (renumber its migrations to the next free slot) instead of merging or closing it.
- Stable tags publish ghcr.io/linjiejim/greenhouse `:X.Y.Z`, `:X.Y` and `:latest`; main publishes only `:edge` and `:main-<sha>`. Images are linux/amd64 and linux/arm64.
- Workflows that publish or deploy run only in linjiejim/greenhouse. A fork adds its own `.github/workflows/fork-*.yml`.
- Mobile ships through .github/workflows/mobile.yml: JS-only changes as OTA updates, native changes as store builds. The browser zip comes from `pnpm browser:package`.
- The image is Debian-based (isolated-vm needs glibc) and bakes in NODE_ENV=production; keep both.
- docker-compose.yml (built from source) and docker-compose.ghcr.yml (published image, used by the installer) keep the same services.
- docs/install.sh stays bash 3.2 compatible and shellcheck-clean, reads prompts from /dev/tty, takes the compose file and .env.example from the image, and keeps working with older .env files.
- MIGRATE_ON_START=1 applies the core migration chain at boot for hosts without a migrate job.
- Deployments back up with scripts/backup-db.sh from cron, never an ad-hoc pg_dump pipe; it verifies every dump and rotates only its own files.

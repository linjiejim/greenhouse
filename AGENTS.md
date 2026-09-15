# Greenhouse — agent & contributor guide

## Project intro

Greenhouse is an open-source, AI-native enterprise agent workbench. The AI agent is the core
of the product, not an add-on: chat, the knowledge base, projects, tables, automations,
missions, workflows and email all share one tool layer and one permission model. The same
tools members use in chat are exposed to external agents over the `/api/agent` proxy and the
`/api/mcp` MCP server.

The product serves an internal team only: members use the `team` role, admins the `super`
role. Web, `/api/chat`, MCP and the LLM relay all bind to a real internal account — there is
no anonymous / guest login and no public customer-facing agent. (Historical `external` rows
only survive for data compatibility: the migration disables them and auth rejects their
tokens.)

> **MCP server** `/api/mcp` lets any external agent (Claude / Cursor / …) reach internal
> resources over the standard MCP protocol with OAuth 2.1. Tokens are scoped by action and
> resource group, and the proxy can only narrow the bound user's permissions — it is a
> restricted subset, not a separate plane. See `apps/api/src/AGENTS.md`.

## Rules

- Run `pnpm test` after functional changes (all three layers — see Testing).
- Run `pnpm typecheck` and `pnpm lint` after every change — both must pass.
- Update docs when API or behavior changes (`README.md` for humans; the `AGENTS.md` files for
  agents/conventions).
- Feature-level design docs live in `docs/specs/` (`YYYYMMDD-<kebab-name>.md`, indexed in
  `docs/specs/README.md`; the directory is local-only / gitignored). Write the spec before
  building non-trivial cross-cutting features; update its status as work lands.
- Don't reinvent helpers — check `packages/utils/` before writing one.
- Update `apps/api/src/profiles/agent-profiles.md` when agent profiles change.
- Update this file when project structure, conventions, or domain rules change.
- DB schema changes require a migration script and an update to
  [packages/db/src/AGENTS.md](./packages/db/src/AGENTS.md). The source of truth is `migrate`:
  edit schema → `drizzle-kit generate` → review SQL → commit → CI/deploy applies `migrate`.
  **Persistent / shared DBs: `migrate` only, never `push`** (`push` is for throwaway local DBs).

### Delete & reuse discipline (anti-entropy)

The main entropy source in fast generative development is "only add, never delete; reimplement
what exists." These rules are as binding as the "add" rules:

- **Deletes must sync docs.** When you remove a module / page / endpoint / table, update or
  delete every doc that references it (README, AGENTS.md, example comments).
- **Deletes must cascade orphan-check.** After removing X, grep its dependents (components,
  helpers, types, i18n keys, nav entries) and remove anything that just lost its last consumer.
- **Check for an existing implementation first.** Before adding a "second" retrieval / chart /
  editor / etc., register in the relevant AGENTS.md why the existing one can't be reused or
  extended. Parallel implementations without a recorded reason are not accepted.
  - Registered: **the Mission sandbox runner loop uses a third-party harness (Pi) instead of
    extending `@greenhouse/agent-core`** — chat-engine is turn-based (string messages,
    `maxSteps ≤ 30`, 15-minute total timeout, no checkpoint/resume), incompatible with
    "run for tens of minutes, survive a container swap". Pi only enters the sandbox image,
    never the server's dependencies; replaceability is guaranteed by the runner boundary
    (the control plane only speaks our own event protocol).
  - Registered: **the Home workbench does not reuse the `table_dashboard_widgets` storage** —
    that table is Base-scoped with a single-table data source; the workbench is user-scoped
    and spans every tool. It reuses the *components and query semantics* (`ChartBlock`,
    `TableQuery` filter AST, "one card = one persisted query") and stores its config in
    `platform_user_workbench_preferences` (zero migrations). Conversely the drag grid
    `components/workbench/widget-grid.tsx` is shared by Home and Tables dashboards — the
    recorded reason for `react-grid-layout`.
  - Registered: **mermaid in chat uses the third-party `mermaid` instead of extending the
    workflow SVG DAG** — the DAG is an interactive run-time visualization (node selection,
    status colouring, inspector, ≤ 15 nodes); chat mermaid is read-only rendering of arbitrary
    diagram types. Lazy-loaded on the first mermaid fence; zero main-bundle cost.
  - Registered: **workbench evaluation has one implementation** (`apps/api/src/workbench/evaluate.ts`)
    shared by the batch evaluate endpoint and the `workbench_*` tools, so "what the model
    previews" and "what the user refreshes" are the same thing. The bindable set is derived
    from tool metadata (`surface.workbench: true` → `WORKBENCH_READ_TOOL_IDS`), deliberately
    narrower than the read proxy.
- **No speculative abstraction.** Don't write interface layers / multi-backend abstractions /
  "for future use" columns with no second consumer.
- **Declared capabilities must be real.** LLM tool descriptions, UI options, and docs must not
  claim unimplemented capabilities. Unconfigured / unimplemented paths must error explicitly,
  not pretend.

## Code quality

- **Pre-commit hook**: husky + lint-staged runs `eslint --fix` + `prettier --write` on staged
  files.
- **CI gate**: `.github/workflows/ci.yml` runs lint → typecheck → test → **e2e** → **e2e-ui** →
  **secret-scan** on `main` and every PR (shared pnpm/Node setup lives in `.github/actions/setup`).
  The test/e2e/e2e-ui jobs build the CI database via `migrate` (not push) so the whole migration
  chain is exercised on every run.
- **Secret scanning**: the `secret-scan` job runs [gitleaks](https://github.com/gitleaks/gitleaks)
  over incoming commits. Rules + allowlist live in `.gitleaks.toml`. Never commit real
  credentials; if the scanner flags a **confirmed** non-secret (a token alphabet, a test JWT
  fixture, a documented demo password under `data/examples/` or `tests/`), add a narrow,
  commented entry — keep the allowlist surgical so it can't mask a real leak.
- **E2E security suite**: `pnpm test:e2e:ci` (`scripts/e2e-ci.sh`) boots the real API against
  a migrated database and a dead LLM endpoint (`E2E_NO_LLM=1` skips content-dependent
  assertions) and runs `tests/e2e` over HTTP: auth/token round-trips, cross-user isolation,
  role escalation, injection, tool surfaces, OAuth machine clients. Deterministic and free.
  When adding a test that needs a real model reply, gate it with
  `describe.skipIf(process.env.E2E_NO_LLM === '1')`.
- **Browser e2e (Playwright)**: `pnpm test:e2e:ui` — deterministic UI regression suite in
  `tests/e2e-ui/` (Chromium): login, chat (LLM stubbed via `page.route`), project create, user
  create/delete, the extension seam, and **`extension-surfaces.spec.ts`**, which reads every hash
  the active extensions registered (`window.__greenhouseExtensionSurfaces`) and opens each one —
  the check for failures only a browser sees (unresolvable module ids, pages that throw on
  render). Extensions ship their own specs as `apps/web/src/extensions/<id>/e2e/*.e2e.ts`
  (the `extensions` Playwright project; import only `@playwright/test`). `playwright.config.ts`
  auto-starts `pnpm dev` with `GREENHOUSE_EXTENSIONS=example` (reuses a running one);
  `auth.setup.ts` creates a super test account via `admin:create` and logs in. Locators use
  `data-testid` anchors + `role=dialog`. Writes use a per-run prefix and self-clean. CI runs the
  whole suite in the `e2e-ui` job (Chromium via `playwright install --with-deps`).
- **Screenshot tour (visual smoke)**: `node scripts/capture-screens.mjs` drives a running,
  seeded dev stack (`E2E_BASE_URL`, default `:4400`) through every surface with Playwright:
  it seeds a demo Tables base / workbench layout / skills / custom agent / MCP machine client
  over the API, asks the live model two questions, and writes `docs/assets/screens/*.webp`
  (+ `chat-knowledge.gif` / `.mp4`) that the README and `docs/index.html` embed. It exits
  non-zero on any console error or failed `/api` request. Re-run it after visible UI changes
  so the docs stay truthful — never hand-edit or mock the captures. Needs `ffmpeg` + `cwebp`.
- **Landing page**: `docs/index.html` is the GitHub Pages site (precompiled Tailwind — run
  `scripts/build-landing.sh` after changing utility classes and commit `docs/tailwind.css`).
  Copy is bilingual: every `data-i18n` key needs a matching entry in the inline `ZH`
  dictionary; the English source of truth is the markup itself.
- **Dev mode**: `pnpm dev` runs the Vite dev server (web, `:3100`, HMR) + the API (`:3000`)
  in parallel. Vite proxies `/api` (incl. ws), `/public`, `/health` to the API, so the browser
  sees same-origin — open `:3100`. Ports are overridable via `WEB_PORT` / `API_PORT` (read from
  the repo-root `.env`; shell vars take precedence). Production is `pnpm web:build` (Vite →
  repo-root `public/`, `base:'./'`), served directly by the API.
- **Acceptance environment**: `pnpm run-dev up` (`scripts/run-dev.mjs`) starts Postgres + API
  + web together, shifts ports by +10 on conflict, writes every log under `.run-dev/logs/`,
  and `stop` tears it all down. **A git worktree automatically gets its own database
  `greenhouse_wt_<dir>`** (cloned from the local `greenhouse` DB as a template, then
  migrated) — never run migrations against the main DB from a worktree, and let the engine
  arbitrate port conflicts instead of hand-killing processes.

## Deploy (one-command Docker)

`docker-compose.yml` is the supported self-host path: Postgres + a one-shot `migrate` job + the
API (which serves the SPA) as a single self-contained image (`Dockerfile`, Debian base — the
`compute` tool's isolated-vm native addon needs glibc; `NODE_ENV=production` is baked in so the
fail-closed auth guard is always active).

```bash
cp .env.example .env && ./scripts/gen-secrets.sh   # fills required secrets
#   edit .env: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
docker compose up -d --build
docker compose exec api pnpm admin:create          # first super-admin
#   app at http://localhost:3000
```

For local dev you can start only Postgres from the same file: `docker compose up -d postgres`
(bound to `127.0.0.1:5432`, not internet-exposed).

`docker-compose.ghcr.yml` is the same stack consuming the **published GHCR image**
instead of building from source — the pull-based upgrade path for self-hosters. Keep the two
compose files' service topology in sync.

Missions additionally need the sandbox runner image (`bash scripts/build-agent-runtime.sh` →
`greenhouse/agent-runtime`), Docker with gVisor (`runsc`), and the hardened bridge network
(`scripts/cloud-agent-net.sh`); they stay disabled until `MISSION_ENABLED=1` and every
preflight passes.

### Example dataset (`pnpm seed`)

`data/examples/` holds a de-identified reference dataset (fictional company "Greenhouse") —
one JSONL file per table, imported by `apps/api/src/cli/commands/seed.ts` (`pnpm seed`). It
exists to explore/validate a fresh install. **On a non-empty DB `pnpm seed` refuses** and
prints the choices: `--reset` (wipes all rows first — gated behind typing the DB name, or
`--yes`) or `--keep` (load on top). When you add/rename a table or change a column that the
dataset populates, update the matching `data/examples/<table>.json` and its
[`README.md`](data/examples/README.md), and add the table to `LOAD_ORDER` (FK-safe order).
Custom agents load through `db.customProfiles.create()` so they get their immutable draft v1.
Auth secrets are never baked in: `users.json` carries a plaintext `password` hashed at load;
`api_clients` / `email_accounts` (instance-secret-encrypted) are not seeded.

## Releasing & versioning

Full runbook: **[RELEASING.md](./RELEASING.md)**. The conventions an agent must not break:

- **One product, one version.** `git tag vX.Y.Z` is the release **source of truth**;
  the **root `package.json` `version`** mirrors it and is bumped automatically by
  release-please (`release-type: node`) in the Release PR — **don't hand-edit it**.
  The per-workspace `package.json` `version` fields are placeholders (not maintained).
- **Version comes from the tag at build time.** CI injects `APP_VERSION` (tag) +
  `APP_REVISION` (commit sha) → env; read them via `@greenhouse/utils/version`
  (`getVersionInfo()`), surfaced at `GET /health`. Don't read `package.json.version` for the
  runtime version.
- **Conventional Commits drive the bump.** PRs are **squash-merged** → one Conventional Commit
  per PR. `release-please` reads them, opens a Release PR, and on merge tags + creates the
  GitHub Release. **`CHANGELOG.md` is release-please-managed — don't hand-edit released
  sections.**
- **Parked PRs (`parked` label).** A PR whose direction is accepted but which is not strong
  enough to merge yet gets the `parked` label instead of being merged half-baked or closed.
  Keep it rebased (watch **migration numbers** — renumber to the next free slot on revive).
- **Stable vs. edge is a hard promise.** Tag → `ghcr.io/<owner>/greenhouse:X.Y.Z` `:X.Y`
  `:latest` (stable). `main` → `:edge` / `:main-<sha>` only. `release.yml` enforces this.
- **Publishing workflows are repository-gated.** `release.yml` / `release-please.yml` /
  `mobile.yml` / `deploy.yml` / `uptime.yml` only run in `linjiejim/greenhouse`; a fork's CD goes
  in `.github/workflows/fork-*.yml`.
- **Uptime.** `.github/workflows/uptime.yml` probes `/health` on the integration instance every
  ten minutes plus any URLs in the `UPTIME_EXTRA_URLS` secret (comma-separated; logged by index so
  a private hostname never prints). A failed run is the alert (GitHub mails the owner; set
  `FEISHU_WEBHOOK` to post into a group as well).
- **Backups are verified or they do not exist.** `scripts/backup-db.sh` checks gzip integrity, a
  size floor and pg_dump's completion marker, deletes a failed dump, and rotates only files it
  named itself (`<prefix>_YYYYmmdd_HHMMSS.sql.gz`, newest 7 + 8 Sundays). Every deployment's cron
  runs this script (`PG_CONTAINER` / `PG_DB` / `PG_USER` / `BACKUP_PREFIX`), never an ad-hoc
  `pg_dump | gzip` line — that is how an instance once shipped 20-byte dumps for two months.
- **Mission egress on a blue/green host.** `scripts/cloud-agent-net.sh` takes `API_PORT=3109,3110`
  so both API slots stay reachable from the sandbox network while everything else private stays
  rejected. `--check` demands every listed port and tolerates extra allow rows for other ports on
  the same gateways (the API checks with its own port; the host applied both), but nothing
  broader may precede the deny block. Keep the host's watchdog/oneshot units on the same script.
- **Artifacts.** API+web = the container image (primary). Browser = versioned zip
  (`pnpm -F @greenhouse/browser package`). Mobile = fingerprint CD
  (`.github/workflows/mobile.yml`, `EXPO_TOKEN`-gated): JS-only change → EAS OTA update;
  native change → EAS build `--auto-submit`. The mobile `version` follows the product version
  (release-please `extra-files`).

## Project structure (pnpm monorepo)

```
greenhouse/
├── apps/
│   ├── api/              # Hono backend — routes, agent runtime, auth, security, scheduler, CLI
│   │   └── src/
│   │       ├── routes/       # HTTP routes (one file per resource)
│   │       ├── chat/         # chat turn pipeline: turn, runtime, persist, runs, vision, eval, ambient context
│   │       ├── knowledge/    # knowledge base domain: access, search, folders, sections, export, notify, backfill
│   │       ├── sessions/     # session access rules + creation
│   │       ├── drive/        # drive access + upload policy
│   │       ├── auth/         # token, middleware, password, api-key, crypto, features, public paths
│   │       ├── security/     # headers / CORS / rate limit, network egress policy, account lockout, request ip
│   │       ├── extensions/   # the extension seam: define + index (compiled list) + boot glue + example/
│   │       ├── settings/     # workspace-config: DB→env resolution, env overlay, validation
│   │       ├── config/       # models.yaml + catalog loader (the model registry)
│   │       ├── tools/        # agent tools, each declared with defineTool
│   │       ├── agent-runtime/# tool proxy, MCP auth, lazy tool resolution, run-agent
│   │       ├── platform/     # platform kernel host: manifests, applications, feature points,
│   │       │                 #   bootstrap, OAuth server
│   │       ├── llm/          # completion / title / memory / relay / usage budgets / media provider
│   │       ├── profiles/     # agent profile loader + access rules, the YAML presets, agent-profiles.md
│   │       ├── scheduler/    # cron scheduler + executor (automations)
│   │       ├── runtime/      # unified runtime kernel: runs, steps, interrupts, outbox, read models
│   │       ├── workflow-engine/ # multi-agent task-graph engine
│   │       ├── cloud-agent/  # Missions control plane (queue, sandbox runner lifecycle)
│   │       ├── trusted-execution/ # deployment kill switches for the runtime layers
│   │       ├── notifications/# notification center + durable delivery
│   │       ├── email/        # IMAP/SMTP client, shared mailbox, security
│   │       ├── wecom/ feishu/# optional IM integrations (binding, push, sign-in, bot)
│   │       ├── skills/       # Skill Center — bundle validation, store, publish/download, scanner
│   │       ├── storage/      # upload storage (local disk / COS) + s3-lite (SigV4 client)
│   │       ├── workbench/    # workbench card evaluation (shared by API + tools)
│   │       └── cli/          # `pnpm cli` console: index.ts dispatcher + commands/*
│   ├── web/              # React SPA — pages (administration/, settings/, executions/, …), components,
│   │                     #   lib, stores, platform catalog, extensions/ (web half of the seam)
│   ├── agent-runner/     # Mission sandbox runner (@greenhouse/sandbox-runner); image only,
│   │                     #   the API never imports it
│   ├── browser/          # Chrome extension (MV3) — side panel + options; see its src/AGENTS.md
│   └── mobile/           # Expo (React Native) app — NOT a workspace member; see its AGENTS.md
├── packages/
│   ├── agent-core/       # Agent kernel — streamText loop, model factory/registry, provider quirks
│   ├── platform-kernel/  # Manifest v2, ActorContext, authorization, guarded registry (no DB/Hono/React)
│   ├── types/            # shared types (FEATURE_FLAGS, WORKSPACE_SETTINGS, entity links, workbench…)
│   ├── utils/            # shared helpers (date, json, concurrency, logger, crypto, semver, webhooks)
│   ├── db/               # database layer — Drizzle schema + domain services (types inferred)
│   ├── knowledge-editor/ # Tiptap schema + server Markdown↔Tiptap JSON
│   ├── crud/             # low-code CRUD framework (defineCrud + CrudPage / createCrudRoutes)
│   ├── ui/               # shared presentational UI kit (React) — used by the browser extension
│   └── contract/         # typed API contract — re-exports apps/api's AppType + hc (web client)
├── skillhub/             # first-party skill packs (synced into the Skill Center on boot)
├── drizzle/              # migration files (single source of truth for the schema)
├── scripts/              # gen-secrets, backup-db, run-dev, e2e-ci, build-agent-runtime, …
├── tests/                # unit / db / e2e (API, HTTP) / e2e-ui (Playwright)
├── pnpm-workspace.yaml
└── tsconfig.base.json    # shared TypeScript base config
```

### Workspace package names

| Package | Path | Purpose |
|---|---|---|
| `@greenhouse/agent-core` | `packages/agent-core/` | Agent kernel — chat-engine, model registry/factory, DSML interceptor |
| `@greenhouse/platform-kernel` | `packages/platform-kernel/` | Manifest v2, actor context, authz, registry (`contract` / `dsl` / `authz` / `registry` subpaths) |
| `@greenhouse/types` | `packages/types/` | Shared type definitions and registries (feature flags, workspace settings, entity links, workbench recipes) |
| `@greenhouse/utils` | `packages/utils/` | Shared helpers |
| `@greenhouse/db` | `packages/db/` | Database layer |
| `@greenhouse/knowledge-editor` | `packages/knowledge-editor/` | KB editor: Tiptap schema + Markdown↔Tiptap JSON. Markdown is canonical; `content_json='{}'` is legal |
| `@greenhouse/crud` | `packages/crud/` | Low-code CRUD — `defineCrud` + `CrudPage` client, `createCrudRoutes` server, shared wire protocol |
| `@greenhouse/ui` | `packages/ui/` | Shared UI kit (React, presentational only — no stores/router) |
| `@greenhouse/contract` | `packages/contract/` | Typed API contract (AppType + hc; **type-only import of `@greenhouse/api`**) |
| `@greenhouse/api` | `apps/api/` | Backend app |
| `@greenhouse/web` | `apps/web/` | Frontend app |
| `@greenhouse/sandbox-runner` | `apps/agent-runner/` | Mission sandbox runner — built into the `greenhouse/agent-runtime` image; server code must not import it |
| `@greenhouse/browser` | `apps/browser/` | Chrome extension (MV3) — consumes `@greenhouse/ui` |
| `@greenhouse/mobile` | `apps/mobile/` | Expo mobile app — **not** a workspace member (own lockfile, `pnpm mobile:install`); vendors its types |

### Import conventions

- Cross-package imports use the `@greenhouse/xxx` package name, not relative paths.
- Intra-package imports use relative paths + the `.js` extension (Node ESM).
- e.g. `import { nowIso } from '@greenhouse/utils/date'`
- e.g. `import type { DatabaseProvider } from '@greenhouse/db'`

## Extensions & deployment configuration

- **`greenhouse.config.ts`** (repo root, typed by `@greenhouse/types/config`, validated by
  `config-schema.ts` at boot via `apps/api/src/config/greenhouse-config.ts`) holds *structure*:
  `extensions.enabled`, `packs.{skills,profiles,seeds}`, `clients.stations`. Secrets stay in
  `.env`; live product knobs stay in Runtime Config (DB). Do not add a fourth layer, and do not
  move env-only infrastructure into the file. `GREENHOUSE_EXTENSIONS` overrides the enabled list.
- **Extension seam**: `apps/api/src/extensions/<id>/` + `apps/web/src/extensions/<id>/`, each
  exporting `defineExtension` / `defineWebExtension`, listed once in the two `extensions/index.ts`
  files. Every core registry aggregates from the *active* set (`EXTENSIONS` / the
  `/api/extensions` store). Rules:
  - Core never references an extension by id. If a module needs a hook the contract lacks, add
    the hook to the contract + registry (and the example + seam test), never a `case 'crm'`.
  - Contract fields map 1:1 onto existing registries — no new abstraction without a registry
    behind it. The full list is in EXTENDING.md → "Extensions". Registries opened for extensions
    so far: tools (incl. a generic lazy path), routes, platform apps, feature flags/points,
    workspace settings, public paths, scheduler jobs, CLI commands, db services + a migration
    lane, entity kinds (deeplink + peek), search sources, MCP consent groups, workbench recipes,
    web pages/navigation/modules/i18n/tool cards/knowledge-doc panels/agent context.
  - Still closed: notification transports and workbench pinning of extension records.
  - Extension tables use the migration lane (`migrations/*.sql`, `--> statement-breakpoint`);
    never append extension DDL to `drizzle/`. Applied files are checksummed — add a new file
    instead of editing one.
  - Extension copy lives under `ext.<id>.*` (`registerExtensionMessages`); core `en.ts`/`zh.ts`
    stay untouched. `visible-copy.test.ts` still scans extension TSX.
  - The `example` extension is the reference and the test fixture: keep it exercising every
    field; `apps/api/src/extensions/__tests__/seam.test.ts` and
    `apps/web/src/extensions/__tests__/seam.test.ts` load it with `GREENHOUSE_EXTENSIONS=example`;
    the Playwright stack runs with the example on, sweeps every surface it registers and runs
    its own `e2e/notes.e2e.ts`.
  - Legacy hashes belong to the extension that replaced them: `pages[].aliases`
    (`{ wiki: 'content/pages' }`) redirects `#/wiki/<tail>` into the page, tail and query intact.
    `app.tsx` carries no per-module redirects any more; a core route can never be aliased.
  - Extension tools must be buildable: `defineExtension` rejects a `static` tool without
    `create()` and a `lazy` tool without `createLazy()` (core has no per-tool case for extension
    tools, so such a tool reaches the catalog but is never handed to the agent).
  - Forks: private modules only under the seam, content under `packs/`; `scripts/check-extension-overlay.mjs`
    must pass against `upstream/main`. Anything generic goes upstream first.
  - **Adopting an existing database** (an instance moving onto this codebase): `pnpm cli db baseline`
    records the core chain (drizzle's own journal, identical hashes) and every enabled extension's
    migrations as applied without executing them. Always `--dry-run` first and compare against
    `drizzle-kit generate` output. `--through` stops short of the end of a chain
    (`--through 0006_x,crm/0001_baseline.sql`), so a migration written specifically to finish
    the adoption still runs instead of being recorded away.
  - A database no server has booted against (a fresh test database) gets the core chain from
    `drizzle-kit migrate` and the extension lane from
    `DATABASE_URL=… pnpm tsx scripts/apply-ext-migrations.mjs`.
- **Client stations**: `clients.stations` (`multi` | `single` + `defaults`) is read by the browser
  extension at build time; the mobile app mirrors it through `EXPO_PUBLIC_STATIONS_MODE` /
  `EXPO_PUBLIC_API_BASE_URL` (see `apps/mobile/AGENTS.md`).

## Domain rules

Detailed rules live next to the code:

| Domain | File | Scope |
|---|---|---|
| Database | [packages/db/src/AGENTS.md](./packages/db/src/AGENTS.md) | Service pattern, PostgreSQL, Drizzle, migrations, test isolation |
| Backend API | [apps/api/src/AGENTS.md](./apps/api/src/AGENTS.md) | Routes, auth, security, tool system, proxy/MCP, runtime, missions, integrations |
| Frontend | [apps/web/src/AGENTS.md](./apps/web/src/AGENTS.md) | Design system, components, styling, i18n, platform navigation |
| Settings pages | [apps/web/src/pages/settings/AGENTS.md](./apps/web/src/pages/settings/AGENTS.md) | Settings / Administration modules, CRUD page conventions |
| Browser extension | [apps/browser/src/AGENTS.md](./apps/browser/src/AGENTS.md) | MV3 lifecycle, stations, token refresh |
| Mobile | [apps/mobile/AGENTS.md](./apps/mobile/AGENTS.md) | Expo app — workspace isolation, vendored types, theme/i18n rules |
| Agent profiles | [apps/api/src/profiles/agent-profiles.md](./apps/api/src/profiles/agent-profiles.md) | Profiles, model switching, tool scoping |
| LLM / Agent kernel | `packages/agent-core/` + `apps/api/src/llm/` | Kernel (model factory/registry, chat-engine) in the package; completion/title/memory/relay/budget consumers in api |
| Skill packs | [skillhub/README.md](./skillhub/README.md) | Pack layout, skills vs. MCP tools, publishing |

## Shared helpers (`packages/utils/`)

Always import these — don't reimplement:

| Function | Module | Purpose |
|---|---|---|
| `nowIso()` | `@greenhouse/utils/date` | ISO 8601 timestamp for all DB writes |
| `safeJsonParse(str, fallback)` | `@greenhouse/utils/json` | Safely parse DB JSON columns |
| `extractJson(raw)` | `@greenhouse/utils/json` | Extract JSON from LLM output |
| `runWithConcurrency(tasks, n)` | `@greenhouse/utils/concurrency` | Parallel tasks with a concurrency cap |
| `logger` | `@greenhouse/utils/logger` | Structured logging (info/warn/error) |
| `encrypt` / `decrypt` / `parseHexKey` | `@greenhouse/utils/crypto` | AES-256-GCM + 64-char hex key validation |
| `toErrorMessage(err)` | `@greenhouse/utils/error` | Normalize an unknown error to a readable string |
| `isUniqueViolation(err)` | `@greenhouse/utils/error` | PG unique-key conflict (23505) — drizzle nests the code in `err.cause`, don't hand-check |
| `randomDocId(prefix?)` | `@greenhouse/utils/id` | Random opaque doc id; ids are system-assigned, never title-derived |
| `parseSemver` / `isValidSemver` / `compareSemver` / `bumpPatch` | `@greenhouse/utils/semver` | Strict `X.Y.Z` semver helpers (skill versions) — don't hand-write the regex |
| `escapeHtml(value)` | `@greenhouse/utils/html` | Escape text into hand-built HTML (emails) |
| `sendWeComMarkdown` / `sendFeishuMarkdown` | `@greenhouse/utils/wecom` / `feishu` | Group-bot webhook posts (both check the JSON body, not just the HTTP status) |
| `composeRichOutput({confirm?})` | `@greenhouse/utils/prompts` | The single copy of the rich-output prompt guide shared by every profile |

## Auth & permissions

- Roles: `super` > `team` (the retired `external` role is disabled on migration and rejected
  by auth).
- Auth module: `apps/api/src/auth/` (token, middleware, password, api-key, crypto, features).
- Route guards: `requireSuper()`, `requireInternal()` (team + super), `requireRole(...)`,
  `requireFeature(key)` (per-user flag).
- Middleware injects `AuthUser` via `c.set('user', ...)` / `getAuthUser(c)`.
- All writes should include `user_id` in audit fields.
- **Fail-closed startup**: `TOKEN_SIGNING_KEY` (64 hex chars) is mandatory in every
  environment — the service refuses to start without it, and there is no `NODE_ENV` escape
  hatch. Stored secrets additionally need `PROVIDER_TOKEN_ENCRYPTION_KEY`.
- **Public paths** (`PUBLIC_PATHS` in `auth/middleware.ts`): login, `/api/bootstrap`
  (branding only), OAuth discovery/callbacks, `/api/upload/:id` image reads. Keep the list
  minimal; a guard test pins it.

### Feature flags (per-user toggles)

Fine-grained gating beyond roles: open a module/feature to specific internal users, toggled
per-user by a super in Settings → Users → (user) → Permissions.

- **Registry (single source)**: `FEATURE_FLAGS` in `packages/types/src/features.ts`
  (`{ key, label, description, defaultEnabled? }`). Today: `memory`, `tables`, `cloud-agent`
  (all `defaultEnabled: true` = opt-out).
- **Storage**: `user_features` table (`user_id × feature`, `enabled` boolean).
- **Resolution** (`resolveUserFeatures` in `apps/api/src/auth/features.ts`): `super → all on`;
  explicit row → `row.enabled`; no row → `flag.defaultEnabled`.
- **Frontend**: `/api/auth/me` returns resolved `user.features`; UI gates with
  `canUseFeature(currentUser, key)` (`apps/web/src/lib/features.ts`).

Adding an experimental feature (three steps): add the `FEATURE_FLAGS` entry; guard the backend
(`app.use('/api/<x>/*', requireFeature('<key>'))` — UI hiding ≠ access control); wrap the
tab/route/nav in `canUseFeature`.

### Feature points and the unified permissions dialog

`FEATURE_POINTS` (`apps/api/src/platform/feature-points.ts`) is the server-side registry that
maps the three mechanisms onto "what a user can do": `app` points (Knowledge / Projects /
Tables, tied to a manifest and a capability prefix), `flag` points (Missions / Memory) and
`toolset` points (the remaining `is_global:false` opt-in tools). Each point declares the tool
ids it owns, so one switch controls app + REST + MCP + chat (`resolveUserTools` merges
flag-owned tools from this map — flag-owned tools cannot be assigned directly).
`GET /api/admin/users/:id/access` aggregates flags, capabilities, entity policies and tools
into one read-only view; writes still go through the existing fine-grained endpoints. The
dialog (`apps/web/src/pages/administration/user-permissions-modal.tsx`) renders from that view.

### Platform kernel v2

- `@greenhouse/platform-kernel` is the base for applications: Manifest v2, ActorContext,
  capability / entity / field authorization and a guarded registry. The API host
  (`apps/api/src/platform/`) persists organizations, roles, bindings, user allow/deny,
  entity policies, app releases, workbench preferences and action audit in `db.platform`;
  OAuth state lives in `db.platformOAuth`.
- Precedence is fixed: **user deny > user allow > role allow > default deny**; roles never
  store denies. Capabilities are `<app>.<module>.<action>` with exact, `*` and trailing
  wildcard matching.
- Manifests must be JSON-serializable — no handlers, DB clients, components or closures;
  handlers are registered separately and must match actions one-to-one.
- ⚠️ **Any change to a manifest's serialized form must bump its `version`** (even a key
  reorder). `publishAppRelease` compares the hash per `<app>@<version>` at boot and throws on
  mismatch — the API won't start on an already-deployed database. The golden-hash test in
  `apps/api/src/platform/__tests__/manifest-hash.test.ts` guards this: when it goes red, bump
  the version and update the hash in the same commit.
- `runtime.dispatch()` is the only entry for protected actions: capability → record/field
  policy → handler → audit. HTTP, chat tools, the agent proxy and MCP only adapt protocol.
- Projects, Knowledge and Tables are registered applications. New applications start from
  `pnpm cli platform create-app <id> --title "..."`; an app without a web UI may stay
  Agent/MCP-only. The web catalog and the fixed shell navigation
  (`Chat → Knowledge → Projects → Tables → More`) derive from the user's authorized catalog;
  durable execution tracking lives in the execution center (`#/executions`).

### Workspace settings (DB-backed, admin-editable deployment config)

Runtime credentials (LLM / media / search) and branding (product name, logo, theme tokens)
are configurable from the admin UI without code or restart.

- **Registry (single source)**: `WORKSPACE_SETTINGS` in `packages/types/src/workspace-settings.ts`
  (`key`, `group`, `type`, `secret?`, `env?`). Adding a setting is one registry entry.
- **Storage**: `workspace_settings` table; secrets AES-256-GCM encrypted via
  `PROVIDER_TOKEN_ENCRYPTION_KEY` and never returned by the read API.
- **Resolution** (`apps/api/src/settings/workspace-config.ts`): DB row → env var → unset.
  Entries with an `env` mapping are overlaid onto `process.env` at startup and after every
  write, and the model catalog is reloaded — single-process assumption; multi-node needs a
  restart.
- **Pre-login branding**: `GET /api/bootstrap` (public) serves product name / logo / theme
  tokens; the web applies it before first paint (`apps/web/src/lib/workspace-branding.ts`).
- **Admin API**: `GET/PUT /api/admin/settings` (super), batch all-or-nothing validation in
  `validateWorkspaceValue` — never bypass it when adding write paths.

### Model catalog

`apps/api/src/config/models.yaml` is the single definition of every model (chat picker and
the `/api/llm` relay read the same catalog; there is no database copy). A provider entry
names the env var holding its key (`api_key_env`) and may resolve its model id / endpoint from
env (`model_env` / `base_url_env`) — the built-in `flash` / `pro` ids follow `LLM_*`, native
DeepSeek / Kimi / MiniMax entries appear once their key is set. `options` belong to the model
(sampling / reasoning), never to an agent; `context_window` drives history compaction.
`@greenhouse/agent-core` keeps an env-derived fallback registry for tests and for consumers
that boot without the file. A `flash` / `pro` entry whose `LLM_MODEL` / `LLM_BASE_URL` point at
DeepSeek is built with the DeepSeek client (`isDeepSeekFamily` in agent-core), so the catalog's
`thinking` option and per-call `providerOptions.deepseek` reach the wire and `reasoning_content`
is parsed; the generic OpenAI client drops both (that is how auto-titles went blank).

## Testing

`pnpm test` runs all three layers; never trim real tests from the default command to save time.

| Layer | File name | Runs as | Scope |
|---|---|---|---|
| Unit / contract | `*.test.ts(x)` | `forks` pool, parallel; one process per file | Pure logic, mocked boundaries, components, protocols; must not touch PostgreSQL |
| DB integration | `*.db.test.ts(x)` | Parallel; each test inside a real transaction, rolled back | Services, routes, permissions observable on one connection |
| Committed-state DB | `*.db-commit.test.ts(x)` | Serial; unique business keys + targeted cleanup | Only when several connections must observe committed state, DDL or lock races; the file header must state `@db-commit-reason` |

- Tests that import `@greenhouse/db/test-config` belong to the last two layers;
  `tests/test-classification.test.ts` enforces naming and the commit-reason header.
- Unit tests use `forks` — don't switch back to `vmThreads`: its module cache is never freed
  between files, so worker heaps grow with the file count and CI runners get OOM-killed while
  the same tree passes locally.
- Restore mocks, fake timers, `process.env`, singletons and global registries within the file;
  never depend on file order or state another file left behind.
- DB tests never call `resetSchema()` in `beforeEach`: the DB project truncates once at
  startup (`tests/setup/db-global.ts`) and bootstraps the immutable platform manifests,
  protected roles and baseline policies; after that every test is isolated by rollback.
  Create internal test users with `tests/helpers/internal-user.ts`.
- Every test builds its own fixtures and asserts on ids returned by `create`; never rely on
  fixed serial ids (sequences don't roll back).
- Parallel worktrees set `TEST_DATABASE_URL=.../greenhouse_test_<slug>`; the safety check only
  accepts loopback targets whose name contains `test` / `e2e`.
- Fast feedback: `pnpm test:unit`; database focus: `pnpm test:db`; before landing run the full
  `pnpm test`. Worker counts are tunable via `VITEST_UNIT_MAX_WORKERS` /
  `VITEST_DB_MAX_WORKERS`.

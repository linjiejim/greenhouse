# Greenhouse — agent & contributor guide

## Project intro

Greenhouse is an open-source, AI-native enterprise agent workbench. The AI agent is the core
of the product, not an add-on: chat, the knowledge base, projects, automations, and email all
share one tool layer. The same tools members use in chat are exposed to external agents over
the `/api/agent` proxy and the `/api/mcp` MCP server.

Two access surfaces share one codebase:

- **Internal Agent** — `/api/chat` (NDJSON streaming) for logged-in members. Tools are
  narrowed by role ∩ profile ∩ per-user assignment.
- **External / public Agent** — `/api/v1/*` (OpenAI-compatible SSE), authenticated by an
  API key, restricted to the `default` profile and public tools.

> **MCP server** `/api/mcp` lets any external agent (Claude / Cursor / …) reach internal
> resources over the standard MCP protocol. The API key is **bound to one internal user**, and
> the proxy can only narrow that user's permissions — it is a restricted subset, not a
> separate plane. See `apps/api/src/AGENTS.md`.

## Rules

- Run `pnpm test` after functional changes.
- Run `pnpm typecheck` and `pnpm lint` after every change — both must pass.
- Update docs when API or behavior changes (`README.md` for humans; the `AGENTS.md` files for
  agents/conventions).
- Feature-level design docs live in `docs/specs/` (`YYYYMMDD-<kebab-name>.md`, indexed in
  `docs/specs/README.md`). Write the spec before building non-trivial cross-cutting features;
  update its status/checklist as work lands.
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
  delete every doc that references it (README, AGENTS.md, db-schema.md, example comments).
  "Keep docs in sync" applies to deletions exactly as it does to additions.
- **Deletes must cascade orphan-check.** After removing X, grep its dependents (components,
  helpers, types, i18n keys, nav entries) and remove anything that just lost its last consumer.
- **Check for an existing implementation first.** Before adding a "second" retrieval / chart /
  editor / etc., register in the relevant AGENTS.md why the existing one can't be reused or
  extended. Parallel implementations without a recorded reason are not accepted.
- **No speculative abstraction.** Don't write interface layers / multi-backend abstractions /
  "for future use" columns with no second consumer.
- **Declared capabilities must be real.** LLM tool descriptions, UI options, and docs must not
  claim unimplemented capabilities. Unconfigured / unimplemented paths must error explicitly,
  not pretend.

## Code quality

- **Pre-commit hook**: husky + lint-staged runs `eslint --fix` + `prettier --write` on staged
  files.
- **CI gate**: `.github/workflows/ci.yml` runs lint → typecheck → test → **e2e** on `main` and
  every PR (`quality-gate.yml`, reusable). The test/e2e jobs build the CI database via `migrate`
  (not push) so the whole migration chain is exercised on every run.
- **E2E security suite**: `pnpm test:e2e` (needs a running API; see `tests/e2e`). This is the
  **API-level** suite (vitest + `fetch`, no browser) covering auth / v1 / permissions / tool
  surface / injection / data isolation. CI runs it via `pnpm test:e2e:ci` (`scripts/e2e-ci.sh`),
  which boots the API against a dead LLM endpoint and sets `E2E_NO_LLM=1` to skip the two
  content-dependent v1 assertions — so it stays deterministic and free. When adding a test that
  needs a real model reply, gate it with `describe.skipIf(process.env.E2E_NO_LLM === '1')`.
- **Browser e2e (Playwright)**: `pnpm test:e2e:ui` — deterministic UI regression suite in
  `tests/e2e-ui/` (Chromium). Covers login, chat (LLM stubbed via `page.route` on `/api/chat`
  + the post-completion `GET /api/sessions/:id` reload), project create, and user create/delete
  (the last is the regression guard for the `users.delete` 500 bug). `playwright.config.ts`
  auto-starts `pnpm dev` (reuses a running one); `auth.setup.ts` creates a super test account
  via `admin:create` then logs in, saving storage state for the authenticated specs. Locators
  use the `data-testid` anchors on the key surfaces (login / chat / projects / users) +
  `role=dialog` on `<Dialog>`/`<ConfirmDialog>`. Writes use a per-run `e2e-<worker>-<ts>-`
  prefix and self-clean. This is the suite to run/extend for browser flows.
- **Dev mode**: `pnpm dev` runs Vite dev server (web, `:3100`, HMR) + the API (`:3000`) in
  parallel. Vite proxies `/api` (incl. ws), `/public`, `/health` to the API, so the browser
  sees same-origin — open `:3100`. Ports are overridable via `WEB_PORT` (Vite) and `API_PORT`
  (API + proxy target), read from repo-root `.env` (shell vars take precedence) — Vite loads
  `.env` via `loadEnv`. Production is `pnpm web:build` (Vite → repo-root `public/`,
  `base:'./'`), served directly by the API (`/` serves `public/index.html`, `/assets/*` static).

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

### Example dataset (`pnpm seed`)

`data/examples/` holds a de-identified reference dataset (fictional company "Greenhouse") —
one JSONL file per table, imported by `apps/api/src/cli/commands/seed.ts` (`pnpm seed`, i.e.
`pnpm cli seed`). It exists to explore/validate a fresh install and covers Tiers 1–3
(identity, knowledge base, projects, chat, and power features). **On a non-empty DB `pnpm seed`
refuses** and prints the choices: `--reset` (calls `resetSchema()` to wipe all rows first — a
destructive action gated behind typing the DB name, or `--yes` to skip) or `--keep` (load on
top). On an empty DB it just loads. When you add/rename a table or change a column that the
dataset populates, update the matching `data/examples/<table>.json` and its
[`README.md`](data/examples/README.md), and add the table to `LOAD_ORDER` in `commands/seed.ts`
(FK-safe order). Auth secrets are never baked in: `users.json` carries a plaintext `password`
hashed at load; `api_clients`/`llm_upstreams`/`email_accounts` (instance-secret-encrypted) are
not seeded.

## Project structure (pnpm monorepo)

```
greenhouse/
├── apps/
│   ├── browser/          # Chrome extension (MV3) — side panel + options, thin client of a
│   │                     #   self-hosted instance (login + token refresh); see its src/AGENTS.md
│   ├── mobile/           # Expo (React Native) app — chat + knowledge (read-only) + settings.
│   │                     #   NOT a workspace member (isolated install); see its AGENTS.md
│   ├── api/              # Hono backend — routes, agent runtime, auth, security, scheduler
│   │   └── src/
│   │       ├── routes/       # HTTP routes (one file per resource)
│   │       ├── auth/         # token, middleware, password, api-key, crypto, features
│   │       ├── tools/        # agent tools grouped by domain (knowledge/ projects/ email/ sessions/ media/ …), each defineTool
│   │       ├── agent-runtime/# tool proxy, MCP auth, lazy tool resolution, run-agent
│   │       ├── llm/          # completion / title / memory / relay-proxy (consumes agent-core)
│   │       ├── profiles/     # agent profiles in TS (defineProfile: default.ts/team.ts + *.prompt.md)
│   │       ├── scheduler/    # cron scheduler + executor (automations)
│   │       ├── email/        # IMAP/SMTP client + security
│   │       ├── storage/      # upload storage (local disk)
│   │       └── cli/          # `pnpm cli` console: index.ts dispatcher + commands/* (users,
│   │                         #   tools, profiles, sessions, seed, db, doctor, api-client) + chat.ts
│   └── web/              # React SPA — pages, components, lib, stores
│       └── src/
│           ├── pages/        # page components
│           ├── components/   # UI components
│           ├── lib/          # API client, auth, i18n, theme, utils
│           └── stores/       # Zustand stores
├── packages/
│   ├── agent-core/       # Agent kernel — single streamText loop, model factory/registry
│   │                     #   (OpenAI-compatible), time-context (no DB dependency)
│   ├── types/            # shared TypeScript types (incl. FEATURE_FLAGS registry)
│   ├── utils/            # shared helpers (date, json, concurrency, logger, crypto, error)
│   ├── db/              # database layer — Drizzle schema + domain services (types inferred)
│   ├── knowledge-editor/ # KB editor single source: Tiptap schema + server Markdown↔Tiptap JSON
│   ├── ui/               # shared presentational UI kit (React) — atoms, markdown/blocks,
│   │                     #   tool-call cards, sprouty, theme tokens CSS, i18n mechanism
│   └── contract/         # typed API contract — re-exports apps/api's AppType + hc (web client)
├── drizzle/              # migration files (single source of truth for the schema)
├── scripts/             # gen-secrets.sh, backup-db.sh
├── tests/               # unit / integration + e2e security suite
├── pnpm-workspace.yaml
└── tsconfig.base.json   # shared TypeScript base config
```

### Workspace package names

| Package | Path | Purpose |
|---|---|---|
| `@greenhouse/agent-core` | `packages/agent-core/` | Agent kernel — chat-engine, model registry/factory |
| `@greenhouse/types` | `packages/types/` | Shared type definitions (incl. feature-flag registry) |
| `@greenhouse/utils` | `packages/utils/` | Shared helpers |
| `@greenhouse/db` | `packages/db/` | Database layer |
| `@greenhouse/knowledge-editor` | `packages/knowledge-editor/` | KB editor: Tiptap schema + Markdown↔Tiptap JSON |
| `@greenhouse/ui` | `packages/ui/` | Shared UI kit (React, presentational only — no stores/router). Old `apps/web` paths re-export from it |
| `@greenhouse/contract` | `packages/contract/` | Typed API contract (AppType + hc; **type-only import of `@greenhouse/api`**) |
| `@greenhouse/api` | `apps/api/` | Backend app |
| `@greenhouse/web` | `apps/web/` | Frontend app |
| `@greenhouse/browser` | `apps/browser/` | Chrome extension (MV3) — consumes `@greenhouse/ui` |
| `@greenhouse/mobile` | `apps/mobile/` | Expo mobile app — **not** a workspace member (own lockfile, `pnpm mobile:install`); vendors its types |

### Import conventions

- Cross-package imports use the `@greenhouse/xxx` package name, not relative paths.
- Intra-package imports use relative paths + the `.js` extension (Node ESM).
- e.g. `import { nowIso } from '@greenhouse/utils/date'`
- e.g. `import type { DatabaseProvider } from '@greenhouse/db'`

## Domain rules

Detailed rules live next to the code:

| Domain | File | Scope |
|---|---|---|
| Database | [packages/db/src/AGENTS.md](./packages/db/src/AGENTS.md) | Service pattern, PostgreSQL, Drizzle, migrations |
| Backend API | [apps/api/src/AGENTS.md](./apps/api/src/AGENTS.md) | Routes, auth, security, tool system, v1/gateway/MCP |
| Frontend | [apps/web/src/AGENTS.md](./apps/web/src/AGENTS.md) | Design system, components, styling, i18n |
| Mobile | [apps/mobile/AGENTS.md](./apps/mobile/AGENTS.md) | Expo app — workspace isolation, vendored types, theme/i18n rules |
| Agent profiles | [apps/api/src/profiles/agent-profiles.md](./apps/api/src/profiles/agent-profiles.md) | Profiles, model switching, tool scoping |
| LLM / Agent kernel | `packages/agent-core/` + `apps/api/src/llm/` | Kernel (model factory/registry, chat-engine) in the package; completion/title/memory/relay consumers in api |

## Shared helpers (`packages/utils/`)

Always import these — don't reimplement:

| Function | Module | Purpose |
|---|---|---|
| `nowIso()` | `@greenhouse/utils/date` | ISO 8601 timestamp for all DB writes |
| `safeJsonParse(str, fallback)` | `@greenhouse/utils/json` | Safely parse DB JSON columns |
| `extractJson(raw)` | `@greenhouse/utils/json` | Extract JSON from LLM output |
| `runWithConcurrency(tasks, n)` | `@greenhouse/utils/concurrency` | Parallel tasks with a concurrency cap |
| `logger` | `@greenhouse/utils/logger` | Structured logging (info/warn/error) |
| `encrypt(plaintext, key)` | `@greenhouse/utils/crypto` | AES-256-GCM encrypt |
| `decrypt(ciphertext, key)` | `@greenhouse/utils/crypto` | AES-256-GCM decrypt |
| `parseHexKey(hex, label?)` | `@greenhouse/utils/crypto` | Validate + parse a 64-char hex key |
| `toErrorMessage(err)` | `@greenhouse/utils/error` | Normalize an unknown error to a readable string |
| `randomDocId(prefix?)` | `@greenhouse/utils/id` | Random opaque doc id (`doc-1a2b3c4d`); ids are system-assigned, never title-derived |

## Auth & permissions

- Roles: `super` > `team` > `external`.
- Auth module: `apps/api/src/auth/` (token, middleware, password, api-key, crypto, features).
- Route guards: `requireSuper()` (super only), `requireInternal()` (team + super),
  `requireRole(...)`, `requireFeature(key)` (per-user flag).
- Middleware injects `AuthUser` via `c.set('user', ...)` / `getAuthUser(c)`.
- All writes should include `user_id` in audit fields.
- **Fail-closed startup**: `assertAuthEnv()` (called in `main()`) refuses to start unless
  `ACCESS_PASSWORD` is set; if it is, `TOKEN_SIGNING_KEY` is also mandatory (no fallback, no
  `NODE_ENV` escape hatch). An unset `ACCESS_PASSWORD` would treat every request as super.

### Feature flags (per-user experimental toggles)

Fine-grained gating beyond roles: open a module/feature to specific internal users, toggled
per-user by a super in Settings → Users → Features.

- **Registry (single source)**: `FEATURE_FLAGS` in `packages/types/src/features.ts`. Each
  entry `{ key, label, description, defaultEnabled? }`.
- **Storage**: `user_features` table (`user_id × feature`, `enabled` boolean).
- **Resolution** (`resolveUserFeatures` in `apps/api/src/auth/features.ts`): `super → all on`;
  explicit row → `row.enabled`; no row → `flag.defaultEnabled` (default `false` = opt-in
  allowlist; `true` = opt-out).
- **Frontend**: `/api/auth/me` returns resolved `user.features`; UI gates with
  `canUseFeature(currentUser, key)` (`apps/web/src/lib/features.ts`, super passes
  automatically).

Adding an experimental feature (three steps):

1. Add an entry to `FEATURE_FLAGS` (the admin toggle appears automatically).
2. Backend guard: `app.use('/api/<x>/*', requireFeature('<key>'))` (UI hiding ≠ access control;
   the backend must enforce).
3. Frontend: wrap the tab/route/nav in `canUseFeature(currentUser, '<key>')`.

<p align="center">
  <img src="logos/greenhouse-logo.png" alt="Greenhouse" width="440" />
</p>

<p align="center">
  <a href="https://greenhouse.linjiejim.com"><img alt="Website" src="https://img.shields.io/badge/website-greenhouse.linjiejim.com-0d9488"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-0d9488.svg"></a>
  <a href="https://github.com/linjiejim/greenhouse/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/linjiejim/greenhouse?color=0d9488"></a>
  <a href="https://github.com/linjiejim/greenhouse/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/linjiejim/greenhouse/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/linjiejim/greenhouse/stargazers"><img alt="Stars" src="https://img.shields.io/github/stars/linjiejim/greenhouse?style=social"></a>
</p>

**An open-source, AI-native enterprise agent workbench.** One command to self-host, members
log in with accounts (no app to install), and every capability is also callable by external
agents over [MCP](https://modelcontextprotocol.io/). Admins author tools in code that
auto-expose over chat, `/api/agent`, and `/api/mcp` — add a tool by writing one file.

Greenhouse is built around the idea that the agent *is* the product, not a feature bolted on
the side. The chat agent, the knowledge base, projects, automations and email all share one
tool layer; the same tools your team uses in chat are the ones you expose to Claude, Cursor,
or any MCP client.

## Features

- **Chat** — streaming agent with selectable profiles (public vs. internal), tool-call
  traces, memory, image analysis and generation, and session sharing/grouping/tagging.
- **Knowledge Base** — team, personal, and shared documents with a Tiptap rich-text editor,
  Markdown-first storage, full-text search, version history, and fine-grained sharing via
  user Groups.
- **Projects** — projects, tasks (board / gantt / tree views), members, comments, and an
  activity log.
- **Automations** — cron-scheduled agent runs that execute a prompt against a profile on a
  recurring schedule.
- **Memory** — persistent per-user facts extracted from conversations and reused as context.
- **Skill Center** — an org-wide library of agent skills (SKILL.md folders): publish from
  your own AI tool over MCP/chat, find & download colleagues' skills, and keep installs in
  sync — every version immutable with a mandatory changelog. Bundles live on local disk by
  default or any S3-compatible store (`SKILLS_S3_*`).
- **Email** *(optional)* — IMAP/SMTP mailbox connector; search, read, draft, and send from
  the agent.
- **LLM gateway + BYOK** — internal users reach admin-managed models through a server-side
  relay (no personal key needed), or bring their own.
- **MCP server + agent tool-proxy** — expose the workbench's tools to any external agent over
  the standard MCP protocol or the structured `/api/agent` proxy.
- **Global Agent** — the agent can operate the web UI (navigate / prefill) via client-declared
  actions.

Roles: **super > team > external**, plus per-user feature flags for gating optional modules.
Auth is fail-closed — the server refuses to start without `ACCESS_PASSWORD` and
`TOKEN_SIGNING_KEY`.

## Architecture

A pnpm monorepo. The Hono API also serves the built React SPA, so production is a single
process / single container.

```
greenhouse/
├── apps/
│   ├── api/                  # Hono backend — routes, agent runtime, auth, scheduler;
│   │                         #   also serves the built web SPA at `/`
│   ├── web/                  # React + Vite single-page app (hash router)
│   ├── browser/              # Chrome extension (MV3) — side-panel companion; connects to
│   │                         #   your instances via saved multi-server "stations"
│   │                         #   (build: pnpm -F @greenhouse/browser build)
│   └── mobile/               # Expo (React Native) app — chat, knowledge base (edit + history),
│                             #   projects (list/board/gantt), settings; multi-server
│                             #   "stations" picked at sign-in; isolated install
│                             #   (pnpm mobile:install, then pnpm mobile)
├── packages/
│   ├── agent-core/           # Agent kernel — streamText loop, OpenAI-compatible model
│   │                         #   factory + registry (no DB dependency)
│   ├── types/                # Shared TypeScript types (incl. feature-flag registry)
│   ├── utils/                # Shared helpers (date, json, crypto, logger, concurrency)
│   ├── db/                   # Database layer — Drizzle schema + domain services
│   ├── knowledge-editor/     # Tiptap schema + server-side Markdown ↔ Tiptap JSON
│   ├── ui/                   # Shared React UI kit (atoms, markdown renderers, tool-call
│   │                         #   cards, design tokens, i18n mechanism)
│   └── contract/             # Typed API contract — re-exports the API's AppType + hc
│                             #   (single source for the web's typed client)
├── drizzle/                  # Migration files (the single source of truth for the schema)
├── scripts/                  # gen-secrets.sh, backup-db.sh
└── tests/                    # unit / integration + e2e security suite
```

**Stack:** [Hono](https://hono.dev/) API · React 19 + [Vite](https://vite.dev/) ·
PostgreSQL 16 + [Drizzle ORM](https://orm.drizzle.team/) · any OpenAI-compatible LLM ·
Node.js 22 (ESM, run via `tsx`).

Full package conventions live in [AGENTS.md](./AGENTS.md).

## Quick start (local development)

Prerequisites: Node.js ≥ 22, pnpm ≥ 11, Docker (for PostgreSQL).

```bash
# 1. Start just Postgres (bound to 127.0.0.1:5432)
docker compose up -d postgres

# 2. Install deps
pnpm install

# 3. Configure secrets + LLM
cp .env.example .env && ./scripts/gen-secrets.sh   # fills the required random secrets
#   then edit .env and set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL

# 4. Apply the migration chain
pnpm drizzle-kit migrate

# 5. Create the first super-admin — or skip to step 6 to load the demo dataset instead
pnpm admin:create

# 6. (optional) Instead of a bare admin, load the example dataset (it bundles demo
#    admins) to explore with realistic content. Fresh DB: no flag needed. To re-seed
#    a populated DB, use `pnpm seed --reset` (wipes first, asks to confirm).
pnpm seed

# 7. Run the dev servers (Vite web :3100 + API :3000, Vite proxies /api → api)
pnpm dev
```

Open http://localhost:3100. Backend changes require a restart (the API has no `--watch`);
frontend changes hot-reload.

> **Custom ports** — if `:3100`/`:3000` clash with something, set `WEB_PORT` /
> `API_PORT` in `.env` (or as shell vars, which take precedence); the web dev
> proxy follows `API_PORT`. E.g. `WEB_PORT=4400` + `API_PORT=4401`.

> **Example dataset** — `pnpm seed` loads a small, de-identified fictional company
> (users, knowledge base, projects, chats, automations, sharing) so you can experience and
> validate every major feature. Every seeded user logs in with the password `greenhouse`
> (e.g. `maya@greenhouse.example`). See [`data/examples/README.md`](data/examples/README.md).
> `pnpm seed` replaces `pnpm admin:create` for a demo install — it seeds its own admin.
> On a non-empty database it refuses unless you pass `--reset` (wipe first) or `--keep`
> (load on top).

> **CLI console** — `pnpm cli <command>` is the dev/ops entry point for a self-hosted
> instance, mostly in-process (no running server needed): `users` (list / show / create),
> `tools`, `profiles`, `sessions` (browse + dump a transcript for debugging), `stats`,
> `seed`, `db reset`, `api-client` (mint/list keys), `doctor` (env + DB readiness check),
> and `chat` (needs a running server). `admin:create`, `seed`, and `chat` also stay as
> top-level script aliases. Run `pnpm cli --help` for the full guide (`pnpm help` is pnpm's
> own built-in, so use `pnpm cli --help` or `pnpm run help`).

## One-command Docker deploy

The bundled `docker-compose.yml` runs Postgres, a one-shot migration job, and the API
(which serves the SPA) as a single self-contained image.

```bash
cp .env.example .env && ./scripts/gen-secrets.sh   # fills required secrets
#   edit .env: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL
docker compose up -d --build
docker compose exec api pnpm admin:create          # create the first super-admin
```

The app is then at http://localhost:3000.

Prefer the published image over a source build? Use
[`docker-compose.ghcr.yml`](./docker-compose.ghcr.yml) instead — same stack, but it
pulls `ghcr.io/linjiejim/greenhouse` (no Node/pnpm toolchain needed):

```bash
docker compose -f docker-compose.ghcr.yml up -d    # tracks :latest; pin via GREENHOUSE_IMAGE in .env
```

## Releases & stability

**Use a tagged release in production.** Two channels, and they are not equally
stable:

| You want… | Use | Stability |
|---|---|---|
| A version to run in production | A **tagged release** `vX.Y.Z` — [Releases](https://github.com/linjiejim/greenhouse/releases) · image `ghcr.io/linjiejim/greenhouse:X.Y.Z` (or `:X.Y`, `:latest`) | **Stable** — a cut we stand behind |
| The bleeding edge / to test `main` | `ghcr.io/linjiejim/greenhouse:edge` (or `:main-<sha>`) | **Unstable** — CI builds off `main`; may break between releases |

`:latest` always points at the newest **stable** release — never at `main`.
Every release is stamped: `GET /health` returns the `version` + commit `revision`
the running build was cut from, so a bug report can be matched to exact code.

The **browser extension** is attached to each Release as
`greenhouse-bridge-vX.Y.Z.zip` (unzip → Chrome → "Load unpacked", or submit to the
Web Store). The **mobile app** ships on its own cadence via EAS: JS-only changes
roll out as over-the-air updates; native changes auto-build and upload to
TestFlight. Maintainer runbook: **[RELEASING.md](./RELEASING.md)**.

### Upgrading

Database migrations ship inside the image and are applied by a one-shot `migrate`
service **before** the API starts — an upgraded deployment never runs new code
against an old schema, and already-applied migrations are skipped. Optional but
wise before a big jump: `./scripts/backup-db.sh`.

```bash
# Docker, published image (docker-compose.ghcr.yml):
docker compose -f docker-compose.ghcr.yml pull
docker compose -f docker-compose.ghcr.yml up -d

# Docker, built from source (a fork / local checkout):
git pull && docker compose up -d --build

# Bare-metal source checkout:
git pull && pnpm install && pnpm drizzle-kit migrate   # then restart the API
```

## Configuration

Everything is environment-driven; see [.env.example](./.env.example) for the full list.

**Required** (the server fails to start without the auth/encryption keys):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string |
| `ACCESS_PASSWORD` | Gates all internal routes; unset = auth disabled, so it is mandatory |
| `TOKEN_SIGNING_KEY` | Independent signing key for auth tokens (`openssl rand -hex 32`) |
| `PROVIDER_TOKEN_ENCRYPTION_KEY` | AES-256-GCM key for stored secrets — gateway upstream keys, email credentials (`openssl rand -hex 32`) |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | Any OpenAI-compatible endpoint; all logical model ids (`default`/`flash`/`pro`) resolve to `LLM_MODEL` (override `pro` with `LLM_MODEL_PRO`) |

Optional: vision (`analyze_image`), image generation (`generate_image`), and external web
search. Uploads are stored on local disk (`data/uploads`), fine for single-instance deploys.
Skill Center bundles default to local disk too (`data/skills`) — set the `SKILLS_S3_*` vars
to keep them in S3-compatible object storage instead. See `.env.example`.

## MCP & agent access

Every capability is reachable three ways from the same tool layer:

- **Chat** — tools the user is entitled to are passed to the model in `/api/chat`.
- **`/api/agent`** — structured tool proxy for programmatic clients: `GET /runtime-manifest`
  lists the caller's available tools (with input schemas), `POST /tools/:id/call` invokes one.
  Read tools run freely; write tools are deny-by-default and require `confirm: true`.
- **`/api/mcp`** — the same proxy wrapped in the standard MCP protocol (Streamable HTTP), so
  any MCP client (Claude, Cursor, …) can connect. The key is **bound to a specific internal
  user**; the proxy can only *narrow* that user's permissions, never widen them. Provision and
  manage keys under Settings › Administration › MCP Access.

For both proxy surfaces the effective tool set is `resolveEffectiveTools(user, profile)`
intersected with the proxy allowlist — a tool only appears if it declares the relevant
`surface` in its metadata (see below).

## Adding a tool

> Forking Greenhouse to build something private on top? See **[EXTENDING.md](./EXTENDING.md)** —
> it documents every extension point (tools, routes, DB tables, pages, profiles, LLM providers,
> feature flags, i18n) so a fork adds private features without editing shared files or diverging
> from upstream.

A tool is **one file + one line** — for every kind, not just stateless ones. Declare it with
`defineTool`, give it a `create(ctx)`, set its `surface`, and add one line to `TOOL_MODULES`.

A **static** tool needs nothing per request (only the shared `db`):

```ts
// apps/api/src/tools/my-tool.ts
export const myTool = defineTool({
  meta: {
    id: 'my_tool',
    name: 'My Tool',
    brief: 'one-line summary (always in the prompt)',
    description: 'full usage instructions — passed straight to the model',
    category: 'team',
    is_global: true,
    icon: 'Wrench',
    group: 'compute', // functional domain (one of TOOL_GROUPS in define.ts) — how the UI sections tools
    surface: {
      proxy: 'read',   // 'read' (no confirm) | 'write' (confirm-gated) | 'none'
      mcp: true,       // also expose over /api/mcp
    },
  },
  kind: 'static',
  create: (ctx) => tool({ /* description, inputSchema, execute — uses ctx.db */ }),
});
```

A **lazy** tool needs request context (the calling user / the session). Declare what it needs
with `requires`; the runtime builds it per request, passes a `ctx` carrying those fields, and
enforces `requires` as the access guard (no permission checks wired anywhere else):

```ts
export const myUserTool = defineTool({
  meta: {
    /* … same shape … */
  },
  kind: 'lazy',
  requires: { user: 'internal' }, // 'optional' | 'required' | 'internal'  (+ session?, registry?)
  create: (ctx) => createMyUserTool(ctx.db, { userId: ctx.userId }),
});
```

Then add one line to `TOOL_MODULES` in `apps/api/src/tools/registry.ts`. That's it — no other
edits, including for lazy tools. The registry derives the read/write proxy allowlists, the
MCP-exposed set, and the lazy build list directly from each module's `meta.surface` / `kind` /
`requires` — there are no hand-maintained id lists. The tool is now reachable in chat,
`/api/agent`, and `/api/mcp`.

Optional modules are gated by per-user feature flags: add an entry to
`packages/types/src/features.ts` and guard the routes with `requireFeature('<key>')`.

## Development

```bash
pnpm dev          # Vite web (:3100) + API (:3101), proxied
pnpm test         # vitest
pnpm test:e2e     # e2e security suite (needs a running API — see tests/e2e)
pnpm test:e2e:ci  # e2e suite, self-contained (boots the API, stubs the LLM) — same as CI
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint + prettier --check
pnpm lint:fix     # auto-fix
```

A husky + lint-staged pre-commit hook runs `eslint --fix` + `prettier --write` on staged
files. CI (`.github/workflows/ci.yml`) runs lint → typecheck → test → e2e on `main` and every PR.

### Database migrations

Migration files (`drizzle-kit generate` → `migrate`) are the single source of truth for the
schema. Edit `packages/db/src/schema/*.ts`, run `pnpm drizzle-kit generate`, review the
generated SQL, and commit it. **On persistent / shared databases use `migrate` only — never
`push`** (`push` is for throwaway local scratch DBs). See
[packages/db/src/AGENTS.md](./packages/db/src/AGENTS.md).

### Backups

```bash
./scripts/backup-db.sh            # dump to data/db/backups/ (gzipped, keeps last 10)
```

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](./CONTRIBUTING.md) for setup, the
quality gates, and conventions, and please follow the
[Code of Conduct](./CODE_OF_CONDUCT.md). Found a security issue? Don't open a public
issue — see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE) — © Greenhouse contributors.

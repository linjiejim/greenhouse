<p align="center">
  <img src="logos/greenhouse-logo.png" alt="Greenhouse" width="440" />
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
│   └── web/                  # React + Vite single-page app (hash router)
├── packages/
│   ├── agent-core/           # Agent kernel — streamText loop, OpenAI-compatible model
│   │                         #   factory + registry (no DB dependency)
│   ├── types/                # Shared TypeScript types (incl. feature-flag registry)
│   ├── utils/                # Shared helpers (date, json, crypto, logger, concurrency)
│   ├── db/                   # Database layer — Drizzle schema + domain services
│   ├── knowledge-editor/     # Tiptap schema + server-side Markdown ↔ Tiptap JSON
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

# 5. Create the first super-admin
pnpm admin:create

# 6. Run the dev servers (Vite web :3100 + API :3101, Vite proxies /api → api)
pnpm dev
```

Open http://localhost:3100. Backend changes require a restart (the API has no `--watch`);
frontend changes hot-reload.

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
See `.env.example`.

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

A tool is one file. Declare it with `defineTool`, set its `surface`, and register it:

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
    sort_order: 100,
    surface: {
      proxy: 'read',   // 'read' (no confirm) | 'write' (confirm-gated) | 'none'
      mcp: true,       // also expose over /api/mcp
    },
  },
  kind: 'static',
  create: (db) => tool({ /* description, inputSchema, execute */ }),
});
```

Then add one line to `TOOL_MODULES` in `apps/api/src/tools/registry.ts`. The registry derives
the read/write proxy allowlists and the MCP-exposed set directly from each tool's
`meta.surface` — there are no hand-maintained id lists. The tool is now reachable in chat,
`/api/agent`, and `/api/mcp`.

Optional modules are gated by per-user feature flags: add an entry to
`packages/types/src/features.ts` and guard the routes with `requireFeature('<key>')`.

## Development

```bash
pnpm dev          # Vite web (:3100) + API (:3101), proxied
pnpm test         # vitest
pnpm test:e2e     # e2e security suite (needs a running API — see tests/e2e)
pnpm typecheck    # tsc --noEmit
pnpm lint         # eslint + prettier --check
pnpm lint:fix     # auto-fix
```

A husky + lint-staged pre-commit hook runs `eslint --fix` + `prettier --write` on staged
files. CI (`.github/workflows/ci.yml`) runs lint → typecheck → test on `main` and every PR.

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

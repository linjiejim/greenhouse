# Contributing to Greenhouse

Thanks for your interest in contributing! This is the human-facing quick start.
The detailed, authoritative conventions live in [`AGENTS.md`](./AGENTS.md) (and a
per-area `AGENTS.md` next to the code) — please skim the root one before a
non-trivial change.

## Prerequisites

- **Node** 22+ and **pnpm** (the repo pins `pnpm@11.9.0` via `packageManager`)
- **PostgreSQL** — easiest via the bundled Docker stack

## Local setup

```bash
pnpm install

# secrets: copy the template and generate the required random keys
cp .env.example .env && ./scripts/gen-secrets.sh
#   then edit .env: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL (any OpenAI-compatible endpoint)

# start just Postgres from the compose file (bound to 127.0.0.1:5432)
docker compose up -d postgres

# create the first super admin
pnpm admin:create

# run the app (web :3100 with HMR + API :3101; open http://localhost:3100)
pnpm dev
```

For the one-command container path (Postgres + migrate + the API serving the
SPA), see the Deploy section of [`AGENTS.md`](./AGENTS.md).

## Quality gates (run before pushing)

Both must pass — CI enforces them on every PR:

```bash
pnpm typecheck
pnpm lint          # eslint + prettier --check
pnpm test          # vitest unit
```

When your change touches the relevant area, also run:

```bash
pnpm test:e2e      # API-level security suite (needs a running API; see tests/e2e)
pnpm test:e2e:ui   # browser flows (Playwright; auto-starts the dev server)
```

A pre-commit hook (husky + lint-staged) auto-runs `eslint --fix` + `prettier`
on staged files.

## Conventions that matter

These are enforced in review (full detail in `AGENTS.md`):

- **Keep docs in sync.** Update `README.md` (for humans) and the relevant
  `AGENTS.md` (conventions) when behavior/APIs change.
- **Delete & reuse discipline.** Don't add a parallel implementation without
  recording why the existing one can't be reused; when you remove something,
  remove its orphaned consumers and stale docs too.
- **No declared-but-unimplemented capabilities.** Tool descriptions, UI options,
  and docs must reflect what actually works; unconfigured paths should error
  explicitly, not pretend.
- **DB schema changes** need a migration: edit the schema →
  `drizzle-kit generate` → review the SQL → commit. On shared/persistent DBs use
  `migrate`, never `push`. Update `packages/db/src/AGENTS.md`.
- **Don't reinvent helpers** — check `packages/utils/` first.
- **Use the structured `logger`** (`@greenhouse/utils/logger`) in runtime code,
  not raw `console.*` (CLI tools that print to the operator are the exception).

## Pull requests

1. Branch off `main`, keep the PR focused and small where you can.
2. Fill in the PR template checklist.
3. Link the issue it addresses (`Closes #123`).
4. Make sure the quality gates above are green.

## Reporting issues

- Bugs / features: open an issue using the templates.
- **Security vulnerabilities: do not open a public issue** — see
  [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).

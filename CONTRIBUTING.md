# Contributing to Greenhouse

Thanks for your interest in contributing! This is the human-facing quick start.
The detailed, authoritative conventions live in [`AGENTS.md`](./AGENTS.md) and a per-area
`AGENTS.md` next to the code; skim the root one before a non-trivial change.

## Prerequisites

- **Node** 22+ and **pnpm** (the repo pins `pnpm@11.9.0` via `packageManager`)
- **PostgreSQL** 16, easiest via the bundled Docker stack
- **Chromium** for the browser suite (`pnpm exec playwright install chromium`)

## Local setup

```bash
pnpm install
pnpm client:install      # apps/client keeps its own lockfile outside the root workspace

# secrets: copy the template and generate the required random keys
cp .env.example .env && ./scripts/gen-secrets.sh
#   then edit .env: set LLM_BASE_URL / LLM_API_KEY / LLM_MODEL (any OpenAI-compatible endpoint)

# start just Postgres from the compose file (bound to 127.0.0.1:5432)
docker compose up -d postgres

# apply the 4.0 migration chain to the database you name (never another worktree's)
DATABASE_URL=postgresql://greenhouse:greenhouse@127.0.0.1:5432/greenhouse pnpm db:migrate

# create the first super admin
pnpm admin:create

# API :3000 + the universal client's Expo web dev server :3100; open http://localhost:3100
pnpm dev
```

For the container path (Postgres + migrate + the API serving the client), see the
[README](./README.md#quick-start-docker). Upgrading an existing deployment is covered in
[docs/upgrading-to-4.0.md](./docs/upgrading-to-4.0.md).

## Quality gates

CI runs these on every PR; run the relevant ones before pushing:

```bash
pnpm lint                 # plugin import boundaries + eslint + prettier --check
pnpm typecheck
pnpm test:unit            # fast feedback; no database
TEST_DATABASE_URL=postgresql://greenhouse:greenhouse@127.0.0.1:5432/greenhouse_test pnpm test
                          # every vitest layer: unit + db + db-commit (loopback test/e2e database)
```

When your change touches the area, also run:

```bash
pnpm plugins:sync --check                              # plugin assembly inputs
TEST_DATABASE_URL=<loopback-test-db> pnpm test:core    # core with zero plugins compiled, plus a boot check
DATABASE_URL=<loopback-test-db> pnpm test:e2e:ci       # live-server HTTP security suite (tests/e2e)
pnpm test:e2e:client                                   # universal client in Chromium (tests/client-e2e)
(cd apps/client && pnpm typecheck && pnpm lint)        # the client is skipped by root checks; CI does not run these
pnpm app:build                                         # hosted client export into public/app
```

`pnpm test:e2e:client` boots the API and Expo web from `playwright.client.config.ts` against a
migrated database. Set `CLIENT_E2E_DATABASE`, `CLIENT_E2E_API_PORT` and `CLIENT_E2E_WEB_PORT` to
keep parallel worktrees apart; CI enables every plugin (`GREENHOUSE_EXTENSIONS=all`) for it.
Desktop changes run `pnpm desktop:check` (see [apps/desktop/README.md](./apps/desktop/README.md)).

A pre-commit hook (husky + lint-staged) runs `eslint --fix` + `prettier` on staged files outside
`apps/client`.

## Conventions that matter

These are enforced in review (full detail in `AGENTS.md`):

- **Keep docs in sync.** Update `README.md` (for humans) and the relevant `AGENTS.md`
  (conventions) when behavior/APIs change.
- **Delete & reuse discipline.** Don't add a parallel implementation without recording why the
  existing one can't be reused; when you remove something, remove its orphaned consumers and
  stale docs too.
- **No declared-but-unimplemented capabilities.** Tool descriptions, UI options and docs must
  reflect what actually works; unconfigured paths error explicitly.
- **Core never imports plugins.** Business modules live in `plugins/<id>/` and reach the host
  only through `@greenhouse/api/extension-kit`; see [EXTENDING.md](./EXTENDING.md).
- **DB schema changes** need a migration: edit the schema → `pnpm drizzle-kit generate` (it diffs
  against the 4.0 baseline) → review the SQL → commit → `pnpm db:migrate`. Plugin tables use the
  plugin's own lane under `plugins/<id>/migrations/`. On shared/persistent DBs use
  `pnpm db:migrate`, never `push`. Update `packages/db/src/db-schema.md` (and
  `packages/db/src/AGENTS.md` when a rule changes).
- **Client UI** follows [`apps/client/DESIGN.md`](./apps/client/DESIGN.md) and ships copy in both
  `en` and `zh`.
- **Don't reinvent helpers**: check `packages/utils/` first.
- **Use the structured `logger`** (`@greenhouse/utils/logger`) in runtime code, not raw
  `console.*` (CLI output to the operator is the exception).

## Pull requests

`main` is the integration branch (trunk): branch → PR → review → merge. It is protected: CI must
be green and at least one review is required before merge.

1. Branch off `main`, keep the PR focused and small where you can.
2. Fill in the PR template checklist.
3. Link the issue it addresses (`Closes #123`).
4. Make sure the quality gates above are green.

**PRs are squash-merged, and the squash commit must be a
[Conventional Commit](https://www.conventionalcommits.org/)** (`feat(client): …`,
`fix(api): …`). That one line per PR drives automated versioning and the changelog: `feat` →
minor bump, `fix` → patch, a breaking change (`!`) → major. See [RELEASING.md](./RELEASING.md)
for how a release is cut; you don't need to touch `CHANGELOG.md` or any `version` field.

## Reporting issues

- Bugs / features: open an issue using the templates.
- **Security vulnerabilities: do not open a public issue**; see [`SECURITY.md`](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](./LICENSE).

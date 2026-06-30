<!--
Thanks for contributing to Greenhouse! Keep PRs focused and small where possible.
See AGENTS.md for conventions (delete & reuse discipline, doc sync, migrations).
-->

## What & why

<!-- A short description of the change and the motivation. Link issues: Closes #123 -->

## How it was tested

<!-- Commands run / scenarios checked. e.g. unit, API e2e, browser e2e, manual. -->

## Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes (and `pnpm test:e2e` / `pnpm test:e2e:ui` if relevant)
- [ ] Docs updated where behavior/API changed (`README.md` for humans, the relevant
      `AGENTS.md` for conventions)
- [ ] DB schema change? Includes a generated migration (`drizzle-kit generate`) and a
      `packages/db/src/AGENTS.md` update — `migrate`, never `push`, on shared DBs
- [ ] Deletions are clean: removed orphaned consumers and synced/removed stale docs
- [ ] No secrets, credentials, or machine-local paths added to tracked files

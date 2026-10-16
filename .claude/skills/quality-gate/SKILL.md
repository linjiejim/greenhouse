---
name: quality-gate
description: >-
  Run the Greenhouse quality gate before a commit or PR: typecheck, lint, unit and db tests, the
  suites the change touches, a scan of the changed files and the docs check, then a pass/fail
  report. Use for 跑一下门禁 / 提交前自检 / 检查代码质量 / quality gate / pre-commit check.
---

Run from the repo root of the current checkout. The rules being checked live in the root AGENTS.md and the AGENTS.md next to the changed code.

Always:
1. `pnpm typecheck`
2. `pnpm lint`; on failure `pnpm lint:fix`, then `pnpm lint` again.
3. `pnpm test` with TEST_DATABASE_URL set to a loopback database named *test* (never a shared one).

Also, when the change touches:
- packages/ui/src/tokens/haven.ts: `pnpm tokens:build`, then `pnpm test`
- apps/design: `pnpm test:design-ui` (DESIGN_PORT when 4518 is taken)
- packages/db/src/schema: `pnpm db:baseline` and a clean migrate of a scratch database
- apps/desktop: `pnpm desktop:check`

Scan the changed files (`git diff --name-only $(git merge-base origin/v2 HEAD)` plus untracked):
- no console.* in server code, no process.env outside apps/api/src/config
- no hard-coded colors outside packages/ui/src/tokens
- imports by package name; no duplicated helpers from packages/utils

Docs: the owning AGENTS.md, README.md for visible behavior, data-model.md and api.md for schema and endpoints, the feature row in features.md.

Report one line per check: name, pass, fail or skipped, and a short note. Never skip or weaken a check to get a pass.

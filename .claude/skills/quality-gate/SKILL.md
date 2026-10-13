---
name: quality-gate
description: >-
  Run the Greenhouse quality gate before a commit, PR or landing: typecheck, lint, tests, the
  extra suites the change touches, a scan of the changed files and the docs check, then a
  pass/fail report. Use for 跑一下门禁 / 提交前自检 / 检查代码质量 / quality gate /
  pre-commit check / is this ready to land.
---

Run everything from the repo root of the current checkout. The rules being checked live in the root AGENTS.md and the AGENTS.md next to the changed code; this is only the checklist.

Always:
1. `pnpm typecheck`
2. `pnpm lint`; on failure run `pnpm lint:fix`, then `pnpm lint` again.
3. `pnpm test` (unit, db and db-commit layers). `pnpm test:unit` and `pnpm test:db` are for iterating, never the final run.
4. The db layers need the local Postgres; a parallel worktree points TEST_DATABASE_URL at its own `greenhouse_test_<slug>` database (root AGENTS.md, Testing).

Also run, when the change touches:
- auth, roles, cross-user isolation or tool surfaces: `pnpm test:e2e:ci`
- web UI flows: `pnpm test:e2e:ui`
- apps/design: `pnpm test:design-ui`
- packages/ui/src/tokens/haven.ts: `pnpm tokens:build`, then `pnpm test` again
- apps/desktop: `pnpm desktop:check`
- apps/mobile, which the root gate skips: `pnpm typecheck` and `pnpm lint` inside apps/mobile

Scan only the changed files: `git diff --name-only $(git merge-base main HEAD)` plus `git ls-files --others --exclude-standard`.
- apps/api: no console.log, console.warn or console.error outside apps/api/src/cli; use logger from @greenhouse/utils/logger.
- apps/web: no hard-coded colors such as `bg-white`, `text-gray-*`, `border-gray-*`, `bg-red-*`, `text-red-*` or `teal-500`.
- apps/web: no raw `<input>`, `<select>` or `<textarea>` outside components/ui.tsx and components/form/; no window.confirm or alert.
- imports: another package only by its `@greenhouse/*` name; relative imports in apps/api and `packages/*` (except packages/ui) end in .js.
- helpers: nothing that duplicates packages/utils or apps/web/src/lib/utils.ts.

Docs:
- the AGENTS.md that owns the changed area describes any new rule or structure
- README.md describes behavior people see
- packages/db/src/db-schema.md matches any schema change
- the feature's row in docs/product/features.md has the right status and PR
- EXTENDING.md, the example extension and the seam tests match any extension contract change
- a visible UI change reruns `node scripts/capture-screens.mjs` against a running seeded stack
- a deletion also removes its references and orphans (components, helpers, types, i18n keys, nav entries)

Report one line per check: its name, pass, fail or skipped, and a short note (failing test names, counts). Report failures as failures; never skip or weaken a check to get a pass.

---
name: full-feature
description: >-
  Build a Greenhouse feature end to end, from its row in docs/product/features.md through DB,
  API, web, agent tool, tests, gate and docs, by running the single-layer skills in order. Use
  for 做个完整功能 / 端到端实现 / 从表到页面都要 / build a feature end to end / full feature.
---

This skill only orders the work. Each layer has its own skill, and each rule lives in the AGENTS.md next to the code.

1. Find the feature's row in docs/product/features.md or add one (ID, the object it belongs to, why no existing feature covers it); mark it `进行中`. Stop if the row says 删除 or 合并.
2. Decide core or extension: a private, optional or deployment-specific module lives in `apps/api/src/extensions/<id>/` and `apps/web/src/extensions/<id>/` (EXTENDING.md, recipe "a private module as an extension").
3. Look for an implementation to extend; a second one needs a recorded reason in the owning AGENTS.md.
4. For a non-trivial or cross-cutting feature, write the spec first: `docs/specs/YYYYMMDD-<name>.md`.
5. Data: add-db-table skill.
6. HTTP: add-api-route skill; shared types in packages/types, helpers from packages/utils.
7. Web: add-frontend-page skill.
8. Agent access: add-agent-tool skill, calling the same service as the route.
9. Mobile, browser extension or desktop: follow apps/mobile/AGENTS.md, apps/browser/src/AGENTS.md or apps/desktop/AGENTS.md.
10. Tests on every layer touched: unit, db, tests/e2e for auth or isolation, tests/e2e-ui for UI flows.
11. Run the quality-gate skill, including its docs check.
12. In the same PR, set the feature's row to `已实现` with the PR number. For a removal, delete its nav, routes, tools, i18n, tests, seeds, docs and screenshots, then set `已删`.

v2: once the v2 branch exists, v2 slices land there one PR each (docs/product/roadmap.md); main keeps the v1 fixes.

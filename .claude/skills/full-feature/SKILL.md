---
name: full-feature
description: >-
  Build a Greenhouse v2 feature end to end, from its row in docs/product/features.md through
  schema, contract, service, routes, tests and docs. Use for 做个完整功能 / 端到端实现 /
  从表到页面都要 / build a feature end to end / full feature.
---

This skill only orders the work; each layer's rules live in the root AGENTS.md.

1. Find the feature's row in docs/product/features.md or add one (ID, object, why nothing existing covers it); stop if it says 删除 or 合并.
2. Read the matching sections of prd.md, api.md and data-model.md; update them first if the design changes.
3. Data: the add-db-table skill.
4. API: the add-api-route skill (contract schemas, service, routes, tests).
5. Agent access: the tool calls the same service as the route (comes with roadmap M0.6).
6. Web: built on packages/ui following docs/design-system (comes with roadmap M1).
7. Run the quality-gate skill.
8. In the same commit, set the feature's row to 已实现 with the PR, or 已删 for a removal.

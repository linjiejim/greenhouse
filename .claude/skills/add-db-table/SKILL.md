---
name: add-db-table
description: >-
  Add or change a table in the Greenhouse v2 schema: Drizzle schema, id prefix, regenerated
  baseline, data-model.md and a db test. Use for 新增表 / 加个表 / 加字段 / 改表结构 / 写迁移 /
  add a table / add a column / change the schema.
---

Rules live in the root AGENTS.md (Database, Commands). The schema follows docs/product/data-model.md; change that document in the same commit. Copy packages/db/src/schema/conversations.ts for the style.

Steps:
1. Check the feature's row in docs/product/features.md and the table's section in data-model.md.
2. Define the table in `packages/db/src/schema/<domain>.ts` with explicit indexes, partial unique indexes for "one per" rules, and exported row types.
3. Export a new file from packages/db/src/schema/index.ts. Add its id prefix to ID_PREFIX in packages/db/src/ids.ts.
4. Run `pnpm db:generate --name <change>` and read the new migration in drizzle/. Never regenerate or edit a released migration.
5. Write or extend a `*.db.test.ts` for each constraint that encodes a rule; expected violations run in a savepoint.
6. Update data-model.md (and migration-v1.md when the change affects how v1 data maps).
7. Run the quality-gate skill.

Red lines:
- One baseline until v2.0: never stack a second migration file on this branch.
- Never point drizzle-kit or tests at a shared or v1 database.

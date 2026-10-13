---
name: add-db-table
description: >-
  Add or change a core Postgres table in Greenhouse: Drizzle schema, domain service, provider
  registration, generated migration, schema doc and DB tests. Use for 新增表 / 加个表 / 加字段 /
  改表结构 / 写个 service / 写迁移 / add a table / add a column / write a migration.
---

Rules live in packages/db/src/AGENTS.md; the current tables and relations are in packages/db/src/db-schema.md. Copy the push-devices slice: packages/db/src/schema/push-device.ts, packages/db/src/services/push-devices.ts and tests/db/push-devices.db.test.ts.

Before you start:
- Check the feature's row in docs/product/features.md; never extend a module marked 删除 or 合并.
- A private or optional module keeps its tables in its extension's migration lane (EXTENDING.md), never in core.
- Read db-schema.md and extend an existing table when you can; a second table for the same job needs a recorded reason in the owning AGENTS.md.

Steps:
1. Define the table in `packages/db/src/schema/<domain>.ts` with explicit indexes and an exported row type.
2. Export a new schema file from packages/db/src/schema/index.ts.
3. Write `createXxxService(db: Db)` in `packages/db/src/services/<domain>.ts`, with its input types in the same file.
4. Register the service in createDatabase() in packages/db/src/provider.ts.
5. Re-export it from packages/db/src/index.ts: `export * from './services/<domain>.js'`.
6. From the repo root run `pnpm drizzle-kit generate`.
7. Read the generated SQL in drizzle/ and fix what the generator gets wrong: renames emitted as drop and add, NOT NULL without a default on a filled table, casts without USING, missing backfills.
8. Migrate your own databases only: `pnpm run-dev up` migrates a worktree's database; for tests run `DATABASE_URL=<test database url> npx drizzle-kit migrate`.
9. Update packages/db/src/db-schema.md: purpose, columns, relations, FK or logical link.
10. Add `tests/db/<domain>.db.test.ts`; create users with tests/helpers/internal-user.ts.
11. If the demo dataset should carry the table, add `data/examples/<table>.json` and its LOAD_ORDER entry in apps/api/src/cli/commands/seed.ts.
12. Run the quality-gate skill (`pnpm test:db` while iterating).
13. If the change ships or removes a feature, set its row in docs/product/features.md (status and PR) in the same PR.

Red lines:
- Never `drizzle-kit push` to a shared or persistent database, and never run migrate without an explicit DATABASE_URL: drizzle.config.ts falls back to the main local database.
- Edit only your own unmerged migration. After a rebase brings in new ones, delete yours and generate it again.

v2: the v2 branch starts from a fresh schema baseline (docs/product/roadmap.md M0); on main keep extending the current chain.

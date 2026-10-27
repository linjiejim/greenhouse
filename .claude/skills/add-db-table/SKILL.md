---
name: add-db-table
description: >-
  在 greenhouse 里新增一张数据库表的完整链路：schema 定义（_columns helper + ids 前缀）→ 域 service →
  provider 注册 → drizzle-kit generate 迁移 → pnpm db:migrate → db-schema.md → *.db.test.ts。用户说新增表、加个表、建张表、
  加字段要迁移、写个 service 时使用。核心红线：事实源是 migrate 不是 push；没有接口层/
  Repository 类；类型全部推导。
---

# 新增数据库表

> 规范事实源是 [packages/db/src/AGENTS.md](../../../packages/db/src/AGENTS.md)，
> 现有表结构与 ER 图在 [packages/db/src/db-schema.md](../../../packages/db/src/db-schema.md)。
> 本技能只负责**顺序**和**联动点**，规则细节以那两份为准，冲突时以它们为准。

## 前置判断

1. **这张表属于 core 还是 extension？**
   私有 / 可选 / 实验性模块的表不要进 core schema——走扩展缝
<<<<<<< HEAD
   （`apps/api/src/plugin-host/<id>/` 的 `schema.ts` + `migrations/` + `services`，
   见 [EXTENDING.md](../../../EXTENDING.md)）。core DDL 只住仓库根 `drizzle/`。
   参考实现 `apps/api/src/plugin-host/example/`。
=======
   （`apps/api/src/extensions/<id>/` 的 `schema.ts` + `migrations/` + `services`，
   见 [EXTENDING.md](../../../EXTENDING.md)）。core DDL 只住 `packages/db/migrations/`。
   参考实现 `apps/api/src/extensions/example/`。
>>>>>>> worktree-agent-a63b76eaf5cc18e37
2. **能不能不加表？** 根 AGENTS.md 的「Delete & reuse discipline」要求先确认现有表无法复用或扩展；
   加"第二张做同一件事的表"必须在 AGENTS.md 里登记理由。
3. 读 `db-schema.md` 确认与既有表的关系（FK 还是逻辑关联）。

## 步骤 1：Schema

在 `packages/db/src/schema/<域>.ts` 新建或编辑（每个领域一个文件），并在
`packages/db/src/schema/index.ts` 导出。

- `drizzle-orm/pg-core` 的 `pgTable()`，列用 `schema/_columns.ts` 的 helper，并更新文件头的表清单
- 主键 `id()`（text）；在 `packages/db/src/ids.ts` 的 `ID_PREFIX` 登记三字母前缀，service 写入时 `newId(kind)`
- 时间点 `at()`；`created_at` / `updated_at` 用 `createdAt()` / `updatedAt()`（`NOT NULL DEFAULT now()`）
- 业务日期 `day()`（`date`）
- JSON `json(name, fallback)`（`jsonb NOT NULL`），只有 null 有含义才 `jsonOrNull()`
- 枚举 `text('col', { enum: VALUES })` + `oneOf('chk_<表>_<列>', col, VALUES)`（CHECK 约束）
- 浮点 `doublePrecision()`；计数 / 金额 `bigint({ mode: 'number' })`
- **所有表必须显式定义索引**；不按 `id` 排序（ULID 与搬来的旧 id 混排），用 `created_at` 等
- 外键策略：域内强所有权用 `.references()` + `onDelete`；跨域松散关联（审计 / 日志 / 统计）
  不设 FK，只在 `db-schema.md` 记录逻辑关联

## 步骤 2：域 service

在 `packages/db/src/services/<域>.ts` 写 `createXxxService(db: Db)`（`Db` 来自 `client.ts`）。

- 返回对象字面量；对象内自调用用 `const service = {...}; return service;`（不要 `this`）
- **类型全部推导，禁止手写镜像**：行类型用 `$inferSelect`，union 别名 = `XxxRow['col']`
- Input / UpdateInput / ListOpts 等参数类型与 service 同文件定义，从包根 `@greenhouse/db` 重导出
- 复杂查询（FTS、聚合 + JOIN）用 Drizzle 的 `sql` 模板标签；`COUNT`/`SUM` 经 `execute()` 回来要 `Number()` 包
- 时间戳写入用 `@greenhouse/utils/date` 的 `nowIso()`
- jsonb：查询构建器读到的是对象；原生 `db.execute(sql…)` 读到的是文本——两种都用 `safeJsonParse` 读
- **禁止新增接口镜像 / repo 类 / 多后端抽象**——旧的「接口层 + Repository 类」2026-06 已删除，没有第二实现

## 步骤 3：注册到 provider

`packages/db/src/provider.ts`：import 该工厂 + 在返回对象里加一行。这是唯一的装配点，
`DatabaseProvider = ReturnType<typeof createDatabase>` 自动带上新 service。

## 步骤 4：迁移（**事实源是 migrate，永不 push**）

```bash
# 必须在仓库根目录运行——drizzle.config.ts 用相对路径
pnpm drizzle-kit generate   # 写进 packages/db/migrations/，相对 0000_v4_baseline 的快照生成 0001_* …
DATABASE_URL=<本地库> pnpm db:migrate   # 应用（3.x 库原地桥接；拒绝 1.x / 2.x 库）
```

- **review 生成的 SQL 再提交**，重点盯：类型转换缺 `USING`、给有数据的表加 `NOT NULL` 却没 `DEFAULT`、
  改列名被生成成 drop + add（会丢数据，需手改 `RENAME`）、需要数据回填的自己补 SQL
- 迁移文件连代码一起提交；CI / 部署跑 `pnpm db:migrate` 自动应用；不改 `0000_v4_baseline.sql`，不动 `migrations/archive-3x/`
- `push` **只**用于本地一次性 scratch 库；任何持久或共享库（含 CI 测试库）一律 `pnpm db:migrate`
- 高增长表在 `services/retention.ts` 定保留期；跑 `tests/db/schema-equivalence.db-commit.test.ts`（新装与 3.x 桥接后 schema 必须一致）

## 步骤 5：文档

更新 [packages/db/src/db-schema.md](../../../packages/db/src/db-schema.md)：表用途、字段简述、
ER 图、表关系总览（明确标 FK 还是逻辑关联）。这是根 AGENTS.md 里对 schema 变更的硬要求。

## 步骤 6：测试

DB 集成测试放 `tests/db/<域>.db.test.ts`（命名决定跑在哪个 vitest project）：

- 每条测试包在事务里自动回滚——**不要**自己 `resetSchema()` 或在 `beforeEach` 之外调 `initDatabase()`
- 内部测试用户用 [tests/helpers/internal-user.ts](../../../tests/helpers/internal-user.ts) 创建
- **断言只针对本测试造的行**：事务只藏自己的写入，全表 `count()` 仍看得见别的已提交数据
- 不写死 id：从 `create` 的返回值取（新 id 是 ULID）
- 只有多连接可见性 / DDL / 锁竞态才用 `*.db-commit.test.ts`，文件头必须写 `@db-commit-reason`

## 步骤 7：门禁

```bash
pnpm typecheck
pnpm lint
pnpm test:db      # 聚焦；落地前仍要跑完整 pnpm test
```

## 检查清单

- [ ] 判断过 core vs extension，且登记过"为什么不能复用现有表"
- [ ] schema 文件写好，`schema/index.ts` 已导出
- [ ] 列用 `_columns.ts` helper；索引与 CHECK 显式定义；`ids.ts` 登记了前缀
- [ ] 外键策略正确（域内 FK / 跨域逻辑关联）
- [ ] service 在 `services/`，工厂函数形态，类型全推导无手写镜像
- [ ] `provider.ts` 已注册
- [ ] `pnpm drizzle-kit generate` 在仓库根跑过，生成的 SQL 已 review 并提交；`pnpm db:migrate` 通过
- [ ] 想过保留期；schema-equivalence 测试通过
- [ ] `db-schema.md` 已更新
- [ ] `tests/db/*.db.test.ts` 覆盖，用 internal-user helper，无 `resetSchema()`
- [ ] typecheck + lint + test 通过

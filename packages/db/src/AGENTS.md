## 数据库规则

### 数据库：PostgreSQL
- 生产和开发环境均使用 PostgreSQL（通过 Docker）
- 连接字符串：`DATABASE_URL` 环境变量
- 默认值：`postgresql://greenhouse:greenhouse@localhost:5432/greenhouse`
- 本地：`docker compose up -d postgres`（绑定 `127.0.0.1:5432`，见仓库根 `docker-compose.yml`）

### Service 模式（旧"接口层 + Repository 类"已删除）
- 所有数据库操作通过 `getDb()` 返回的 `DatabaseProvider` 上的域 service：`db.users.getById(...)`、`db.knowledge.search(...)`
- 数据流向：业务逻辑 → `index.ts`（单例入口） → `provider.ts`（装配各域 service） → `services/<域>.ts`（实现）
- **类型全部推导，禁止手写镜像**：
  - `DatabaseProvider = ReturnType<typeof createDatabase>`（provider.ts）
  - Row 类型 = `typeof table.$inferSelect`，导出在对应 `schema/*.ts` 底部（如 `UserRow`）
  - string-union 列用 `text('col', { enum: [...] })` 标注（纯类型层，不产生迁移），union 别名 = `XxxRow['col']`
  - Input/UpdateInput/ListOpts 等参数类型与 service 同文件定义；一切类型从包根 `@greenhouse/db` 重导出
- service 是返回对象字面量的工厂函数 `createXxxService(db: Db)`（`Db` 来自 `client.ts`）；对象内自调用用 `const service = {...}; return service;` 模式（不要 `this`）
- 禁止在业务逻辑（API 路由、工具、CLI）中直接写 SQL
- 禁止新增接口镜像/repo 类/多后端抽象——没有第二实现（根 AGENTS.md「禁止预留抽象」）
- **`adminAnalytics` service（super 管理分析专用）的隐私铁律**：所有方法都是固定白名单列的聚合，**永不 SELECT** 消息内容、`sessions.title`（title 由对话生成，等同内容）、或 `llm_calls` 的 `input`/`output`/`system`。**不提供任意/原始查询方法**——super 只能看计数/token/时延/错误串，看不到任何用户（内部或外部）说了什么。扩展此 service 时保持该约束；隐私线锁定在 `tests/db/admin-analytics-repo.test.ts`。

### Fork 扩展点（下游私有表/service）
下游 fork 新增私有域（crm、drive…）时,**只改 `extensions.ts` 一个文件**,`provider.ts`/`client.ts`/schema barrel 与上游保持字节一致、合并不冲突。**上游本仓库为空**,guard 测试锁定。
- `extensions.ts` 导出 `createExtensionServices(db)` 与 `EXTENSION_RESET_TABLES`。`createDatabase()` 把前者 spread 进返回对象,后者拼进 `resetSchema` 表清单。
- 因为 `DatabaseProvider = ReturnType<typeof createDatabase>`,fork 在 `createExtensionServices` 里返回的 typed service 会**自动**并入 `DatabaseProvider` 类型 —— `db.crm.*` 全类型可用,无需动态注册抽象(正因如此不违反「禁止预留抽象」:fork 就是那个真实的第二消费者)。
- fork 的表是普通 Drizzle 表对象,service 用查询构建器 `db.select().from(crmTable)`(全仓库 service 均如此,无 `db.query.*` 关系型 API),故**无需**改 `client.ts` 的 schema 泛型。
- fork 的迁移走 fork 自己的 drizzle 命名空间(如 `drizzle-fork/`,时间戳前缀命名),**绝不**进本包的迁移链。

### ORM：Drizzle
- Schema 定义放在 `schema/` 目录（TypeScript，每个领域一个文件）
- Service 实现放在 `services/`，使用 Drizzle ORM API
- 驱动：`postgres`（postgres.js），通过 `drizzle-orm/postgres-js`
- 复杂查询（FTS、聚合 + JOIN）使用 Drizzle 的 `sql` 模板标签
- Drizzle 配置：项目根目录 `drizzle.config.ts`

### Schema 定义 (`schema/`)
- 每个领域有对应的 schema 文件：`user.ts`、`session.ts`、`knowledge-base.ts`、`project.ts` 等
- 通过 `schema/index.ts` 统一导出
- 使用 `drizzle-orm/pg-core` 的 `pgTable()`
- 时间戳字段使用 `timestamp('name', { withTimezone: true, mode: 'string' })`
- 所有表必须显式定义索引
- 自增主键使用 `serial('id').primaryKey()`
- 浮点字段使用 `doublePrecision()`

### Schema 迁移
- 配置与迁移产物在**仓库根目录**：`drizzle.config.ts` + `drizzle/`（不在 `packages/db/`）。
  config 用相对路径（`./packages/db/src/schema/index.ts`、`out: ./drizzle`），**必须在仓库根目录运行**。
  `pnpm --filter @greenhouse/db exec drizzle-kit ...` 会切到 `packages/db/` 导致路径解析失败。
- 新的 schema 变更：修改 `schema/*.ts`，然后在仓库根目录运行 `pnpm drizzle-kit generate`
- 添加迁移后更新 `db-schema.md`

#### push vs migrate —— 事实源是 migrate（**铁律**）
迁移文件（`generate` + `migrate`）是 schema 的**唯一事实源**。曾因 push/migrate 混用导致迁移链
名存实亡（16 张表无 `CREATE`、journal 与真实 schema 漂移），务必遵守：

- **任何持久 / 共享 / 生产库只准 `migrate`，永不 `push`。**
  同一个库**绝不能**"用 push 建、用 migrate 部署"——这正是漂移的根因。
- `push` 仅限**本地一次性 / scratch 库**（自己迭代、用完即弃）。碰共享或有数据的库一律不用。
- CI 的测试库（`greenhouse_test`）用 `migrate` 建（不是 push），这样**每个 PR 都会跑一遍迁移链**，坏链当场红。
- 改 schema 的标准动作：改 `schema/*.ts` → `drizzle-kit generate` → **review 生成的 SQL** → 连代码一起提交 →
  CI/部署 `migrate` 自动应用。
- **review 生成 SQL 时重点盯**（drizzle-kit 会生成会挂或丢数据的语句）：
  - 类型转换缺 `USING`（如 `text`→`timestamptz`，fresh migrate 直接报 "cannot be cast automatically"）；
  - 给有数据的表加 `NOT NULL` 但没 `DEFAULT`；
  - 改列名被当成 drop + add → **丢数据**（需手改为 `RENAME`）；
  - 需要数据回填的，自己在迁移文件里补 SQL。
- **禁止手写"假设表已存在"的迁移**（如 `ALTER TABLE x ...` 却从没 `CREATE TABLE x`）——这种只在 push 世界能跑，
  fresh migrate 必崩。需要建表就让 `generate` 生成，或手写完整 `CREATE TABLE`。
- drizzle-kit 0.31 的 `migrate` 会**吞掉报错**（spinner 盖住）只 `exit 1`；排查用 `CI=true` + 去 ANSI，
  或把 SQL 拼接后 `psql -v ON_ERROR_STOP=1` 跑，才能看到真正失败的语句。
- migrate 只比对 `__drizzle_migrations` 的 `max(created_at)`（**不校验 hash**）来决定应用哪些——
  给已 push 建好的库"补盖" journal 时，插入 `created_at = _journal.json 对应 when` 即可让 migrate no-op。

#### 快照（meta/）必须与 journal 同步
- `drizzle/meta/_journal.json` 的每个条目都必须有对应的 `drizzle/meta/NNNN_snapshot.json`。
  `drizzle-kit generate` 只拿**最新快照**与当前 schema 做 diff——快照落后会生成错误迁移
  （重复 ADD/DROP 已存在的列）。
- **手写 SQL 迁移**（数据回填、`ALTER ... IF NOT EXISTS`、`drizzle-kit push` 已改库但没生成迁移）
  同样要补一份快照，否则下次 `generate` 的基线就是旧的。
- 用 `pnpm drizzle-kit check` 校验 journal↔快照链（`id`/`prevId` 必须首尾相连）。
- **重建基线**（快照漂移修复，不动已应用的库）：
  1. 确认 `schema/*.ts` 是唯一真相，且与线上库一致；
  2. 用临时 config 把 schema `generate` 到一个空目录，得到一份完整的当前-schema 快照；
  3. 把它作为最新 journal 条目的 `NNNN_snapshot.json` 落回 `drizzle/meta/`，
     `id`=该迁移 tag、`prevId`=上一份快照的 `id`（早期快照用 uuid，近期用 tag 名，按 `id` 精确链接）；
     纯数据迁移的快照与上一份 schema 相同，只改 `id`/`prevId`；
  4. 运行 `pnpm drizzle-kit generate` 应输出 `No schema changes`，`drizzle-kit check` 应通过。

### Schema 文档
- 添加表、列、索引或关系时更新 [db-schema.md](./db-schema.md)
- 包含表用途和字段简述
- ER 图必须反映**所有**表关系：FK 约束和逻辑关联
- 明确标注 FK 与逻辑关系（`FK CASCADE`/`FK SET NULL` vs `逻辑: column_name`）
- 添加/删除 FK 约束或逻辑引用时更新"表关系总览"章节

### 外键策略
- **域内强所有权**（parent→child 如 project→task→comment）：使用 `.references()` + `onDelete: 'cascade'` 或 `'set null'`
- **跨域松散关联**（审计/日志/统计 → users/sessions）：不设 FK，仅在 db-schema.md 记录逻辑关联
- 原则：审计/日志/统计数据的生命周期必须独立于被引用实体

### 时间格式
- 所有 INSERT/UPDATE 的时间戳使用 `utils/date` 中的 `nowIso()`
- 时间戳字段使用 PostgreSQL 原生 `TIMESTAMPTZ` 类型（Drizzle `timestamp({ withTimezone: true, mode: 'string' })`）
- `mode: 'string'` 确保接口层仍然使用 ISO 8601 字符串，无需改变业务代码
- 日期字段（start_date、end_date、due_date）保持 TEXT 类型（存储 YYYY-MM-DD 格式）

### 全文搜索
- PostgreSQL 使用 `to_tsvector`/`to_tsquery` + GIN 索引（配置：`simple`，按词前缀匹配，不做词干化/停用词处理，对中英文一致）
- 权重：A=title，B=summary/questions，C=content/topics
- 查询策略：前缀匹配 `to_tsquery`（`word:* | word:*`，见 `services/fts.ts` 的 `buildPrefixTsQuery`）→ 无结果回退 `ILIKE`
- 知识库搜索按 scope/visibility/owner 隔离（团队/个人/共享），详见 `apps/api/src/profiles/agent-profiles.md`

### JSON-as-text 列策略（2026-06 C-3 评估结论）
- 所有"text 存 JSON"列（tags/meta/config/references_ 等 32 列）已在迁移 0004 补齐 **NOT NULL**（null 从无语义，写路径总提供值）；新增此类列必须 `notNull().default('[]'/'{}')`。
- **整列转 jsonb 暂缓**：postgres.js 对 jsonb 返回已解析对象、写入需对象而非字符串——切换意味着全部 service 写路径（JSON.stringify）与读路径（JSON.parse/safeJsonParse）成对改造 + wire 行为回归，收益（jsonb 索引/路径查询）目前没有真实查询需求支撑。若未来某列需要 jsonb 查询（如 metadata 过滤），按列单独迁移：`USING col::jsonb` + 该列全链路读写改造 + `.$type<T>()` 标注。
- 语义性 NULL 列（`messages.reasoning`、`knowledge_base._enriched_at`、`tasks.completed_at` 等"缺失即含义"）**保持可空**，不要顺手 NOT NULL。

### 数字类型转换
- PostgreSQL 通过 `execute()` 返回的 `COUNT(*)`、`SUM()` 等为字符串
- 使用原生 `execute()` SQL 时始终用 `Number()` 包装
- Drizzle 的查询构建器（`select().from()`）已自动处理

### 新增表流程
1. 在对应的 `schema/*.ts` 文件中添加表定义，并在文件底部导出 Row 类型（`typeof table.$inferSelect`）
2. 在 `services/` 中添加 `createXxxService(db: Db)` 工厂（参数类型同文件定义）
3. 在 `provider.ts` 的 `createDatabase()` 中注册一行
4. 在包根 `index.ts` 加 `export * from './services/xxx.js'`
5. 运行 `pnpm drizzle-kit generate` 生成迁移并 **review 生成的 SQL**（见上「push vs migrate」）；本地可 `migrate` 到 scratch 库自测，**不要 push 到共享/持久库**
6. 更新 `db-schema.md`

### Renumbering a migration (parked/conflicting PRs)

When two branches both generate the same migration number, the later one renumbers
to the next free slot. Renaming the `.sql` + snapshot is **not enough**: the drizzle
migrator replays entries by the journal `when` timestamp (skips anything ≤ the last
applied `created_at`). After renumbering, also bump that entry's `when` in
`drizzle/meta/_journal.json` past every earlier entry, or already-migrated databases
will silently skip it (fresh CI databases won't catch this).

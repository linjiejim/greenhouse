## 数据库规则

### 数据库：PostgreSQL

- 生产和开发环境均使用 PostgreSQL（通过 Docker）
- 连接字符串：`DATABASE_URL` 环境变量
- 默认值：`postgresql://greenhouse:greenhouse@localhost:5432/greenhouse`
- Docker：`docker compose up -d postgres`（仓库根 `docker-compose.yml`，绑定 `127.0.0.1:5432`）

### 数据库测试隔离

- 常规真实库测试统一命名 `*.db.test.ts(x)`，由 Vitest DB project 在每条测试外包一层事务并自动回滚；每个测试文件复用一个连接池，文件结束统一关闭，测试不要自行 `resetSchema()`、close 根连接或维护共享 singleton。
- `initDatabase()` 在 DB test worker 内会复用当前测试的事务 provider；此行为只由 `@greenhouse/db/test-config` 激活，生产运行不启用。**它必须在 `beforeEach` 里调**：事务由 setup 文件的 `beforeEach` 开启，而 `beforeAll` / 模块作用域跑在那之前，此时 `getActiveTestTransactionProvider()` 为 null，`initDatabase()` 会自建连接池——那条路径上的写入全部**提交**，回滚隔离形同虚设。
- **断言只能针对本测试造的行**：事务只把自己的写入藏起来，反过来不成立——`count()` / `list()` 这类全表读仍看得见任何其它连接已提交的数据（含并行的第二个测试进程）。用唯一 scope 过滤或取增量，别写「全表恰好 N 行」。`user-repo.db.test.ts` 曾断言 `count()===0`，被上一轮残留的 4 行提交态用户打成假红。
- service 内部再开 transaction 时必须兼容 Drizzle savepoint；不要绕开 provider 另建连接，否则写入不会被测试事务回滚。
- PostgreSQL sequence 是非事务的：测试不得假设首条记录 ID 为 1，也不得用固定 ID 更新/删除。
- 只有多连接提交可见性、DDL、连接级锁/竞态等无法在单事务内验证的行为，才使用 `*.db-commit.test.ts(x)`；文件头必须写 `@db-commit-reason`。该层串行；各测试必须用每次运行唯一的业务键、只做最小定向清理且不能依赖全局计数，禁止整库 `resetSchema()`。
- project 启动时的全库清理是唯一共享 baseline reset。Platform manifests、protected roles 和 baseline policies 在 global setup 提交一次作为不可变基线；每条测试仍须在自己的事务内创建用户，并通过 `tests/helpers/internal-user.ts` 直接绑定 baseline role。`syncLegacyRoleBinding()` 留给确实验证历史角色切换/协调的测试，不作为新用户 fixture。其它昂贵且只读的公共 seed 才考虑放 global setup，可变数据按场景惰性创建，只包含当前断言需要的最小 actor、关系和字段。
- `TEST_DATABASE_URL` 必须指向本机、库名含 `test`/`e2e` 的一次性数据库；多 worktree 使用独立 `greenhouse_test_<slug>`，不得复用 dev/共享库。

### Service 模式（2026-06 起；旧"接口层 + Repository 类"已删除）

- 所有数据库操作通过 `getDb()` 返回的 `DatabaseProvider` 上的域 service：`db.users.getById(...)`、`db.knowledgeBase.search(...)`
- 数据流向：业务逻辑 → `index.ts`（单例入口） → `provider.ts`（装配全部域 service） → `services/<域>.ts`（实现）
- **类型全部推导，禁止手写镜像**：
  - `DatabaseProvider = ReturnType<typeof createDatabase>`（provider.ts）
  - Row 类型 = `typeof table.$inferSelect`，导出在对应 `schema/*.ts` 底部（如 `UserRow`）
  - string-union 列用 `text('col', { enum: [...] })` 标注（纯类型层，不产生迁移），union 别名 = `XxxRow['col']`
  - Input/UpdateInput/ListOpts 等参数类型与 service 同文件定义；一切类型从包根 `@greenhouse/db` 重导出
- service 是返回对象字面量的工厂函数 `createXxxService(db: Db)`（`Db` 来自 `client.ts`）；对象内自调用用 `const service = {...}; return service;` 模式（不要 `this`）
- 禁止在业务逻辑（API 路由、工具、CLI）中直接写 SQL
- 禁止新增接口镜像/repo 类/多后端抽象——没有第二实现（根 AGENTS.md「禁止预留抽象」）

### ORM：Drizzle

- Schema 定义放在 `schema/` 目录（TypeScript，每个领域一个文件）
- Service 实现放在 `services/`，使用 Drizzle ORM API
- 驱动：`postgres`（postgres.js），通过 `drizzle-orm/postgres-js`
- 复杂查询（FTS、聚合 + JOIN）使用 Drizzle 的 `sql` 模板标签
- Drizzle 配置：项目根目录 `drizzle.config.ts`

### Schema 定义 (`schema/`)

- 每个领域有对应的 schema 文件：`knowledge-base.ts`、`session.ts`、`project.ts` 等
- 通过 `schema/index.ts` 统一导出
- 使用 `drizzle-orm/pg-core` 的 `pgTable()`
- 时间戳字段使用 `timestamp('name', { withTimezone: true, mode: 'string' })`
- 所有表必须显式定义索引
- 自增主键使用 `serial('id').primaryKey()`
- 浮点字段使用 `doublePrecision()`

### 内部身份与 Profile 不变量

- 有效账号角色只有 `team` 与 `super`。`users.role` 中的 `external` 仅为历史数据兼容值；这类账号必须为 `disabled`，且中央鉴权必须拒绝其 access/refresh token。
- `users.auth_version` 是账号凭证代数，`refresh_tokens.auth_version` 记录签发代数。密码重置必须通过 `users.resetPasswordAndRevokeSessions()` 在同一事务内更新密码、递增代数并删除全部 refresh token；access/refresh/WebSocket 使用时都要与当前用户代数比对，禁止退回“只删 refresh token”的非原子实现。
- 邮件设密不是 Magic Link：`account_password_links` 只存 32-byte 随机 token 的 SHA-256 hash。签发、重发、撤销、消费与账号禁用统一先锁 `users` 再锁链接；消费必须在同一事务内校验用途/状态/过期/代数并完成写密码、激活、代数递增、Refresh Token 撤销。重置签发本身就把账号置为 `reset_required`、密码改为不可登录哨兵并撤销旧会话；撤销链接不得恢复旧密码。
- 会话、评测、定时任务和自定义 Profile 的内置基础 Profile 统一为 `team`；数据库默认值不得再写入已退役的外部服务 Profile id。
- MCP、LLM Relay 与其他内部集成必须最终绑定真实内部用户。审计表可用松散关联保留历史，但新写入的主体不能是匿名/访客身份。
- `api_audit_log.channel='api'` 仅用于读取迁移前历史审计；新写入类型必须显式排除它，只允许内部 `a2a` / `cli` / `relay`。
- 已移除模块对应的表不得以兼容、占位或“未来可能使用”为由重新加入；确有新消费者时按根 AGENTS.md 的复用门禁重新设计。

### Schema 迁移

- 配置与迁移产物在**仓库根目录**：`drizzle.config.ts` + `drizzle/`（不在 `packages/db/`）。
  config 用相对路径（`./packages/db/src/schema/index.ts`、`out: ./drizzle`），**必须在仓库根目录运行**。
  `pnpm --filter @greenhouse/db exec drizzle-kit ...` 会切到 `packages/db/` 导致路径解析失败。
- 新的 schema 变更：修改 `schema/*.ts`，然后在仓库根目录运行 `pnpm drizzle-kit generate`
- 添加迁移后更新 `db-schema.md`

#### push vs migrate —— 事实源是 migrate（**铁律**）

迁移文件（`generate` + `migrate`）是 schema 的**唯一事实源**。曾因 push/migrate 混用导致迁移链
名存实亡（16 张表无 `CREATE`、journal 与真实 schema 漂移），务必遵守：

- **任何持久 / 共享数据库（任何有数据的库）只准 `migrate`，永不 `push`。**
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
- **进程内迁移 `applyCoreMigrations()`（`core-migrations.ts`）**：API 的 `MIGRATE_ON_START=1` 走它——给跑不了
  compose 一次性 `migrate` 服务的宿主（Railway、单容器）。就是 drizzle 自己的 migrator（同一张 journal 表、同一条
  判定）外加一把会话级 advisory lock（独立单连接客户端），多副本同时启动只有一个真正执行；与 `drizzle-kit migrate`
  在同一个库上可以互换。仍然只应用 `drizzle/` 里已提交的链——它不是 push，也不生成任何 DDL。

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

`knowledge_base` 用 `to_tsvector`/`to_tsquery` + GIN 表达式索引。**FTS 索引由迁移链持有**（drizzle DSL 不追踪表达式索引，所以是 `drizzle-kit generate --custom` 手写的 `0013_kb_fts_index`；此前两个月的 FTS 一直全表扫），运行时不建索引、无 `ensureFtsIndex`。表达式必须与 `services/knowledge-base.ts` 的 `weightedTsVector` 逐字一致，否则 planner 不用它。实现在 `services/fts.ts` + `services/knowledge-base.ts`。

- **jieba 分词列**:各表 `_tokens_a/b/c`(`@node-rs/jieba` napi 预编译,无 build 脚本/不进 allowBuilds),写路径(create/update/upsert)与 `updateKeywordsEn`/`updateEnrichment` 每次重算;索引 `idx_kb_fts_seg`。配置 `simple`(分词已在应用层做,PG 只按空格切)
- 权重:kb A=title+tags / B=\_summary+\_questions / C=content+\_topics
- **查询侧同款分词**:`segmentForFts(query)` → `buildSegmentedTsQuery`(单中文字如「低」不被丢弃),三级策略 AND→OR→ILIKE;**存储与查询必须走同一 `segmentForFts`,否则 token 不对齐**
- **CJK snippet**:`ts_headline` 对分词列与原文不对齐,改 `buildSnippet`(应用层按首个命中 token 截原文);拉丁词才继续用 `ts_headline`
- **回填**:迁移只加空列,存量行由启动时的 `backfillKnowledgeTokens`（`apps/api/src/knowledge/backfill.ts`）自动补齐,也可 `pnpm cli knowledge reindex` 手动重算;之后写路径保持同步
- **AND 命中不足时用 OR 补位,不是「首个非空 pass 即返回」**(2026-08-14):旧写法让一条平庸的 AND 命中挡住整个 OR
  候选集。现在两个 pass 都跑,AND 结果排前、OR 按 id 去重填满剩余名额,仍不够才回退 ILIKE。`search` 与 `searchShared`
  两处同款,改一处必须改另一处。
- **`KnowledgeSearchOpts.folderIds` / `KnowledgeListOpts.folderIds` 是收窄语义**:`undefined`=不限目录,
  **空数组=匹配零行**(`folderFilter` 的 `AND false`)。写成「空数组即不过滤」会让一次限定到空目录的检索静默返回全库。
  调用方传的是已展开的子树 id 集合(`kbFolderSubtreeIds`)。
- **检索结果带 `folder_id`**:四条 SQL(`search`/`searchShared`/`searchLike`/`searchSharedLike`)都要 SELECT 它,
  工具层据此批量渲染目录路径。少一处就会让那条降级路径的结果行悄悄没有目录。

### 用户记忆与踩坑信号表

方案见 [memory v2 spec](../../../docs/specs/20260804-memory-v2.md)。两张表语义相反：`user_memories` 是 per-user 且会进 prompt，`tool_frictions` 是团队级且**永不进 prompt**。

- **`user_memories` 的生命周期是状态机，`status` 才是真相**：`active`（在注入索引里）→ `dormant`（90 天未用，掉出索引但仍可搜、被 recall 自动转回）→ `archived`（用户或 consolidation 退役）/ `superseded`（被合并取代，`superseded_by` 自引用指向取代者，FK SET NULL）。**service 层任何路径都不物理删**——`delete()` 只为用户在设置页的手动删除保留，consolidation 与衰减一律走 `setStatus`。写查询时按 `status` 过滤，别假设「表里有的就是生效的」。
- **`last_used_at` 只在真实使用时刷新**（`touch()`，即 recall/update），**注入不算使用**。写新调用点时不要顺手 touch：那会让 `demoteStale` 永远筛不出东西，衰减静默失效。排序统一用 `coalesce(last_used_at, created_at)`（service 里的 `lastTouched`）。
- **`title` 是召回索引不是摘要**：只有它会进 system prompt，正文靠工具按需取。加字段时别把正文塞进注入路径。
- **`search()` 用裸 `ILIKE`，是刻意不接既有那两条 FTS 检索线的**（登记「新功能先查既有实现」）：memory 正文按 spec D11 强制英文，jieba 分词那条线买不到任何东西；每用户的记忆是几十行量级，seq scan 比维护第三份 tsvector 索引便宜。规模或语言约束一旦变，这条理由就失效，届时应扩 `segmentForFts` 那条线而不是再造第三套。
- **`sessionReferencesImage()` 是鉴权查询，不是便利查询**：图片没有 `chat_files` 行（走公开读的 `/api/upload/:id`，因为 `<img src>` 带不了 Bearer），所以「这张图属不属于这个会话」只能问转录——用户上传落 `messages.images`、生成图落 assistant `pipeline`。id 由模型给出，没有这道会话边界，一个从别处抄来的 id 就能把别人会话里的图发出去。它按 `position()` 在原始 text 列上做子串匹配：id 是服务端生成的 `时间戳-uuid`，同一会话内不可能撞车。唯一消费者是 `apps/api/src/files/conversation-files.ts`。
- **`tool_frictions.fingerprint` 的唯一索引就是聚合契约**：同一个坑必须落到同一行、`occurrence_count` 累加，指纹算法（`apps/api/src/frictions/friction-center.ts`）改动会让历史行与新行分裂成两条，等于把优先级信号打散——改之前先想清楚是否需要迁移存量指纹。`sample_sessions` 是逻辑引用、**刻意无 FK**（运维遥测必须比它引用的会话活得久）。
- **`record()` 必须是单条 `onConflictDoUpdate`，不许退回「先查后插」**：这张表有两个并发写入者（凌晨挖掘器批量扫 + 聊天里实时 `log_friction`），先查后插会让后手撞 23505，而两个调用方都吞异常 → 这次踩坑**静默消失**，计数偏低、排序失真。样本集的「去重 + 取最新 5 条」也在同一条 SQL 里算（读的就是它要更新的那一行），这依赖 `sample_sessions` 恒为合法 JSON 数组——该列 NOT NULL DEFAULT `'[]'` 且只有这一个写入者。回归测试在 `tests/db/tool-frictions.db.test.ts`（并发那条在旧实现下必红）。`scanToolErrors` 会跳过 pipeline 里含 `\u0000` 转义的行——PG 的 jsonb 存不了 NUL，一条被污染的消息就能让整轮挖掘抛「unsupported Unicode escape sequence」（2026-08-11 实测），写入端（extract-text）已不再产 NUL，这道 SQL 侧防御管的是存量行与未来的其它写入者。

### Bots 表（个人助理）

方案见 [Bots spec](../../../docs/specs/20261005-personal-assistant-bots.md)。

- **记忆作用域是必填参数**：`user_memories.bot_id` 为 null 是用户级、非空是某个 Bot 私有。`listForIndex` / `search` / `getOwnedInScope` 都**必须**传 `MemoryScope`——`{ botId: null }` 只读用户级（普通对话、定时任务、subagent、workflow、飞书都这么传），`{ botId }` 读用户级 + 该 Bot，`{ botId, exact: true }` 只读一个分区（整理、管理）。把 scope 做成可选会让每个旧调用方把所有 Bot 的私有记忆注入进普通对话；按 id 查一定走 `getOwnedInScope`，否则 Bot A 能凭递增 id 打开 Bot B 的私有记忆。consolidation 按 `(user_id, bot_id)` 分区跑，替换行继承 `bot_id`。
- **Bots 对话只有一个写者**：持有该会话 ChatRun 的引擎。服务端在对话进行中产生的东西（交还事件、续跑、后台汇报、忙时插话）一律进 `bot_inbox`，不要直接 `addMessage`——任何半路插入的行都会让进行中回合的 tail-CAS 失败、它刚流式展示的回答在刷新后消失。引擎自己的多行写入用 `sessions.appendIfTail`（角色通用的尾 CAS），每写一行推进 expected tail。
- **`bot_computers` 的每次状态迁移都是 `version` CAS**，单用户的 start/stop/evict 在 `withUserLock`、容量判断在 `withCapacityLock` 里做——蓝绿两个 API 槽位共享同一个 Docker daemon 和这张表，进程内状态不能当事实。接管租约的 `lease_epoch` 单调递增：观察（快照/截图）返回前要复核 epoch，变了就丢弃。
- **密码库只存密文、只回元数据**：service 原样存取 `*_enc` 列，加解密（AAD=`vault:<user_id>:<item_id>:<field>`）在 API 的 vault 模块里做；HTTP 与工具的读路径只返回 `VaultItemView`。新 id 先用 `newVaultItemId()` 生成再加密（id 是 AAD 的一部分）。
- **群聊已退役（2026-10-09，迁移 `0015_bots_groups_retired`，纯数据、不删行不删列）**：service 不再建群（无
  `createGroupConversation` / `updateConversation` / 负责人接替），`addMember` 只加 guest，对 `kind = 'group'` 的对话
  `addMember` / `removeMember` 抛 `BotsDomainError('group_closed')`；迁移把群里仍待处理的 `bot_requests` 置 `canceled`
  （`result = {"decision":"group_closed"}`）、`allow_bot_chat` 全置 true（列保留，无人读取）。
- `bot_requests` 只经 `settleRequest` 从 pending 单次 CAS 结算（双击、两个槽位竞争都只有一个赢家）；`payload` 只放服务端派生的展示/执行数据，**永不放秘密**（安全登录卡的输入值只经过一次请求体，不落库）。效果要跑一阵的决定（`tables_plan`：先结算成 `resolved` 领取、再应用计划）用 `updateRequestResult` 把结果写回——它只改**已是 `resolved`** 的行的 `result`，绝不重开或改判。`kind` 是只在 TS 里的枚举（无 CHECK 约束），加种类不需要迁移。
- **Bot 私有参考资料夹**（`drive_folders.bot_id`，2026-10-07）：每 Bot 至多一个根文件夹，CHECK 约束要求它是 `scope='kb'` + `visibility='private'` + 有 owner 的个人文件夹；随 Bot 级联删除。读侧只新增**排除**：`KnowledgeListOpts` / `KnowledgeSearchOpts` 的 `excludeFolderIds`（`AND (folder_id IS NULL OR folder_id NOT IN …)`，四个 SQL 变体与 `kbTree` 同步），空数组 = 不排除。排除集由 `apps/api/src/bots/folder.ts` 按身份算，HTTP 路由（主人自己）不传。

### 邮箱绑定与发信审计

方案见 [email 复活 spec](../../../docs/specs/20260805-email-revival.md)。

- **`email_accounts` 只有密码是密文，连接配置是明文列**。被删的 0.18.0 版本把整个凭证对象 JSON 序列化后整体加密，结果是任何一次「这个账号连的是哪台服务器」的排查都要先解密，而 host/port 本来就不是秘密。加/改列时保持这条边界：**只有真正的凭证进 `password_encrypted`**（AES-256-GCM，`PROVIDER_TOKEN_ENCRYPTION_KEY`，与 `user_provider_tokens.provider_credential` 同一把钥匙）。
- **共享的 greenhouse@ 邮箱不在这张表里，将来也别加进来**。它是运维所有物：生命周期与任何用户无关，凭证是系统的（与厂商 LLM key 同类，env 是既有惯例）。塞进 per-user 表只有两条路——伪造一个 owner，或让 `user_id` 可空；后者正是 `knowledge_base.user_id` 唯一索引事故的形状。
- **`mcp_servers` 沿用同一条边界**：只有共享凭据的**值**进 `auth_value_encrypted`、实例的 OAuth 客户端进 `oauth_client_encrypted`（同一把钥匙），URL（永不含凭据——query 参数里的 key 调用时才拼上）/ 传输方式 / 头名 / 参数名 / 鉴权方式都是明文列；成员自己的连接不在这张表，在 `user_provider_tokens`（`provider='mcp:<id>'`，key 约定只在 `services/mcp-servers.ts`），密文带 AAD 绑定所在行与字段；`tools` 是服务器宣告的工具**缓存**（jsonb），失败的刷新只写 `last_error`、不清空上一次成功的工具表——一台抖动的服务器继续按最后已知的工具工作。`created_by` 是 SET NULL：登记人离职不该带走全队在用的集成。
- **`email_send_log` 刻意不设 FK**（既不指 `email_accounts` 也不指 `users`/`scheduled_tasks`）：它同时是审计与日限计数源，必须比它描述的绑定、任务甚至账号活得久。这与「审计/日志的生命周期独立于被引用实体」的既有 FK 策略一致。
- **日限只数 `status='sent'`**。失败的发送没消耗服务商配额，把它计入会让一个配错的账号顺带锁死用户当天还能用的其它邮箱。
- `preset` 是 UI 提示，**不参与任何代码分支**——真正决定行为的是 host/port/`use_proxy` 那几列。新增服务商预设改 `@greenhouse/types/email` 的表即可，不需要动 schema。

### 知识库组织与协作表(KB v2,迁移链–0028)

- `knowledge_base.folder_id` → `drive_folders(id)` **ON DELETE SET NULL**:文档归属 kb 目录(null=根)。**文档永不因目录操作被删**;`drive.deleteFolder` 在 kb 域额外拒绝仍挂着非归档文档的目录(与子目录/活文件同等对待)。空间(`meta.space`)是历史组织维度,`pnpm cli knowledge migrate-spaces` 折叠进目录后仅作「未归目录」兜底;**2026-08-11 起没有任何写入方**——编辑器表单已删掉该字段,create 时服务端兜的 `'general'` 只为历史读者保留,别再把它当可用的分组维度。
- 目录改名/移动走 `drive.updateFolder(id, {name?, parent_id?})`:**把目录移进自己或自己的后代返回 `{ok:false, reason:'cycle'}`**(祖先链上溯,64 层封顶)——否则整棵子树会脱离根变成不可达环。service 只管数据,scope/可见性/归属的跨域校验在路由层(`PUT /api/drive/folders/:id`)。
- `kb_links{from_doc_id,to_doc_id}`(两端 CASCADE,unique(from,to)):出链在每次保存时由 `rebuildOutlinks(id, markdown)` 全量重建——扫描正文里的规范链接 `#/knowledge/doc/<id>`。反链读反方向,**必须逐条过 `resolveKbAccess`**(否则私有文档标题会经反链列表泄露)。
- `kb_comments`(软删 `deleted_at`):文档级评论,读权限跟随文档。**不进 FTS / `knowledge_query` / `/search`**(spec D10)——讨论不是知识。
- `knowledge_base.is_template`:显式布尔(不塞 meta JSON),`listTemplates()` 只列 team 可见模板。
- 编辑态 presence 是**进程内存**(`apps/api/src/knowledge/presence.ts`,90s TTL),无表;与 `ws/connection-manager.ts` 的全局在线态是两回事。

### 侧栏树的手动排序列

- `knowledge_base.sort_order` 与 `drive_folders.sort_order`（都是 `integer NOT NULL DEFAULT 0`）。**0 = 从没手工排过**，读侧把 0 排在最后、其余按数值升序、同值按名称——所以全 0 的目录就是字母序，加列对存量与 crm/tables 两个 drive scope 是零行为变化。
- `drive.listFolders` 的 `orderBy` 已改成 `(sort_order, name)`，它同时服务 kb/tables 两个 scope；后者永远是 0，拿到的仍是字母序。
- 写入只有 `reorderFolders(ids)` / `reorderDocs(ids)`：一条 `UPDATE … FROM (VALUES …)` 把整组同级写成 1..n，**单语句即原子**，不要退回逐条 update 循环（那会让并发排序写出交错的顺序）。service 不做鉴权也不校验「是否真是同级」——两者都在路由层（见 api AGENTS「知识库侧栏树的排序与整库导出」）。

### Tables 地基：作用域、写入元信息、唯一编译器（2026-10-11，迁移 0023）

方案见 [Tables 地基 spec](../../../docs/specs/20261011-tables-foundation.md)。服务按域拆在 `services/tables/<domain>.ts`（`index.ts` 组合；模块表见其文件头），**不要再把逻辑塞回一个大文件**，也不要在模块外复制 `query.ts` 的谓词逻辑。

- **作用域与写入元信息是必填参数**：`getRecord / queryRecords / recordQueryParts / aggregateRecords / listDeletedRecords / validateBatchRecords` 带 `scope: TableAccessScope`，`createRecord / updateRecord / deleteRecord / restoreRecord / batchUpsertRecords / submitForm` 还带 `meta: TableRecordWriteMeta`（`created_by / updated_by` 取 `meta.actorId`）。内置角色、自动化、导入、重算传 `fullTableAccess(userId | null)`。照 Bots 记忆 scope 的先例：可选就等于「忘了传 = 全量」。守卫测试 `services/tables/__tests__/scope-guard.test.ts` 在类型层（`pnpm typecheck` 会编译它）钉住，**新增记录方法要加进那张表**。
- **scoped 作用域由 service 执行，不靠调用方**：读范围、改 / 删 / 恢复要在 `rows ∧ editRows` 内、只认可编辑字段的键（`TablesValidationError` code `field_not_editable`，与 `create_forbidden` / `delete_forbidden` 一起由 API 映射成 403——`isTablesForbiddenError`）、`required` 只对可编辑字段生效（D3）、范围外的 id 与不存在相同（not found）。返回的仍是整行，给 scoped 读者之前用 `projectTableRecord(row, scope)` 裁剪 `values` 与 `computed_values`。
- **scoped 写入者的关联与附件（D14 / D15，`records.ts` 的 `assertScopedWriteTargets`，create / update / batch validate 都走）**：只看「本字段新增的 id」（记录里该字段已有的值照收，改别的字段不会被别人建的链接卡住）。新关联 id 必须是目标表上、落在 `scope.relationTargets` 读范围内的活记录——目标表不在列表里就一个都不收（编译器同时把这种关联字段降为只读）；新附件 id 必须是 `uploaded_by = scope.userId`、本 Base、active、且**没挂在任何其他记录上**的文件。拒绝消息与「不存在」的通用消息完全相同（不做存在性神谕）。full 作用域（内置角色、自动化、导入）不受这两条约束——它们本来就读得到全部行与文件。导入（切片 I）、表单（Fm）与阶段 1 应用网关给受限写入者构造 scoped 作用域即自动生效，别另写一份。
- **自定义角色、群组授权、团队默认、所有者转移只在 `roles.ts`**（存取，不判定）：`deleteBaseRole` 先 `FOR UPDATE` 锁角色行再数引用（成员行 / 群组行 / `team_custom_role_id`），有引用返回 `in_use` + 计数（API 映射 409 `role_in_use`）——并发的引用插入会卡在外键检查上，计数不会过期；群组授权只经 `group_members` 行触达个人（群组创建者不算成员）；`transferBaseOwner` 在一个事务里改 `owner_id`、把新所有者的成员行写成 `owner`、旧所有者的行改成 `previousOwnerRole` 或删除（**任何人的成员行写着 `owner` 就会被判成 owner**，所以两行必须一起改）；`loadAccessFacts(baseId)` 给编译器（`compileTableAccessScope`）与规则编辑器同一份事实（活表、活字段含关联目标、`table_field_dependencies` 边）。规则形状由 API 用 `normalizeAccessRules` 校验后才存，db 不再校验。`listBasesForUser` 的候选含群组 EXISTS，层级仍由 API 解析。
- **唯一的 SQL 编译器是 `services/tables/query.ts`**：视图、查询、仪表盘筛选、自动化条件、自定义角色的行范围（阶段 1 的应用角色）都走它。系统字段（`created_by/created_at/updated_at/updated_by`）可用于筛选 / 排序 / 分组；`$me` 只在人员子句里展开（取 `scope.userId`，null = 什么都不匹配）、日期令牌只在日期子句里展开（按 `TableQueryEvaluation.timeZone`，日期型值作用于 datetime 时表示「当地那一整天」；每个面向查看者的入口都要把查看者时区带进来——记录查询 `POST …/records/query` 的 body 带 `timezone`，分组计数走聚合输入的 `timezone`，仪表盘走 `queryDashboardWidget`，否则同一谓词在列表与计数里会落在不同的「今天」），别处一律是字面文本。**行范围 fail closed**：缺失 / 已归档 / 类型不对的字段、空的 where、畸形的范围都编译成 FALSE，绝不「丢掉这个条件」。scoped 读者引用的每个字段（where、filters、sort、groupBy、聚合的值 / 分组 / 系列）必须可读，否则 `field_not_readable`（消息与「不存在」相同，不做存在性神谕）；搜索只覆盖可读的文本字段。查询指纹（游标）包含 filters、groupBy 与 scope。
- **写入在一个事务里**：行、关联 / 附件边、计算值（`computeRecordValues(tx, …)`）、`onRecordWritten(tx, {kind, tableId, recordId, revision, before, after, meta, previous?})` 一起提交或回滚。`onRecordWritten` 是**唯一的写后钩子**：追加 `table_record_events`（字段级、值截断；什么都没变的 update 不追加）并调用 `enqueueAutomationEvents`（见下条）。重算与汇总级联（`recomputeRecord` / `refreshDependentRollups`）是维护写，**不产生事件、不触发自动化**；`refreshDependentRollups` 仍在提交后跑。
- **自动化只在写事务里入队，执行在 API**（切片 Au，迁移 0024）：`enqueueAutomationEvents(tx, event)` 只处理 `meta.enqueueAutomations` 的 create / update（导入与自动化自己的写不入队，D6），对该表启用的规则用**同一个 SQL 编译器**求条件（`$me` = 写入者，日期令牌按规则的时区）：`record_created` = 写后满足；`record_updated` = 写后满足且 `watchFieldIds` 里有字段变化（未设 = 任一字段变化）；`record_matched` = 写后满足且写前不满足（写前镜像是一张别名为 `table_records` 的单行派生表：before 值 + 不变的创建列 + `event.previous` 的 updated_*；新建记录视为写前不满足）。命中就插一行 outbox：`rule_revision` + 归一化后的 `actions` 快照 + `cursor`（第一个动作 id），幂等键 `rule:<id>:<trigger>:<recordId>:<revision>`。**db 层从不执行规则**（同步执行器、`canUserEditBase`、`table_notifications` 的读写方法都已删除）；worker / 扫描 / 按钮所需的租约、检查点、运行行与「哪些到期」查询在 `services/tables/automation-queue.ts`（照 `notification_delivery_attempts`：SKIP LOCKED + `version` CAS；`attempts` 只数当前动作的认领次数——成功或 delay 都清零；**只领取 `rule_revision IS NOT NULL` 的行**；一批行共用认领时的租约、按顺序跑：worker 开始一行前先 `renewAutomationOutbox` 续满租约，轮到时租约已过半的行 `releaseAutomationOutbox` 退回 pending 并撤销那次认领的 attempt——任何动作都不在可能中途过期的租约上开始）。
- **自动化动作 id 稳定**：`checkAutomationConfig` 保留传入的 id，只给缺 id 的动作分配 `a<n>`（**1 起的位置序号**，撞号就往后找空位；更新时**存量规则用过的 id 也算撞号**，所以新动作拿不到刚删掉的动作的 id，删掉的 Webhook 的密钥不会被新 Webhook 继承），已有 id 永不重生成——投递去重键、续跑游标、Webhook 密钥都以它为键（0024 用同一约定回填存量规则）。旧形状（对象形 `values`、`notify {userIds}`）写入时归一化，读出时由纯函数 `normalizeStoredAutomationConfig` 归一化（读路径与入队快照都走它）。
- **执行者不是输入**：`execution_user_id` = 创建规则的人，或最后一个改了触发器 / 配置的人（只改名字 / 启停不换人）；service 的入参里没有它（D17）。API 在保存与每次运行时要求执行者是 builder+。
- **Webhook 密钥只进 `table_automation_secrets`**：入参是动作上的 `secret: string | null`（null = 清除），由调用方的 `sealer` 用 AAD `tables-automation:<ruleId>:<actionId>` 加密（db 层没有 sealer 就拒绝——只有 API 的编辑器路由给）；读路径（`listAutomationRules` / `getAutomationRuleView`）只在 webhook 动作上标 `hasSecret`，动作被删时密钥跟着删。`getAutomationRule` 返回原始行，只给内部判定用。
- **时间型规则的游标**：`next_fire_at`（schedule）与 `swept_until`（date_reached）在创建、启用、或触发配置（触发器 / schedule / dateTrigger）变化时重算——`swept_until` 置为 now，所以新规则**不会对历史日期集体触发**；cron 计算在 API（croner），通过 `AutomationScheduling` 传入。
- **评论与动态流在 `services/tables/comments.ts`**（切片 C）：`createComment / updateComment / deleteComment` 带行范围 `scope`（记录在范围外 = undefined，与不存在相同），`listRecordActivity(tableId, recordId, scope, readScope, {cursor, limit, includeComments})` 两个作用域都必填——`scope` 判记录可见，变更字段取 `scope ∩ readScope` 的可读集（API 传内核 `record.values` 封顶后的 `readScope`，masked 读者看不到任何值）。合并顺序 = `(created_at, source, id)` 降序，游标是这三元组的不透明编码（时间取 UTC 微秒定宽串，文本序 = 时间序）；字段变更只留读者今天可读的**活跃**字段（已归档字段对所有人都不再出现），变更被删空的 `updated` 事件整条丢弃并在同一请求里补满一页（≤10 轮扫描），`created / deleted / restored` 永远保留。谁能改 / 删哪条评论（作者、builder+）是 API 的判断，service 不做。`getComment(id)` 是不带范围的定位查询，只给处理器找记录用，绝不直接回给客户端。
- **表单（切片 Fm，`services/tables/forms.ts`）**：config = 显示字段 `fieldIds`（非计算；受众不是 base 时不许 relation）+ 隐藏锁定的 `defaults: [{fieldId, value}]`（`$me` 只给人员字段、`$today` 只给日期、`$now` 只给日期时间，其余静态值按字段校验；旧对象形 `{<id>: v}` 读入即数组；同一字段不能既显示又预填；附件 / 计算字段不能预填）+ `allowMultiple`（默认 true，归一化后显式存）。`audience` 列由 `normalizeFormAudience` 做形状校验 + 名单里的人必须是 active 内部用户、群组必须存在——「授权人看不看得见该群组」是 API 的事。`submitForm(formId, values, scope, meta, {evaluation?})`：客户端发来的预填字段键**直接丢弃**由服务端值覆盖，其它未发布字段 400；附件值只认**本人经本表单暂存**的文件——`pending` + `scope='tables'` + 同 Base + `uploaded_by = actor` + `cos_key` 含 `formUploadKeySegment(baseId, formId)`（`tables/<b>/forms/<f>/`，API 的 `driveKeyFor({formId})` 写同一段，两边改一处要改另一处）；提交前一条 UPDATE 原子认领（pending → active），记录写失败就放回 pending。没提交的由 `expireStaleFormUploads(before)` 置 deleted 并交回 `cos_key` 给 API 删对象。表单 scope 由 API 构造（只可写显示 + 预填字段、什么都不可读、只能新建），**db 不替调用方放宽**。
- **计算型字段只认 `COMPUTED_FIELD_TYPES`**（`@greenhouse/types/tables`）：不可写、不进表单、只读渲染的判断都引用它，别再写 `type === 'formula' || type === 'rollup'`。
- **公式（切片 Fx）**：存的仍是 AST；文本语法、函数目录（元数 / 参数种类 / 结果类型）与静态检查只有一份——`@greenhouse/types/table-formula`（`parseTableFormula` / `formatTableFormula` / `checkTableFormula`）。建 / 改公式字段时 `schema.ts` 用 `checkTableFormula` 对本表活跃字段（不含自己）检查：**只能引用存储字段**、函数元数、参数种类（文本不能进 `+ - * /`、日期不能做加减）、DATEDIFF / DATEADD 的单位必须是字面量；`shared.ts` 的形状校验用同一份深度 / 节点 / 参数上限。求值器是 `services/tables/formula-eval.ts`（纯函数、永不抛错——算不出就是 null，不能让写入失败）：算术把空当 0（沿用旧行为）、MIN / MAX 跳过空值、IF / AND / OR / NOT 按真值（空 / 0 / "" / [] 为假）、`=` 严格相等、`> <` 对 ISO 日期按时刻比较、日期函数一律 UTC（结果写入时算一次，所有人看同一个值；不做 TODAY / NOW，D7）；**单选 / 多选在公式里读作选项标签**（`resolveFormulaInput`），所以改选项名要重算读它的公式（见下）。
- **lookup（切片 Fx）**：配置 `{relationFieldId（本表的关联字段）, targetFieldId（关联目标表的字段）}`，目标只能是 `TABLE_LOOKUP_TARGET_TYPES`（文本 / 数字 / 日期 / 是否 / 选项 / 链接 / 公式——人员、附件、关联存的是 id，rollup / lookup 级联只有一层会过期）；依赖写 `table_field_dependencies('lookup')`（关联字段 + 目标字段，切片 A 的计算字段可见性闭包靠它）。值 = 按关联顺序取每条未删除目标记录的目标值（选项读标签、多值展平、去空，≤ `MAX_LOOKUP_VALUES`）的数组，和汇总走同一条重算路径。筛选只支持 `contains`（任一元素包含，不区分大小写）/ `is_empty` / `is_not_empty`；`is_empty` 把 `[]` 也当空（对所有多值字段生效）；关键词搜索也覆盖可读的 lookup 值。
- **重算级联只有一层，且收窄到相关表**：`refreshDependentRollups(targetTable, record)`（记录改 / 删 / 恢复后）只看**同一 Base** 里经关联指向该表的 rollup / lookup，按 `table_record_links` 的 `(field_id, target_record_id)` 索引找到链接它的记录，每条记录重算一次、每个依赖字段记一条幂等 job。字段定义变化走 `refreshAfterFieldChange(field, {computed})`（`updateField` 改了配置 / `archiveField` 之后）：本字段是计算字段或有同表计算字段读它（公式，或经它这个关联字段的 rollup / lookup）→ 重算本表；再重算以它（或读它的同表字段）为目标的 rollup / lookup 所在记录。**归档字段只删它自己的出边**：读它的公式 / rollup / lookup 的入边保留，编译器把归档源当未知字段 → 这些字段对自定义角色隐藏（fail-closed，不会因归档而“解除隐藏”）；计算时归档 / 未知源一律读空——公式读到 `null`，目标或关联字段归档的 rollup / lookup 按“无值”算（lookup `[]`、sum / count 0），归档列留在 `values` 里的旧值不再流出。
- 自定义角色引用（成员 / 群组 / 团队默认）都是 `SET NULL`，悬空的 custom 一律解析为「无访问」，绝不回落 viewer；引用必须同 Base（`uq_table_base_roles_base_id` 供复合校验，处理器负责检查）。
- **配置校验器经 `TablesSchemaSource` 读结构**（`services/tables/schema-source.ts`）：字段模型配置 `checkFieldConfig`（关联目标同 Base、公式引用、lookup / rollup 链）、视图 `checkViewConfig`（→ `normalizeViewConfig`）、表单 `checkFormConfig` / `checkFormAudience`、自动化 `checkAutomationConfig`、仪表盘 `checkDashboardConfig` / 组件 `checkWidgetCard` 都只通过 source 的 `table / fields / activeUserIds / existingGroupIds` 读结构，**不直接查表**。写路径传 `dbSchemaSource(executor)`；计划工具的起草校验传一个虚拟 source（现有结构 + 计划声明的占位对象，API `platform/tables/schema-plan-draft.ts`），所以「起草时拒绝的」与「写入时拒绝的」是同一段代码。新增一个要查结构的配置校验器就照这个形状写并从 `index.ts` 导出，别在 API 里抄一份。编译上下文用 `sourceCompileContext` / `buildCompileContext` 构造（只建 SQL 片段不执行；编译器本身仍不导出）。
- **视图配置只有一个校验器 `normalizeViewConfig(type, config, ctx)`**（`services/tables/views.ts`，切片 V）：`createView` / `updateView`（改类型或配置时）都过它，参数里的 `scope` 决定作者能引用哪些字段（自定义角色只认可读字段）。规则：配置按已知键重建、未知键丢弃；展示列表（`fieldIds` / `systemFields` / `widths` / 看板 `hiddenGroups`）里失效的 id 静默丢弃（字段归档后视图仍可保存）；**本类型必需的键**（看板 `kanban.groupFieldId` = 单选 / 人员、日历 `calendar.startFieldId` = 日期 / 日期时间、表格 `groupBy` 的字段类型、封面 = 附件）缺失或不可用就拒绝；**其它类型的键**只在仍有效时保留（看板 → 表格 → 看板不丢列设置）；保存的 `query` 用唯一编译器干编译一次，写进 query 的 `groupBy` 移到 `config.groupBy`。分组 / 看板「无值」的键是 `TABLE_VIEW_NO_VALUE_GROUP`（空串）。`deleteView` 是硬删（视图只是配置），别人的个人视图对它不可见。
- **仪表盘组件存统一卡片规格**（`services/tables/dashboards.ts`，切片 D）：组件 `config` = `{version: 2, card: TableCardSpec}`，`type` 与 `table_id` 由 card 推出（`widgetTypeForCard` / `card.source.tableId`），旧扁平配置写入时经 `legacyWidgetToCard` 映射、读到旧行同样映射（不做数据迁移）。保存时按 schema 校验：表属于该 Base、引用字段在用、非 count 的值字段是数字、日期分桶只给日期字段、卡片自身的查询能被编译器接受（以无限制读者身份编译一遍）。仪表盘 `config.filters` 同样按 schema 校验目标字段类型（日期范围 → 日期 / 日期时间，选项 → 单 / 多选，人员 → 人员 / 多人员，搜索 → 文本类）。**求值不在 db 层**：只有 API 的 `platform/tables/cards.ts` 把卡片变成数字或行。
- **导入只写一次**（`services/tables/imports.ts`，切片 I）：一次上传一行 `table_imports`（归上传者 + 表，最后一次活动后 1 小时过期，`sweepExpiredImports` 清理；完成即清空 `rows`）。`claimImport` 在行锁里做 `previewed → committing` 的 CAS（UPDATE 的 WHERE 带上刚读到的状态与计数器），并把**计划**（列 → 字段、新建字段 id、表头、时区）存进 `result.plan`——续传只用存下的计划，绝不重新决定（否则会重复建字段）。`commitImportChunk` 在**一个事务**里先以单条 CAS 语句推进 `committed_rows`（条件「计数器仍等于 `fromRow`」，同时拿到行锁），再写 ≤100 行记录（`createRecordWithContext(..., { within: tx })` 直接加入该事务；校验在任何语句之前拒绝坏行，数据库错误让整块回滚）：崩溃后重试、并发的第二个 runner 都只会得到 `moved`、一行不写。CAS 写成单条语句而不是「先 SELECT FOR UPDATE 再判断」，是因为 db 测试里所有语句共用一个连接、行锁不互斥，单条语句的 WHERE 仍然成立。写入元信息必须是 `actorKind:'import'`、`source.importId`、`enqueueAutomations:false`（D6，service 自己拒绝其它形状）。**单元格文本 → 字段值只有一份实现**：`@greenhouse/types/table-cell-text` 的 `coerceTableCellText`（零依赖纯函数：词表、数字 / 货币 / 百分比、是否、日期 / 日期时间（无偏移按调用方时区、日月顺序按列推断）、选项按标签、多值拆分、人员按邮箱或唯一昵称、链接 / 邮箱 / 电话），导入与表格粘贴（`apps/web` 的 `parsePastedCell`）都调它，所以「能导入的就能粘贴」。`import-values.ts` 的 `coerceImportValue` 只在它外面补**关联**：关联标签由调用方按写入者的读范围给出，`matchImportRelationLabels` 在主字段不可读时什么都不匹配——D14，不做存在性神谕；列类型推断、表头匹配、新选项也留在这里（只有导入用）。别在任何一端再写一份词表或解析器。
- **`table_notifications` 保留到下个版本**（扩展—收缩）：0024 把旧行迁入 `notifications`（`ntf_` id、kind `tables_automation`、去重键 `tables-notification:<旧 id>`、保留已读与时间）并把遗留的 pending / processing outbox 行与运行中的旧 run 置为 failed `legacy_sync_executor`；本版不再读写它，service 方法已删；回滚到旧镜像时它还要读写这张表，所以**本版不删表**，下个版本的迁移再 drop。
- **生效角色只有一张决策表**：`decideTableBaseAccess`（`@greenhouse/types/table-access`，纯函数：super / owner → 本人成员行 → 群组 → 团队默认）。db 层只存 / 读授权行，不自己排序角色；API 的 `platform/tables/access.ts` 加载事实后调用它（过渡期 db 侧的 `canUserEditBase` 已随同步执行器删除）。
- **资源 → Base 的反查只有 `baseIdsForResources(kind, ids)`**（`services/tables/resources.ts`，每种资源一条查询，含 `app`）：API 在每个 Tables 动作**执行前**用它把资源所在的 Base 写进审计事件的 `scope_type='base'` / `scope_id`（删除类动作执行后就查不到了，所以必须在前），Base 审计按 `idx_platform_audit_scope_created` 一次读取（`db.platform.listAuditEventsByScope`，可带动作白名单），不再扫全组织最近 N 条再在内存里过滤——应用的大量读请求曾经能把写挤出窗口。新增一种可审计的资源就在这里加一个 `kind`（同时进 API `platform/tables/audit.ts` 的映射）。`recordAudit` 只在资源同时带 `scopeType` 与 `scopeId` 时写这两列；0025 按动作 → 资源种类回填了存量**写**事件（读不回填，Base 审计只列写）。
- **应用（阶段 1，`services/tables/apps.ts`，迁移 0025）**：方案见 [应用层 spec](../../../docs/specs/20261011-tables-apps.md) §1。只存取，不判定（谁能管理 / 发布、查看者的角色、规格校验都在 API）。
  - **草稿 CAS**：`saveAppDraft(appId, {spec, draftRevision})` 是单条 `UPDATE … WHERE draft_revision = $n`，过期 → `conflict` + 当前修订；归档的应用不能改（`archived`）。草稿文本 ≤ `APP_LIMITS.specBytes`。
  - **版本不可变且带哈希**：`publishApp(appId, {draftRevision, notes, publishedBy})` 在一个事务里锁应用行、核对草稿修订、把草稿**原样文本**写进新版本行（`spec_hash = appSpecHash(text)`，sha256 hex）并移动 `published_version`；版本号 = 现有最大 + 1，只增不减。`spec` 是 TEXT 不是 jsonb（jsonb 会重排键，读回的字节就不是被哈希的字节，D7）；**每次读版本都校验哈希**（`getAppVersion` / `getPublishedAppVersion` 不匹配直接抛错，绝不把被改过的规格交给网关）。回滚 = `restoreAppVersion` 把旧版本复制回草稿（同样走草稿 CAS），再发布成新版本（D5）。列表（`listAppVersions`、`listManagedApps` 等）不带规格文本。
  - **受众整体替换**：`replaceAppAudiences(appId, {entries, audiencesRevision, createdBy})` 锁应用行、核对 `audiences_revision`、删光再插；同一个人 / 群组 / 全员只能出现一次（部分唯一索引兜底，CHECK 约束保证 `principal_type` 与 id 成对）。受众只存角色 key，**不校验 key 是否在规格里**——那是 API 的事（新版本删掉某角色时，指向它的受众自然不再授予任何东西）。
  - **谁看得到什么**：`listManagedApps(userId)` = 应用负责人、Base owner、或 owner / builder 成员行（群组不能授 builder，所以不看群组）；`listAppsSharedWith(userId)` = 已发布、未归档、Base 未归档，且有一条受众行触达此人（本人行 / 他**列在 `group_members` 里**的群组行——群组创建者不算 / 全员行）；`listFeaturedAppsFor(userId)` = 推荐 ∩ 已发布 ∩（受众触达 ∪ 管理者），推荐只对受众可见。`listAudienceMatches(appId, userId)` 给网关选角色用（本人 > 群组按规格角色顺序 > 全员，D3）；货架一次解析多个应用用批量版 `listAudienceMatchesForApps(appIds, userId)` + `listPublishedAppVersions(appIds)`（各应用的已发布版本，校验哈希）。这些都是**候选**，API 仍要解析 Base 级别（super、归档、内核 scope）与角色（受众行指向的角色在已发布版本里不存在 → 不上货架）。
  - **置顶**：`setAppPins(userId, appIds)` 整体替换（去重、按顺序、≤ 50），随应用级联删除；能不能置顶某个应用（看不看得见）是 API 的判断。
  - **网关的存取（`services/tables/app-gateway.ts`，迁移 0026）**：`matchRecordIds(tableId, ids, scope, {purpose, condition})` 一次查询告诉网关一页记录里哪些在 scope 的读行（或读 ∧ 编辑行）内、且满足构建者写的条件（动作的 `when`）——条件按**行范围**编译（不限可读字段、编译不了即 FALSE、`$me` = scope 的人），空条件 = 无条件；`listRecordsByIds` 按 scope 取记录（关联标签只给读范围内的行）；`listDriveFileMeta` 给附件标签。应用上传：`pending` 的 tables 作用域文件、键段 `appUploadKeySegment(baseId, appId)` = `tables/<base>/apps/<app>/`，写前 `claimAppUploads`（pending → active，只认本人、本应用）+ `appUploadsAttachable`（本人经本应用上传、没挂在别的记录上），写失败 `releaseAppUploads`，`expireStaleAppUploads` 由每小时的上传清理调用。动作账本 `table_app_action_requests`：`claimAppActionRequest`（插入即认领，唯一键冲突 → 返回已有行；卡住 2 分钟的 running 可接管）、`completeAppActionRequest`（存结果）、`releaseAppActionRequest`（被拒 / 出错时删掉认领）。`appUsageSummary` 读应用审计（`idx_platform_audit_resource_created`）与账本。编译器仍只在包内：网关从不自己拼 SQL。

### Tables 的软删与恢复

- `table_bases.archived_at` / `table_tables.archived_at` / `table_records.deleted_at` 是三层软删；`listBasesForUser`/`listTables`/`getSchema`/`queryRecords` 都已过滤，新增读路径别漏。
- 配套方法：`archiveTable`/`restoreTable`/`listArchivedTables`、`restoreBase`/`listArchivedBases`、`listDeletedRecords`/`restoreRecord`。`restoreRecord` 与 `deleteRecord` 一样 bump `revision`（拿着旧 revision 的客户端不能静默覆盖），各自在一个事务里写历史事件，提交后 `refreshDependentRollups`；scoped 调用方删除与恢复都要 `canDelete`。
- `getRecordById` **刻意不过滤 `deleted_at`、也不带 scope**（只给审计 / 归属查找用，结果永远不直接返回给客户端），`getRecord` 过滤并按 scope 收窄——两个都要用对。
- `deleteDashboard` 是**真删**（widgets 级联），Tables 里唯一的硬删。权限口径与用户面语义见 [spec](../../../docs/specs/20260803-tables-lifecycle-and-grid-interaction.md)。

### 技能中心的安全扫描列

方案见 [SkillHub 上传与扫描 spec](../../../docs/specs/20260805-skillhub-web-upload-and-scan.md)。

- **扫描状态挂 `agent_skills`（技能级）而不是 `agent_skill_versions`**：隔离语义本身就是整个技能的（作者投毒了 v2，v1 也不该继续发），列表筛选与徽章因此不需要 join；`scan_version` 记录结论来自哪一版。别顺手加版本级冗余列——两个枚举两个写入点，为一个 20 行规模的表付不起。
- **`scanned_at IS NULL` 是「从未扫过」的唯一判据**，`listUnscanned()` 与启动补扫都靠它。存量行迁移后落在 `scan_status='pending'`，**不要**为了「看起来干净」把它们刷成 `clean`——那是把没检查过的东西说成检查过了。
- **`setScanResult()` 刻意不动 `updated_at`**：那一列是目录排序键（`list` 按它倒序），后台补扫/重扫若刷新它，整个 SkillHub 列表会无缘无故重新洗牌。写新扫描路径时保持这条。
- `setScanResult()` 会清空 `scan_reviewed_by/at/note`：一次新扫描取代旧的人工裁定。人工裁定走 `setScanDecision()`，只有 super 能调（校验在 `apps/api/src/skills/center.ts`，不在 service 层）。

### JSON-as-text 列策略（2026-06 C-3 评估结论）

- 所有"text 存 JSON"列（tags/meta/config/references\_ 等）应为 **NOT NULL**（null 从无语义，写路径总提供值）；新增此类列必须 `notNull().default('[]'/'{}')`。不要在文档中维护容易漂移的列数。
- **整列转 jsonb 暂缓**：postgres.js 对 jsonb 返回已解析对象、写入需对象而非字符串——切换意味着全部 service 写路径（JSON.stringify）与读路径（JSON.parse/safeJsonParse）成对改造 + wire 行为回归，收益（jsonb 索引/路径查询）目前没有真实查询需求支撑。若未来某列需要 jsonb 查询（如 metadata 过滤），按列单独迁移：`USING col::jsonb` + 该列全链路读写改造 + `.$type<T>()` 标注。
- 语义性 NULL 列（`messages.reasoning`、`eval_results.judge_reasoning`、`knowledge_base._enriched_at` 等"缺失即含义"）**保持可空**，不要顺手 NOT NULL。

### Platform Kernel v2 控制面

- schema：`schema/platform.ts`；service：`services/platform.ts`；provider 入口：`db.platform`。
- `platform_*` 只保存组织、角色/用户授权、实体策略、应用 release 与 action audit；现有业务表按应用渐进迁移，不在基础迁移里批量补 `org_id` 或改主键。
- scopes / field_policies / manifest / audit summary 遵循本包 JSON-as-text 规则；进入内核前解析为 `@greenhouse/platform-kernel` 类型。
- `platform_user_workbench_preferences` 以 `org_id + user_id` 唯一保存版本化 JSON；service 必须对损坏/旧版本数据回落安全默认值，API 再与当前可见 Catalog 取交集。工作台偏好不能承载授权。任何 read-modify-write 必须走 `mutateUserWorkbenchPreferences`（per-user transaction advisory lock，覆盖首次无行场景），禁止 `get` 后在事务外整 blob `set`，否则浏览器与 Agent 并发会静默丢改动。
- `platform_audit_events` 对 users/organizations/resources 均为松散逻辑关联，无 FK，必须独立于主体和业务记录生命周期。
- 初始迁移只 seed `platform_organizations(id='default')`；system roles 和现有用户 bindings 要等首个应用 manifest 激活时由可审查 bootstrap 脚本写入，禁止在无 capability catalog 时提前假播种。

### Platform OAuth 2.1

- schema：`schema/platform-oauth.ts`；service：`services/platform-oauth.ts`；provider 入口：`db.platformOAuth`。
- OAuth client/grant/code/token 独立于 `api_clients` 的内部 A2A/Relay API Key；两类凭证不得塞进同一行或共用生命周期。
- authorization code、access token、refresh token 原文一律不落库，只保存 SHA-256 hash；scope/resource/expiry/revocation 必须持久化并逐请求校验。
- **scope 列存的是"实际授予了什么"，读出来绝不加工**（迁移链 起）。动作 scope（`mcp:read`/`mcp:write`）之外还有资源组 scope（`mcp:knowledge` 等，每个 MCP 资源组一个），可达工具由两者相乘得出。存量行已被 0063 显式回填全部资源组（grants / 未过期未撤销 token / 未消费 code / 机器客户端 allowed_scopes 四张表），因此服务端解析器**没有**"缺资源组视为全部"的兼容分支——加回那个分支等于把每个存量 grant 提权成全权限。写入方向的展开只发生在请求解析（`normalizeOAuthScopes`），不在存储解析。
- `platform_oauth_grants.user_id` 对 users 使用 CASCADE；撤销 grant、禁用 client 或改变 grant scopes 必须在同一事务同步撤销既有 token（scope 变化同时作废未使用 code）。token 签发必须锁定并复核当前 grant，避免降权并发窗口；`platform_audit_events` 仍保持无 FK 独立留存。

### 数字类型转换

- PostgreSQL 通过 `execute()` 返回的 `COUNT(*)`、`SUM()` 等为字符串
- 使用原生 `execute()` SQL 时始终用 `Number()` 包装
- Drizzle 的查询构建器（`select().from()`）已自动处理

### 统一 Usage Budget

- schema：`schema/usage.ts`；service：`services/usage-budget.ts`；provider 入口：`db.usageBudget`。`llm_usage` 继续作为统计事实，但新调用必须写同一 `budget_idempotency_key`；月度用户账户只把该字段为 NULL 的 legacy 行投影进 `legacy_spent_units`，budget-aware 用量只由 ledger 结算，禁止把两条路径相加两次。
- 一个模型调用必须先 `reserve` 再做 provider I/O；成功或拿到真实 usage 后 `settle`。只有能确认 I/O 尚未开始的失败才可 `release`。TTL 到期表示 outcome unknown：sweep 把 estimated 从 reserved 转 spent 并标 `expired`，迟到的真实 usage 只补/退与 estimate 的差额，绝不能把未知调用免费释放。
- **estimate 的口径是「带余量的好估算」，不是不可击破的上界**（`apps/api/src/llm/usage-budget.ts` 的 `providerAttemptEstimate`：`estimateTokens` × 1.25 + `maxOutputTokens`）。准入比较的是「空闲额度 ≥ estimate」，所以估算膨胀多少，用户就在还剩多少额度时被拒；TTL 过期又按它硬扣。原来用 UTF-8 字节数（真上界）的代价实测是 4.8×——20M 的额度实际只能花掉约 4M，且一次未知结果的调用扣掉 186k。改估算前先看 [spec D2](../../../docs/specs/20260813-usage-budget-admission-truthfulness.md) 里的样本口径。
- 多 scope 账户在一笔事务内按 account id 排序锁定；缺账户、disabled、period 不覆盖当前时间或余额不足都 fail-closed。一个 reservation group 只放同一 unit 的账户；tokens、requests、usd_micros 分别使用不同幂等子键。
- `usage_budget_ledger` 只能追加，没有 delete/update service；账户、预留与账本均永久保留且故意不设业务主体 FK。预留 key、人工 adjustment key、status key 重放必须返回原结果，不同参数复用同 key 必须报 `usage_budget_idempotency_conflict`。
- 用户月周期固定 UTC `[月初, 下月月初)`；传入 period 必须先规范成 ISO，比较 timestamp 用 epoch，不比较驱动返回字符串的表面格式。
- `db.usage.getCostValueReport()` 是 super 运营面的事实聚合入口：LLM calls/token/duration 来自 `llm_usage`，
  Runtime 成功率固定按 `succeeded / terminal`，预算余额来自账户，美元只汇总 `usage_budget_ledger` 中对应 scope 的
  `usd_micros` delta。模型目录没有版本化价格时 `cost_estimate_usd` 必须为 NULL，禁止套统一 blended rate 虚构成本；
  organization/user/provider 三层账户记录的是同一笔控制效果，组织总成本只能取 organization scope，不能三层相加。

### 统一 Runtime Kernel

- schema：`schema/runtime.ts`；service：`services/runtime.ts`；provider 入口：`db.runtime`。它只统一执行 envelope、lease/CAS、Interrupt、Event/Outbox，不取代 Mission workspace、Workflow graph、Chat transcript 或 Eval score 等领域事实。
- Run/Step/ToolCall/Artifact/Interrupt 的完整 input/output/payload/decision 与 Event payload 永久保留，不自动截断、不过期、无生产 delete Service；大文件字节仍在对象存储，Artifact 保存 provenance/hash。`runtime_events` append-only，Outbox delivery state 只能写 `runtime_outbox`，禁止回写或改造 Event。
- 每个状态/heartbeat/claim/stale-recovery 变更必须在同一事务追加 Event + Outbox；Event `seq` 通过锁定对应 Run 后分配。重复命令先查 `(run_id,idempotency_key)` 并校验完整 fingerprint，不能重新执行副作用。
- 真实工具执行前只走 `runtime.beginToolCallWithAuthority()`：同一事务按 Run→Step 加行锁，durable driver 必须证明 Run/Step 都仍 running、`desired_state=run`、owner 匹配、worker 同时持有两条未过期 lease；unleased 例外只允许 running 的 `kind=chat/source_kind=chat_turn` projection。事务内一次完成 ToolCall create + pending→running 及两条 Event/Outbox，任一失败都禁止调用真实工具。已存在同幂等 key 永远不二次 admission。`running` worker 丢失统一转 `uncertain`（即使 Run 已请求 cancel），因为 DB 只能证明 admission 已提交，不能证明外部结果；pending 才能安全收为 canceled。
- 跨领域 Run command 统一走 `executeRunDomainCommand`：`SELECT ... FOR UPDATE` 的 Run 锁必须覆盖领域 side effect，成功后同事务 CAS 更新 desired state 并追加 Event/Outbox；callback 的 `may_drive=false` 只用于 crash-window 已落来源状态的只读确认，不得发起新副作用。这样同一 expected version 的 pause/cancel 只能有一个真正驱动来源域。
- worker 领取使用 `FOR UPDATE SKIP LOCKED`，heartbeat 必须同时匹配 version、lease owner、未过期 lease 与 Run desired state。过期 lease 不能被旧 worker 续租或确认 Outbox；stale Step 只有 driver 给出可审计的安全 checkpoint 后才终态化旧 attempt 并创建新的 queued attempt，禁止原地覆盖历史或盲重放外部写。
- Automation admission 的 overlap 约束走 `createRun({single_active_source_kind:true})`：事务 advisory lock 按 `(owner,kind,source_kind)` 串行化，并拒绝同一任务定义下另一条 active occurrence；相同 source identity 仍先按完整 input 做幂等回放。这个 service 选项是 Runtime 队列事实，不得再叠一份进程内 running Set。
- Automation 的 task summary、成功计数与外部通知只能从 Runtime 终态 Outbox 投影：`scheduled_task_runtime_occurrences` 以 `runtime_run_id` 永久幂等，成功计数与 occurrence 插入同事务；延迟旧事件可补永久事实但不能覆盖更新 Run 的 `last_status`。driver 与 stale hook 禁止直接外发或重复增加 `run_count`。
- Subagent admission 只走 `runtime.admitSubagent()`：稳定 tool-call identity 绑定 child session/message id，并在同一外层事务创建 child session、seq=0 user message、Runtime Run 与 Step；内部 `createRun({active_subagent_parent:{parent_session_id,limit}})` 的 advisory lock 按 `(owner,parent session)` 串行化，从完整 Runtime input 的 `parent_session_id + mode=async` 统计 active background child，精确替代 `spawn_session` 原来的进程内 async 并发 Map。显式 `parent_run_id` 必须在该事务内 `FOR UPDATE`，且 owner/session 匹配、状态仍为 `claimed|running`、`desired_state=run`；调用层不得在显式 id 缺失/失效时降级成按 session 查另一条 Run。任一 identity/lineage/限流失败整笔回滚；禁止另建“先 transcript、后 Runtime”的 ensure 路径。Subagent Run 固定 `max_attempts=1`；只有尚未进入 `running` 的 claim lease 可恢复，running lease stale 必须终态失败，绝不能自动重放可能已外写的整轮。
- Eval 的领域事实仍在 `eval_runs/eval_results`：`createQueuedRun()` 必须在一个事务内保存 exact dataset selection 与全部 pending result placeholders；Runtime envelope/Step 仍只由 `db.runtime` 创建，API boot reconciler 负责补两者之间的 crash window。driver 完成或报错 result 必须用 `updatePendingResult()` CAS，确保 durable cancel 先把 pending 改 cancelled 后，迟到的 provider 响应不能覆盖取消。`completed|error|cancelled` 都是已处理 case，恢复时不得重复模型调用；只有 pending 可形成新 Runtime Step attempt。
- `runtime_runs.parent_run_id` 是域内 CASCADE 所有权；Run 的用户/session/source/root、Event actor、Interrupt 决策人、ToolCall Platform Audit 是松散逻辑关联，使永久执行历史不随外域主体删除。Service 写入 step/tool/artifact/interrupt 时必须验证它们属于同一 Run，不能只依赖单列 FK。

### Bot 版本（2026-10-07 从 custom_profiles 搬到 bots；2026-10-08 去掉共享与治理）

- `bots` 是稳定资产身份（也是聊天 / 自动化 / Bots 线程共用的唯一 Agent 身份），`bot_versions` 是不可变完整
  manifest；`createBot` 写 v1、`updateBot` 追加 v(n+1)，生产 Service 不得 update/delete 版本。manifest hash、
  change log、名字/岗位/用途/守则/tools/模型/步数/头像必须随版本冻结。`tools` 为 NULL = 继承主人全部有效工具，列表 = 过滤器。
- **Bot 是主人私有的**：没有 `is_shared` / lifecycle / published_version / backup owner / review 列，没有
  `listShared` 一类的跨用户读；所有读写按 `user_id` 作用域（`getBotById` 只给 profile 解析层，访问判定在那里做）。
  旧 `bot:<id>@<version>` 仍可供已 pin 的计划任务/Eval/子代理重放；`archiveBot` 只置 `status='archived'`。
- `createBot` 把唯一索引冲突翻译成 `BotsDomainError('bot_name_taken')`：聊天页与 Bots 页并发 bootstrap Sprouty 时
  输家据此重读（真实竞争只能在 `*.db-commit.test.ts` 复现，`db` 项目所有调用跑在同一条回滚连接上）。
- **迁移 `0010_bot_identity` 把每条 `custom_profiles` 变成主人的一只 Bot**：id 取 `'bot_' || left(md5('custom:'||id),16)`，
  版本号原样复制，`legacy_custom_id` 保存原 id 供 `custom:<id>[@v]` 继续解析；名字按 Bot 规则清洗（去 `[]:：` 与控制符、
  ≤24 字、与主人现有 active Bot 重名加后缀），`role` 取 purpose/description 首句；已有 Bot 回填 v1（hash 由 SQL 算，
  仅审计用）。`0011` 再 drop 两张旧表；`0014_bots_private` 删掉搬来的治理列。`sessions` / `scheduled_tasks` /
  `eval_runs` 存量 `profile_id` **不改写**（他人 pin 的旧共享 Agent 引用从此 403）。

### 统一 Notification Center

- `notifications` 是永久站内事实，按 `(user_id,dedupe_key)` 幂等；只允许用户修改 `read_at`，生产 Service 不提供删除。完整 payload 与 Runtime/Agent provenance 均保留，不做裁剪或 TTL。
- `notification_delivery_attempts` 只表示 企微/飞书/email 等 transport；SKIP LOCKED claim、lease、retry/dead-letter 都不得回写业务 Run、Interrupt 或 Agent lifecycle。创建站内通知成功后，即使外部送达失败，业务结果仍保持原终态。
- 用户和 Run/Interrupt/Event/Agent provenance 是逻辑引用，保证账号停用或领域事实退役后仍能审计；delivery → notification 是域内 FK CASCADE。
- **手机推送（`mobile_push`，迁移 0021，[spec](../../../docs/specs/20261010-mobile-push.md)）**：收件人是 `push_devices` 的一行（`recipient` = 设备 id，逻辑引用）。
  - 生产者只经 API 的 `publishNotification()` 写事实；会推到手机的事实在 `payload.push` 带路由信封（不含内容），worker 只认存下来的信封。
  - 投递行在**发送前复核**，不该再推就 `settleDelivery({status:'suppressed'})`；渠道判定收件人永久没了记 `failed`；两者都不重试。不要把「复核没过」写成 `dead_letter`——死信只留给 bug / 坏掉的部署，会打 error 日志。
  - `push_devices` 按 token upsert，`register` 在 token 级 advisory lock 里做：同账号刷新同一行并保留偏好；换账号 = 这一行改归新账号、偏好重置；每账号最多 `MAX_ACTIVE_PUSH_DEVICES` 台在用，多出来的按 `last_seen_at` 停用最久没见的（`device_limit`）。**任何路径都不物理删设备**：注销 / `DeviceNotRegistered` 只停用，再注册就恢复。
  - 「能不能投」只有一份判定：`isDeliverable()`（未停用 + 属于这个账号 + `auth_version` 等于账号当前代数 + 90 天内见过），`listDeliverable()` 是它的 SQL 版，两者同改。改密码 / 停用递增 `users.auth_version`，所以之前注册的设备立即停推，直到成员在手机上重新登录。
  - `bots.attentionCount()`（推送角标）与客户端抽屉 ☰ 角标同一条规则（`conversationAttention`）；`bots.listMissedReplies()` 的「回合已结束」靠 `last_activity_at` 在写完之后才被盖章——改引擎的盖章时机要同改这条查询。

### 新增表流程

1. 在对应的 `schema/*.ts` 文件中添加表定义，并在文件底部导出 Row 类型（`typeof table.$inferSelect`）
2. 在 `services/` 中添加 `createXxxService(db: Db)` 工厂（参数类型同文件定义）
3. 在 `provider.ts` 的 `createDatabase()` 中注册一行
4. 在包根 `index.ts` 加 `export * from './services/xxx.js'`
5. 运行 `pnpm drizzle-kit generate` 生成迁移并 **review 生成的 SQL**（见上「push vs migrate」）；本地可 `migrate` 到 scratch 库自测，**不要 push 到共享/持久库**
6. 更新 `db-schema.md`

### Bots 派生记录的隐私

- `bots-privacy.ts` 是 session 列表、旧分享与 Runtime 的共同 SQL 边界。对外 session 列表必须传 `viewerUserId`；Runtime 列表/详情/审批/统计必须传 `viewer_user_id` 或对应方法的 viewer 参数，在 LIMIT/游标/COUNT 前过滤。引擎内部查询可省略，不把该可见性过滤当成通用授权。
- Runtime 独立于 session 的生命周期：`source_id=bots:*`、`source_id/session_id=bottask-*`、`input.source_mode=bots` 的记录始终只有 owner 可见，即使原 session 已删除。不要只用活着的 session JOIN 判断。

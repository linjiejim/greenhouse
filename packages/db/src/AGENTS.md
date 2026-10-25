## 数据库规则

表结构、FK 与逻辑关联见 [db-schema.md](./db-schema.md)；本文只写规则。

### 数据库：PostgreSQL

- 生产和开发都用 PostgreSQL（Docker）；连接串 `DATABASE_URL`，默认 `postgresql://greenhouse:greenhouse@localhost:5432/greenhouse`。
- 本地起库：`docker compose up -d postgres`（仓库根 `docker-compose.yml`，绑定 `127.0.0.1:5432`）。
- 建表与升级只走 `pnpm db:migrate`（= `pnpm cli db migrate`）；compose 的 `migrate` 服务、CI、e2e、run-dev 都调它。

### 版本识别与拒绝

- `migrate.ts` 的 `detectDatabaseGeneration()` 把库分成 empty / v3 / carry_incomplete / v1 / v2 / unknown：有 `users` + `sessions` 无 `conversations` 或命中 `drizzle/archive-1x` 的迁移 hash = 1.x；有 `members` 无 `users` = 2.x。
- `migrate-from-1x` 清空目标前写 `drizzle.greenhouse_carry` 标记（`completed_at` 为空），最后一步才置完成；标记未完成的库 = carry_incomplete，`db:migrate` 和 API 启动都拒绝。从没搬过的新库没有标记，正常启动。开始写之后的失败抛 `CarryFailedError`（CLI「Carry failed:」退出 3），写之前的拒绝是 `CarryError`（「Refusing:」退出 2）。
- `pnpm db:migrate` 只接受空库和 3.0 库；1.x、2.x、有表但不是 Greenhouse 的库一律拒绝（退出码 2），提示语来自 `refusalFor()`。
- API 启动时 `initSchema()` 同样拒绝 1.x / 2.x 库，未迁移的空库报「先跑 `pnpm db:migrate`」；它只检查，不建任何东西。
- 1.x 库永不原地升级：建新空库后跑 `migrate-from-1x`。2.x 库 3.0 既不能跑也不能搬。
- run-dev 的沙箱库在主库仍是 1.x 时建空库而不克隆；要数据就对沙箱库跑 `pnpm migrate-from-1x`。

### 数据库测试隔离

- 真实库测试命名 `*.db.test.ts(x)`：Vitest DB project 给每条测试包一层事务并回滚；每个文件一个连接池，测试不 `resetSchema()`、不 close 根连接、不维护共享 singleton。
- `initDatabase()` 必须在 `beforeEach` 里调：事务由 setup 的 `beforeEach` 开启，`beforeAll` / 模块作用域里调会自建连接池，写入全部提交。
- 断言只针对本测试造的行：全表 `count()` / `list()` 仍看得见别的连接已提交的数据；用唯一 scope 过滤或取增量。
- service 内部再开 transaction 要兼容 Drizzle savepoint；不绕开 provider 另建连接。
- 不写死 id：新行 id 是 ULID，测试从返回值取 id，不按固定 id 更新 / 删除。
- 只有多连接可见性、DDL、连接级锁 / 竞态才用 `*.db-commit.test.ts(x)`，文件头写 `@db-commit-reason`；该层串行，用每次唯一的业务键、最小定向清理、不依赖全局计数，禁止 `resetSchema()`。
- project 启动时的全库清理是唯一共享 reset；platform manifests、protected roles、baseline policies 在 global setup 提交一次作为不可变基线。
- 测试用户在自己的事务里建，经 `tests/helpers/internal-user.ts` 绑 baseline role；要收窄某个成员的权限用 `tests/helpers/restricted-role.ts` 的 `moveToRestrictedRole()`（复制 team 角色再删能力或换实体策略），没有个人级覆盖可用。
- `syncLegacyRoleBinding()` 只给验证角色切换的测试用，不作为新用户 fixture。
- `TEST_DATABASE_URL` 必须是本机、库名含 `test` / `e2e` 的一次性库；多 worktree 各用 `greenhouse_test_<slug>`；本地不设直接报错（只有 CI 回退 `localhost:5432/greenhouse_test`）。

### Service 模式

- 所有数据库操作走 `getDb()` 返回的 `DatabaseProvider` 上的域 service：`db.users.getById(...)`、`db.knowledgeBase.search(...)`。
- 数据流：业务逻辑 → `index.ts`（单例入口）→ `provider.ts`（装配）→ `services/<域>.ts`。
- service 名沿用 1.x（`db.sessions`、`db.knowledgeBase`、`db.drive`、`db.scheduledTasks`、`db.customProfiles`…），表名是 3.0 的；改 service 前先看它写哪张表。
- `db.users`、`db.drive`、`db.platform` 是扩展契约，方法形状不变（id 现在是字符串）。
- 类型全部推导：`DatabaseProvider = ReturnType<typeof createDatabase>`；Row 类型 = `typeof table.$inferSelect`，导出在对应 `schema/*.ts` 底部；union 别名 = `XxxRow['col']`；参数类型与 service 同文件；一切从包根 `@greenhouse/db` 重导出。
- service 是返回对象字面量的工厂 `createXxxService(db: Db)`；对象内自调用用 `const service = {...}; return service;`，不用 `this`。
- 业务逻辑（API 路由、工具、CLI）不直接写 SQL。
- 不新增接口镜像 / repo 类 / 多后端抽象。

### ORM：Drizzle

- schema 在 `schema/`（每个域一个文件，文件头列出本域的表），经 `schema/index.ts` 导出；service 在 `services/`。
- 驱动 postgres.js（`drizzle-orm/postgres-js`）；复杂查询（FTS、聚合 + JOIN）用 `sql` 模板。
- 配置在仓库根 `drizzle.config.ts`。

### Schema 定义

- 列一律用 `_columns.ts` 的 helper：`id()`、`at()`、`day()`、`createdAt()`、`updatedAt()`、`json()`、`jsonOrNull()`、`oneOf()`、`searchColumns()`。
- 主键是 `id()`（text）；新行 id 由 service 用 `newId(kind)`（`ids.ts`）生成，数据库不发号。
- id 必须能按含义重算时（幂等准入，如 Automation 一次触发的对话）用 `stableId(kind, seed)`：同前缀、同 ULID 形状，不按时间排序；不要自己拼 uuid。
- 新实体在 `ids.ts` 的 `ID_PREFIX` 登记三字母前缀；同一前缀不复用。
- id 是不透明键：不解析形状，不按 id 排序。1.x 里是 serial 的表新旧 id 混排，`ORDER BY id` 没有时间含义，用 `created_at` / `seq` / `position` / `sort_order`。
- 边界接受旧数字 id：路由与工具用 `toRowId()`（`@greenhouse/utils/id`）或 zod `z.coerce.string()` 规范成字符串，service 只收字符串。
- 时间点 `at()`（timestamptz，ISO 字符串读写）；`created_at` / `updated_at` 用 `createdAt()` / `updatedAt()`（`NOT NULL DEFAULT now()`）。
- 业务日期（项目 / 任务的 start / end / due）用 `day()`（`date`，`YYYY-MM-DD`）。
- JSON 用 `json(name, fallback)`（`jsonb NOT NULL`，默认 `{}` / `[]`）；只有 null 本身有含义才用 `jsonOrNull()`。语义性可空的文本列（`messages.reasoning`、`kb_documents._enriched_at`）保持可空。
- 枚举是 `text('col', { enum: VALUES })` + `oneOf('chk_<表>_<列>', col, VALUES)`；改取值同时改 CHECK（会生成迁移）。
- 浮点用 `doublePrecision()`；计数与金额（微美元）用 `bigint({ mode: 'number' })`。
- 每张表显式定义索引；唯一约束命名 `uq_*`，索引 `idx_*`，CHECK `chk_*`。
- 软删：可恢复的用 `archived_at`，带回收站的用 `deleted_at`，其余硬删 + 级联。
- 密钥存 `_enc` 列（AES-256-GCM，`PROVIDER_TOKEN_ENCRYPTION_KEY`）；能哈希的只存 SHA-256。

### jsonb 读写

- 查询构建器（`db.select()...`）读 jsonb 得到已解析的值，写入传对象，不要 `JSON.stringify`。
- 原生 `db.execute(sql…)` 读 jsonb 得到的是 TEXT：drizzle 的 postgres-js 客户端关闭了驱动的 JSON 解析。
- 两条路径的结果都用 `safeJsonParse(value, fallback)`（`@greenhouse/utils/json`）读，它同时接受已解析的值和文本。
- 原生 SQL 写 jsonb 用 `${JSON.stringify(v)}::jsonb`；PG 的 jsonb 存不了 `\u0000`，写入前去掉 NUL。

### 数字类型转换

- 原生 `execute()` 返回的 `COUNT(*)`、`SUM()`、bigint 是字符串，一律 `Number()` 包。
- 查询构建器的 `bigint({ mode: 'number' })` 已自动转换。

### 外键策略

- 同域强归属（project → task → comment、conversation → message、run → step）用 `.references()` + `onDelete: 'cascade'` 或 `'set null'`。
- 审计、用量、通知、运行、遥测类表与跨域主体引用不设 FK，只在 db-schema.md 记逻辑关联；它们的生命周期独立于被引用对象。
- 加 / 删 FK 或逻辑引用时更新 db-schema.md 的 FK 表、逻辑关联表和关系图。

### 单组织

- 没有 organizations 表，没有 `org_id` 列；不要为多组织预留列。
- platform kernel 的 `ActorContext.orgId` 与 `db.platform` 方法的 `orgId` 参数保留形状，宿主固定传 `'default'`（`PLATFORM_ORG_ID`）。

### Schema 迁移

- 配置与产物在仓库根：`drizzle.config.ts` + `drizzle/`，命令必须在仓库根运行（`pnpm --filter @greenhouse/db exec drizzle-kit ...` 会解析错路径）。
- 迁移链从 `drizzle/0000_v3_baseline.sql` 起；`drizzle/archive-1x/` 是 1.x 的 0000–0013，只读，只用于识别 1.x 库，不改不删。
- 改 schema：改 `schema/*.ts` → 仓库根 `pnpm drizzle-kit generate`（相对 baseline snapshot 生成 `0001_*`…）→ review SQL → 连代码一起提交 → `pnpm db:migrate`。
- 应用迁移只用 `pnpm db:migrate`：它加 advisory 锁、先做版本识别再跑 drizzle 迁移器。不直接跑 `drizzle-kit migrate`。
- 迁移文件是 schema 的唯一事实源；有数据或共享的库只 migrate 不 push，`push` 只用于用完即弃的 scratch 库。
- CI 测试库用 `pnpm db:migrate` 建，每个 PR 都跑一遍迁移链。
- review 生成的 SQL 时盯：类型转换缺 `USING`；给有数据的表加 `NOT NULL` 没 `DEFAULT`；改列名被生成成 drop + add（手改为 `RENAME`）；需要回填的自己补 SQL。
- 不写假设表已存在的迁移；建表让 `generate` 生成。
- `drizzle/meta/_journal.json` 每个条目都要有对应 `NNNN_snapshot.json`；手写 SQL 迁移也要补快照。`./node_modules/.bin/drizzle-kit check` 校验链。
- 新增 baseline 之后的迁移不得改 `0000_v3_baseline.sql`。
- `pnpm cli db baseline` 只用于收编已有表但没有迁移记录的库（先 `--dry-run`）。
- 扩展的表走扩展迁移车道（`extension-migrations.ts`、`extension_migrations` 表），不进 core `drizzle/`。
- `pnpm db:migrate`（`applyAllMigrations`）在同一把 advisory 锁下先跑核心链、再跑已启用扩展的车道；API 启动再跑一次车道（幂等）。
- 扩展迁移文件头 `-- greenhouse:core-generation 1x` 表示写给 1.x 核心表：3.0 永不执行。未搬家的库记为已满足并报 skipped；搬家库有记录就不动；搬家库里该扩展有记录却缺这一行就拒绝启动（去 1.x 补跑再搬）。
- 标记行不计入 checksum（未标记文件的 checksum 与原来逐字节相同）；已应用的文件可以补标记。
- 核心表名由 `coreTableNames()` 从 `drizzle/` 迁移链推出；非 1x 的扩展迁移 `CREATE TABLE` 核心表名时车道拒绝。
- `pnpm cli db status` 列出核心链与每个扩展迁移的代际和状态（applied / pending / skipped / missing）。

### migrate-from-1x

- 命令：`pnpm cli migrate-from-1x --from <1.6 库> --to <新库> [--dry-run] [--json]`（也可 `pnpm migrate-from-1x`）；实现在 `carry/from-1x.ts` 与 `carry/extensions.ts`。
- 只接受 1.6.x 源库（迁移到 `0013_report_templates`）；拒绝 2.x、更早的 1.x、1.x 或非 Greenhouse 的目标库、同一个库两次。
- 源库只读，永不写入。
- 目标库为空时先套 3.0 baseline；已有数据时先清空，所以可重复跑直到对账报告干净。`--dry-run` 不需要 `--to`，只出报告。
- 按域逐表搬：保留原 id（serial 转十进制字符串），JSON 文本转 jsonb，日期转 date，表格配置 / 单元格 / 快照里的表 id 改成字符串，非法 JSON 换默认值并记 note。
- 折叠：会话置顶 → `conversations.pinned_at` / `conversation_share_reads.pinned_at`；自定义 Agent 的当前版本 → `run_profiles`。
- 合表记来源（判别列 + 报告）；serial id 可能撞车的来源加前缀：`pac_`（project_activities）、`esl_`（email_send_log）、`frc_`（tool_frictions）、`kbs_`（knowledge_base_shares）、`tbm_`（table_base_members）、`pin_`（置顶折成的 share read）。
- 扩展表（1.x core 链没建过的 public 表，如 `crm_*` / `sellfox_*`）和 `extension_migrations` 原样复制：按源库 catalog 重建 DDL，COPY 流式搬数据，序列位置同步。
- 扩展表与 3.0 核心表重名：`--dry-run` 写进报告（`extensionClashes`），真跑在写入前拒绝。报告的 `extensionMigrations` 按已启用扩展的车道逐文件列出代际与 3.0 的处理（carried / pending / skipped / missing）。
- 不搬：退役表（eval、Missions、Workflows、api_clients）、已删功能（Home 工作台偏好、会话标签、用户组、文档评论 / 互链、表格表单 / 仪表盘 / 表内自动化 / 表格通知、组织、个人权限覆盖、app releases）、已结算 Run 30 天前的事件、已投递 outbox、过期凭证、限流桶、30 天前的请求日志、评测数据。每一行跳过都带原因计入报告。
- 1.6 没有 MCP 客户端表：`mcp_connectors` 与 `mcp:<id>` 连接不搬，搬完的库从空连接器开始。
- 加新表或改表时同步更新 carry 的映射，并用 `carry/v1-fixture.ts`（归档链 + `tests/fixtures/v1-6-seed.sql`）的测试覆盖。

### 保留期

- 每日清理只在 `services/retention.ts`（`db.retention.run()`）：run_events 30 天（只删已结算 Run、且没有待投递 outbox 的事件）、run_outbox 投递后 7 天、request_log 30 天、feishu_receipts 7 天、budget_ledger 13 个月、notification_deliveries 终态后 7 天，以及过期的 refresh token、OAuth code / token、login_states、rate_limits、过期 30 天的 password_links。
- 删除分批（每条语句 `batchSize` 行，`maxBatches` 封顶），不持长锁。
- 调度在 `apps/api/src/upkeep/retention.ts`：启动 10 分钟后首跑、之后每天一次；20 小时内审计里已有一次就跳过；每次结果写一条 `audit_events`（`platform` / `retentionCleanup`，summary 是各表删除行数）。
- 改窗口改 `RETENTION_POLICY`，同步 db-schema.md「保留期」与 migrate-from-1x 的跳过规则。
- 其余永久事实（runs、notifications、audit_events、usage_events、budgets）没有删除 service，不加 TTL。

### users.preferences

- `users.preferences` 是跟账号走的偏好 blob：`fontScale`（0.9 / 1 / 1.1 / 1.2 / 1.35）；类型与 zod 在 `@greenhouse/types/preferences`。
- 读写只经 `db.users.getPreferences()` / `mutatePreferences()`（锁用户行的 read-modify-write）；不在事务外整 blob 覆盖。
- `GET / PATCH /api/me/preferences` 只改成员可编辑的键，未知键拒绝。
- 偏好不承载授权；读到损坏或旧版本数据回落默认值。

### 身份与凭证

- 有效角色只有 `team` 与 `super`；`external` 只存在于搬来的 disabled 行，中央鉴权拒绝其 token。
- `users.auth_version` 是凭证代数，`auth_refresh_tokens.auth_version` 记签发代数；改密走 `users.resetPasswordAndRevokeSessions()`，同一事务改密码、递增代数、删全部 refresh token；access / refresh / WebSocket 都与当前代数比对。
- `password_links` 只存 32-byte 随机 token 的 SHA-256；签发、重发、撤销、消费与账号停用先锁 `users` 再锁链接；消费在同一事务校验用途 / 状态 / 过期 / 代数并完成写密码、激活、递增代数、撤销 refresh token；重置签发即把账号置 `reset_required`、密码改不可登录哨兵并撤销旧会话。
- `rate_limits` 只经 `rateLimits.hit(key, expiresAt)` 写：单条 `INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`；窗口起点放进 key；`sweepExpired()` 删过期桶。
- `login_states.id` 只存值的 SHA-256（service 里哈希）；消费只经 `oauthLoginStates.consume()` 的单条条件 UPDATE；TTL 由调用方给（state 10 分钟、兑换码 60 秒）。
- `gateway_keys` 只存 SHA-256（`create` / `findBySecret` 收原值）；可用性由调用方用 `gatewayKeyUsability` + 用户状态判断；撤销只打 `revoked_at`，首次撤销为准。
- 会话、自动化与自定义 Agent 的基础 Profile 默认 `team`。
- 连接器（`db.mcpConnectors`）：service 只存密文，加解密（带 AAD）在 `apps/api/src/connectors/`；改 `url` / `transport` / `auth_mode` / `auth_kind` 与删除连接器在同一事务删全部成员凭证（`dropCredentials`）；OAuth 刷新与团队登录写入都是比较后写（只覆盖自己读到的密文）。
- MCP、Agent 代理与其他内部集成必须绑定真实内部用户；新写入的主体不能是匿名身份。
- `request_log` 新行只写 `a2a`（MCP `recordMcpAudit`）与 `cli`（Agent 代理）；`api` / `relay` 只是搬来的历史。
- 已删除功能的表不以兼容或占位为由加回来。

### 权限（`db.platform`）

- 表：`roles`、`role_members`、`role_capabilities`、`role_entity_policies`（`schema/access.ts`）；service `services/platform.ts`。
- 判定是角色 allow > 默认 deny；没有个人级能力 / 实体策略覆盖，也不存应用 release。
- 成员一条 `role_members` 都没有时，`getAuthorizationSnapshot` / `getEntityPolicySnapshot` 按 `users.role`（且 `status=active`）落到同名受保护角色（super / team）：补上手工复制账号行、SQL 改角色到下次 bootstrap 同步之间的空窗。只要有任何一行就只认绑定，换到更窄角色的成员不会被放宽。
- 能力与实体策略由核心和扩展 manifest 声明；`scopes` / `field_policies` 进入内核前解析为 `@greenhouse/platform-kernel` 类型。
- 每成员的 feature flag 与可选工具在 `user_grants`（`kind=feature` / `tool`），经 `db.userFeatures` / `db.userTools`。
- `audit_events` 对主体与资源都是逻辑关联，无 FK。

### OAuth 2.1（`db.platformOAuth`）

- 表：`oauth_clients`、`oauth_grants`、`oauth_codes`、`oauth_tokens`（`schema/oauth.ts`）；service `services/platform-oauth.ts`。
- OAuth 是唯一的机器凭证；不复活 `api_clients`。
- code、access token、refresh token 原文不落库，只存 SHA-256；scope / resource / 过期 / 撤销持久化并逐请求校验。
- scope 列存实际授予的内容，读出不加工；解析器没有「缺资源组视为全部」的分支。
- 撤销 grant、禁用 client、改 grant scopes 在同一事务撤销既有 token（scope 变化同时作废未用 code）；签发 token 锁定并复核当前 grant。
- `oauth_grants.avatar` 是成员给已连接 Agent 选的植物头像（`@greenhouse/types/agent-avatar`），null = 客户端默认。

### 对话

- `conversations.digest` / `digest_upto_seq` 只经 `sessions.advanceDigest()` 写（锁行比较后写，只前进）；改动 `seq ≤ digest_upto_seq` 消息的 service 方法同一事务调 `resetDigestIfFolded`。列表查询用 `sessionListColumns`，不带摘要正文。
- `messages.content` 是 Markdown 正文；引用、图片、pipeline 在 `parts` jsonb（`MessageParts`），不加平行列。
- 置顶：owner 写 `conversations.pinned_at` / `pin_position`，共享收件人写 `conversation_share_reads.pinned_at` / `pin_position`，只经 `db.sessionPins`。
- `sessionReferencesImage()` 是鉴权查询：图片不进 `files`，「这张图属不属于这个会话」只能在 `parts.images` / `parts.pipeline` / `content` 里找；唯一消费者是 `apps/api/src/files/conversation-files.ts`。
- 没有会话评分 / 反馈 / 子会话谱系 / 标签 / 分组；不加回来。

### 知识库

- 文档在 `kb_documents`，版本在 `kb_versions`，单人分享在 `shares`（`resource_type='kb_document'`），目录在 `folders`（`scope='kb'`）。
- `knowledgeBase.create/update` 写完同步调 `onKnowledgeDocChange` 监听（API 推 WS `knowledge.changed`）；新增改内容 / 可见性 / 状态的方法要么走 `update`，要么自己 emit；监听不抛、不阻塞。
- `kb_documents.folder_id` → `folders` ON DELETE SET NULL：文档不因目录操作被删；`drive.deleteFolder` 在 kb 域拒绝还挂着非归档文档的目录。
- 目录改名 / 移动走 `drive.updateFolder(id, {name?, parent_id?})`；移进自己或后代返回 `{ok:false, reason:'cycle'}`。service 只管数据，鉴权在路由层。
- `is_template` 是显式布尔；`listTemplates()` 只列 team 可见模板。
- 编辑态 presence 在进程内存（`apps/api/src/knowledge/presence.ts`），无表。
- `meta.space` 没有写入方，不当分组维度用。
- 没有文档评论与互链。

### 全文搜索

- `kb_documents` 的检索列来自 `searchColumns()`：应用层用 `segmentForFts`（jieba，`services/fts.ts`）写 `search_a`（title + tags）、`search_b`（summary + questions）、`search_c`（content + topics）；`search_tsv` 是生成列 + GIN 索引，配置 `simple`。
- 写路径（create / update / upsert、`updateEnrichment`）每次重算 `search_a/b/c`；存量补齐由启动时的 `backfillKnowledgeTokens` 或 `pnpm cli knowledge reindex`。
- 查询侧用同一个 `segmentForFts` → `buildSegmentedTsQuery`；存储与查询必须走同一分词，否则 token 不对齐。
- AND 命中不足用 OR 补位（两个 pass 都跑，AND 排前，OR 按 id 去重填满），仍不够才 `ILIKE`；`search` 与 `searchShared` 同款，改一处改两处。
- CJK 片段用 `buildSnippet`（按首个命中 token 截原文），拉丁词才用 `ts_headline`。
- `folderIds` 是收窄语义：`undefined` = 不限，空数组 = 零行。调用方传已展开的子树 id（`kbFolderSubtreeIds`）。
- 四条检索 SQL（`search` / `searchShared` / `searchLike` / `searchSharedLike`）都要 SELECT `folder_id`。
- 消息正文没有分词列：查询词用 `segmentForFts` 切词后对 `content` 做 `strpos` 子串匹配，AND → OR 补位，OR 去掉单字词。
- `memories.search()` 刻意用裸 `ILIKE`（记忆正文英文、每人几十行）；规模或语言变了扩 `segmentForFts` 那条线，不造第三套。

### 目录、文件与共享

- `files` 是存储对象的唯一登记处：drive、聊天上传 / 产出、Run 产物都在这里，用 `source` 区分；不另建文件表。
- `chk_files_source_owner` 与 `chk_folders_scope_owner` 约束各 source / scope 的列形状；新增 source 或 scope 要同时改 CHECK。
- 附件关系只在 `file_links`；硬删目标对象的 service 负责删它的链接。
- 单人分享只在 `shares`（文档、目录、文件、表格库）；不为新资源另建成员表。
- `kb_documents.sort_order` 与 `folders.sort_order` 都是 `integer NOT NULL DEFAULT 0`：0 = 没手排过，读侧 0 排最后、其余升序、同值按名称。
- 排序只经 `reorderFolders(ids)` / `reorderDocs(ids)`：一条 `UPDATE … FROM (VALUES …)` 写成 1..n；service 不鉴权、不校验同级，两者在路由层。
- 扩展 scope 的目录与文件由扩展鉴权，core 只认 `owner_key`。

### 表格

- `table_bases.archived_at` / `table_tables.archived_at` / `table_records.deleted_at` 三层软删；`listBasesForUser` / `listTables` / `getSchema` / `queryRecords` 都已过滤，新读路径别漏。
- `restoreRecord` 与 `deleteRecord` 一样 bump `revision` 并 `refreshDependentRollups`。
- `getRecordById` 不过滤 `deleted_at`（回收站与审计要看），`getRecord` 过滤。
- 表格库成员在 `shares`（`resource_type='table_base'`），记录附件在 `file_links`（`target_type='table_record'`，`slot` = 字段 id）。
- 没有表单、仪表盘、表内自动化、表格通知。

### 项目

- `start_date` / `end_date` / `due_date` 是 `date`；`tags`、`dependencies` 是 jsonb 数组。
- 项目与任务的动态经 `db.projects.logActivity()` 写 `audit_events`（`app_id='projects'`），`db.activity` 读；不另建活动表。

### 运行（`db.runtime`）

- 表：`runs`、`run_steps`、`run_tool_calls`、`run_interrupts`、`run_events`、`run_outbox`（`schema/runs.ts`）；service `services/runtime.ts`。只统一执行 envelope、lease / CAS、Interrupt、Event / Outbox，不取代会话转录等领域事实。
- `kind` 里 workflow / mission / subagent / eval 只剩历史行，API 启动时 `settleRetiredRuntimeRuns` 收口遗留的活动 Run。
- Run / Step / ToolCall / Interrupt 的完整 input / output / payload / decision 永久保留，无删除 service；只有 `run_events` 与 `run_outbox` 按保留期清理。
- `run_events` append-only；投递状态只写 `run_outbox`。
- 每个状态 / heartbeat / claim / stale-recovery 变更在同一事务追加 Event + Outbox；Event `seq` 锁 Run 后分配。重复命令先查 `(run_id, idempotency_key)` 并校验 fingerprint。
- 真实工具执行前只走 `runtime.beginToolCallWithAuthority()`：按 Run → Step 加行锁，证明都 running、`desired_state=run`、owner 匹配、两条 lease 未过期；同一事务完成 ToolCall create + pending → running 及 Event / Outbox。`running` 的 worker 丢失转 `uncertain`。
- 跨领域 Run command 走 `executeRunDomainCommand`：`FOR UPDATE` 锁覆盖领域副作用，成功后同事务 CAS 推进并追加 Event / Outbox。
- worker 领取用 `FOR UPDATE SKIP LOCKED`；heartbeat 同时匹配 version、lease owner、未过期 lease 与 desired state。stale Step 只有 driver 给出安全 checkpoint 才终态化旧 attempt 并建新 attempt。
- Automation 的 overlap 约束走 `createRun({single_active_source_kind:true})`（advisory 锁按 `(owner, kind, source_kind)` 串行）。
- Automation 的成功计数与外部通知只从 Run 终态 Outbox 投影：`automation_occurrences` 以 `runtime_run_id` 幂等，计数与插入同事务；`reclaimStaleRuns(at, limit, { outcomeUnknownKinds })` 对 automation 收为 `interrupted` / `runtime_outcome_unknown`。
- `runs.parent_run_id` 是域内 CASCADE；用户、会话、来源、actor、决定人、审计都是逻辑关联。写 step / tool / interrupt 时验证它们属于同一 Run。
- Run 产出的文件写 `files`（`source='run'`，`run_id` 逻辑，细节在 `meta`）。

### 自定义 Agent（`db.customProfiles`）

- 表 `run_profiles`：一行就是当前配置；没有不可变版本表，`version` 只计编辑次数。
- `custom:<id>@<n>` 的旧 pin 解析到当前配置。
- 团队可见只看 `is_shared`，只有 `setShared`（super 路由）能写；新建一律私有。
- 没有审核生命周期、发布、分叉列。

### 通知

- `notifications` 是永久站内事实，按 `(user_id, dedupe_key)` 幂等；只允许改 `read_at`，无删除 service。
- `notification_deliveries` 只表示企微 / 飞书 / 邮件 / 手机推送等 transport；claim、lease、retry、dead_letter 不回写业务 Run、Interrupt 或 Agent；终态行按保留期清理。
- 用户与 Run / Interrupt / Event / Agent 都是逻辑引用；delivery → notification 是 FK CASCADE。
- 手机推送（`mobile_push`）的收件人是 `push_devices.id`；发送前复核，不该推就 `settleDelivery({status:'suppressed'})`，收件人永久没了记 `failed`，都不重试；`dead_letter` 只留给 bug。
- `push_devices` 按 token upsert，`register` 在 token 级 advisory 锁里做：同账号刷新同一行保留偏好；换账号改归新账号并重置偏好；每账号最多 `MAX_ACTIVE_PUSH_DEVICES` 台，多出按 `last_seen_at` 停用最久的。任何路径都不物理删设备。
- 能否投递只有一份判定：`isDeliverable()`（未停用 + 属于这个账号 + `auth_version` 等于当前代数 + 90 天内见过），`listDeliverable()` 是它的 SQL 版，两者同改。

### 用量、预算与计价

- 一次计费调用一行 `usage_events`：`kind=model`（`db.usage.record`）、`kind=service`（`db.metering`）、`kind=audit`（`db.llmCalls`，`call_llm` 子调用的输入输出，无单位，不计入花费）。花费聚合永远排除 `audit`。
- 读必须带 `[since, until)` 半开区间，走 `(…, created_at)` 索引；不写不带区间的全表聚合。
- `cost_usd_micros` 为 null 表示未定价，聚合按 0 计并单独数 `unpriced_calls`；模型目录没有价格时不虚构成本。
- `budgets.kind=account` 是一个 scope 一个周期的硬额度余额，`kind=limit` 是管理员 USD 上限（organization / service / `user` + `*` / `user` + 成员 id），由 `db.metering` 管并按月物化成 account。没有每成员月 token 限额和日消息限额。
- 模型调用先 `reserve` 再做 provider I/O，拿到真实 usage 后 `settle`；只有能确认 I/O 没开始的失败才 `release`。TTL 到期 = 结果未知：sweep 把 estimated 转 spent 并标 `expired`，迟到的真实 usage 只补 / 退差额。
- estimate 是带余量的好估算（`estimateTokens` × 1.25 + `maxOutputTokens`，`apps/api/src/llm/usage-budget.ts`），不是上界；改估算前看 spec 20260813 D2。
- 多账户预留按 account id 排序加锁；缺账户、disabled、周期不覆盖当前时间或余额不足都 fail-closed。一个预留组只放同一 unit 的账户。
- `budget_ledger` 只追加，无 update / delete service（只按保留期清 13 个月前的行）；预留 key、adjustment key、status key 重放返回原结果，同 key 不同参数报 `usage_budget_idempotency_conflict`。
- 用户月周期固定 UTC `[月初, 下月月初)`；比较时间用 epoch，不比字符串表面格式。
- 组织、成员、provider 三层账户记的是同一笔控制效果；组织总成本只取 organization scope，不三层相加。
- `prices` 覆盖 models.yaml / services.yaml，改价只影响之后结算的调用。
- `module_usage_daily` 只存计数：新增计数点用 `usageCounters.increment(kind, key, client)`（API 侧 fire-and-forget 的 `countUsage()`），按 UTC 日单条 upsert；不加用户、参数、内容列，不另建统计表。词表在 `@greenhouse/types/usage`。

### 审计

- `audit_events` 是唯一的「谁改了什么」流：platform 动作、云盘写入、项目 / 任务动态（`app_id='projects'`）、发信（`app_id='email'`、`action_id='send'`）都写这里；不再建平行的活动表或发信日志。
- 只记谁代表谁、对什么、结果如何；不存内容与密钥。
- 日发信限额只数 `email` / `send` 的 `success` 行；失败不计。

### 邮箱

- `email_accounts` 只有 `password_enc` 是密文，连接配置是明文列；只有真正的凭证进 `_enc`。
- 共享的 greenhouse@ 邮箱是部署配置，不进这张表。
- `preset` 只是 UI 提示，不参与代码分支；新增预设改 `@greenhouse/types/email`。

### 记忆与复盘

- `memories.status` 是真相：active → dormant（90 天未用，仍可搜，recall 转回）→ archived / superseded（`superseded_by` 自引用 SET NULL）。service 不物理删，只有成员手动删除用 `delete()`；衰减与合并走 `setStatus`。
- `last_used_at` 只在真实使用时刷新（`touch()`，recall / update），注入不算；排序用 `coalesce(last_used_at, created_at)`。
- `memories.title` 是召回索引，只有它进 system prompt。
- `feedback` 的 `kind=friction` 永不进 prompt；`fingerprint` 的部分唯一索引是聚合契约，改指纹算法（`apps/api/src/frictions/friction-center.ts`）要想清楚存量。
- `record()` 必须是单条 `onConflictDoUpdate`（两个并发写入者），样本集的去重 + 取最新 5 条在同一条 SQL 里算；`sample_sessions` 是逻辑引用。
- `kind=request` 与 `kind=friction` 的列形状由 `chk_feedback_shape` 约束。

### 技能中心

- 扫描状态挂 `skills`（技能级），`scan_version` 记结论来自哪一版；不加版本级冗余列。
- `scanned_at IS NULL` 是「从未扫过」的唯一判据；不把未扫的行刷成 `clean`。
- `setScanResult()` 不动 `updated_at`（目录排序键），并清空人工裁定列；人工裁定走 `setScanDecision()`，只有 super（校验在 `apps/api/src/skills/center.ts`）。

### 云电脑

- `member_computers` 的状态只经 `memberComputers` service 改：每个转换都是带期望状态（结算时带期望 `budget_key`）的 CAS；开机在全工作区 advisory 锁里数在用台数，每成员同时最多一台由部分唯一索引兜底。

### 报告模板

- `report_templates` 只存已校验的定义；可见与编辑规则在 `apps/api/src/reports/templates.ts`。`owner_user_id` 逻辑引用，null = 内置；删除只打 `deleted_at`；`seedIfNeverUsed` 在 advisory 锁里按含已删行总数为 0 才写内置模板。

### 时间格式

- 写入时间戳用 `@greenhouse/utils/date` 的 `nowIso()`；`created_at` / `updated_at` 不传则由数据库填 `now()`，更新时显式写 `updated_at`。

### Schema 文档

- 加 / 改表、列、索引或关系时更新 [db-schema.md](./db-schema.md)：表用途与关键列、FK 表、逻辑关联表、关系图。
- 明确标注 FK 与逻辑关系（`FK CASCADE` / `FK SET NULL` vs `逻辑: column`）。

### 新增表流程

1. 判断 core 还是扩展；扩展表走扩展迁移车道（见 EXTENDING.md）。
2. 在对应 `schema/*.ts` 用 `_columns.ts` helper 定义表、索引、CHECK，更新文件头的表清单，底部导出 Row 类型。
3. 在 `ids.ts` 的 `ID_PREFIX` 登记前缀，service 写入时用 `newId(kind)`。
4. 在 `services/` 写 `createXxxService(db: Db)`，在 `provider.ts` 注册，包根 `index.ts` 导出。
5. 仓库根 `pnpm drizzle-kit generate`，review SQL；`pnpm db:migrate` 应用到本地库。
6. 决定 migrate-from-1x 是否要搬对应 1.x 数据，改 `carry/from-1x.ts`。
7. 高增长表在 `services/retention.ts` 定保留期。
8. 更新 db-schema.md，写 `tests/db/*.db.test.ts`。

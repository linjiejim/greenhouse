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

`knowledge_base` 用 `to_tsvector`/`to_tsquery` + GIN 表达式索引。**FTS 索引由迁移链持有**（drizzle DSL 不追踪表达式索引），运行时不建索引、无 `ensureFtsIndex`。实现在 `services/fts.ts` + `services/knowledge-base.ts`。

- **jieba 分词列**:各表 `_tokens_a/b/c`(`@node-rs/jieba` napi 预编译,无 build 脚本/不进 allowBuilds),写路径(create/update/upsert)与 `updateKeywordsEn`/`updateEnrichment` 每次重算;索引 `idx_kb_fts_seg`。配置 `simple`(分词已在应用层做,PG 只按空格切)
- 权重:kb A=title+tags / B=\_summary+\_questions / C=content+\_topics
- **查询侧同款分词**:`segmentForFts(query)` → `buildSegmentedTsQuery`(单中文字如「低」不被丢弃),三级策略 AND→OR→ILIKE;**存储与查询必须走同一 `segmentForFts`,否则 token 不对齐**
- **CJK snippet**:`ts_headline` 对分词列与原文不对齐,改 `buildSnippet`(应用层按首个命中 token 截原文);拉丁词才继续用 `ts_headline`
- **回填**:迁移只加空列,存量行由启动时的 `backfillKnowledgeTokens`（`apps/api/src/knowledge-backfill.ts`）自动补齐,也可 `pnpm cli knowledge reindex` 手动重算;之后写路径保持同步
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

### 邮箱绑定与发信审计

方案见 [email 复活 spec](../../../docs/specs/20260805-email-revival.md)。

- **`email_accounts` 只有密码是密文，连接配置是明文列**。被删的 0.18.0 版本把整个凭证对象 JSON 序列化后整体加密，结果是任何一次「这个账号连的是哪台服务器」的排查都要先解密，而 host/port 本来就不是秘密。加/改列时保持这条边界：**只有真正的凭证进 `password_encrypted`**（AES-256-GCM，`PROVIDER_TOKEN_ENCRYPTION_KEY`，与 `user_provider_tokens.provider_credential` 同一把钥匙）。
- **共享的 greenhouse@ 邮箱不在这张表里，将来也别加进来**。它是运维所有物：生命周期与任何用户无关，凭证是系统的（与厂商 LLM key 同类，env 是既有惯例）。塞进 per-user 表只有两条路——伪造一个 owner，或让 `user_id` 可空；后者正是 `knowledge_base.user_id` 唯一索引事故的形状。
- **`email_send_log` 刻意不设 FK**（既不指 `email_accounts` 也不指 `users`/`scheduled_tasks`）：它同时是审计与日限计数源，必须比它描述的绑定、任务甚至账号活得久。这与「审计/日志的生命周期独立于被引用实体」的既有 FK 策略一致。
- **日限只数 `status='sent'`**。失败的发送没消耗服务商配额，把它计入会让一个配错的账号顺带锁死用户当天还能用的其它邮箱。
- `preset` 是 UI 提示，**不参与任何代码分支**——真正决定行为的是 host/port/`use_proxy` 那几列。新增服务商预设改 `@greenhouse/types/email` 的表即可，不需要动 schema。

### 知识库组织与协作表(KB v2,迁移链–0028)

- `knowledge_base.folder_id` → `drive_folders(id)` **ON DELETE SET NULL**:文档归属 kb 目录(null=根)。**文档永不因目录操作被删**;`drive.deleteFolder` 在 kb 域额外拒绝仍挂着非归档文档的目录(与子目录/活文件同等对待)。空间(`meta.space`)是历史组织维度,`pnpm cli knowledge migrate-spaces` 折叠进目录后仅作「未归目录」兜底;**2026-08-11 起没有任何写入方**——编辑器表单已删掉该字段,create 时服务端兜的 `'general'` 只为历史读者保留,别再把它当可用的分组维度。
- 目录改名/移动走 `drive.updateFolder(id, {name?, parent_id?})`:**把目录移进自己或自己的后代返回 `{ok:false, reason:'cycle'}`**(祖先链上溯,64 层封顶)——否则整棵子树会脱离根变成不可达环。service 只管数据,scope/可见性/归属的跨域校验在路由层(`PUT /api/drive/folders/:id`)。
- `kb_links{from_doc_id,to_doc_id}`(两端 CASCADE,unique(from,to)):出链在每次保存时由 `rebuildOutlinks(id, markdown)` 全量重建——扫描正文里的规范链接 `#/knowledge/doc/<id>`。反链读反方向,**必须逐条过 `resolveKbAccess`**(否则私有文档标题会经反链列表泄露)。
- `kb_comments`(软删 `deleted_at`):文档级评论,读权限跟随文档。**不进 FTS / `knowledge_query` / `/search`**(spec D10)——讨论不是知识。
- `knowledge_base.is_template`:显式布尔(不塞 meta JSON),`listTemplates()` 只列 team 可见模板。
- 编辑态 presence 是**进程内存**(`apps/api/src/knowledge-presence.ts`,90s TTL),无表;与 `ws/connection-manager.ts` 的全局在线态是两回事。

### 侧栏树的手动排序列

- `knowledge_base.sort_order` 与 `drive_folders.sort_order`（都是 `integer NOT NULL DEFAULT 0`）。**0 = 从没手工排过**，读侧把 0 排在最后、其余按数值升序、同值按名称——所以全 0 的目录就是字母序，加列对存量与 crm/tables 两个 drive scope 是零行为变化。
- `drive.listFolders` 的 `orderBy` 已改成 `(sort_order, name)`，它同时服务 kb/tables 两个 scope；后者永远是 0，拿到的仍是字母序。
- 写入只有 `reorderFolders(ids)` / `reorderDocs(ids)`：一条 `UPDATE … FROM (VALUES …)` 把整组同级写成 1..n，**单语句即原子**，不要退回逐条 update 循环（那会让并发排序写出交错的顺序）。service 不做鉴权也不校验「是否真是同级」——两者都在路由层（见 api AGENTS「知识库侧栏树的排序与整库导出」）。

### Tables 的软删与恢复

- `table_bases.archived_at` / `table_tables.archived_at` / `table_records.deleted_at` 是三层软删；`listBasesForUser`/`listTables`/`getSchema`/`queryRecords` 都已过滤，新增读路径别漏。
- 配套方法：`archiveTable`/`restoreTable`/`listArchivedTables`、`restoreBase`/`listArchivedBases`、`listDeletedRecords`/`restoreRecord`。`restoreRecord` 与 `deleteRecord` 一样 bump `revision`（拿着旧 revision 的客户端不能静默覆盖），并 `refreshDependentRollups`。
- `getRecordById` **刻意不过滤 `deleted_at`**（回收站与审计要看得见已删行），`getRecord` 过滤——两个都要用对。
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

### Custom Agent 版本与治理

- `custom_profiles` 是稳定资产身份，`custom_profile_versions` 是不可变完整 manifest；生产 Service 只能 append，
  不得 update/delete 版本。manifest hash、change log、模型/tools/prompt、purpose/audience/risk/budget/Eval refs 与
  owner backup/review due 必须随版本冻结。
- 任何新版本都撤销原审查：资产回 `draft`，清空 `published_version`、共享、reviewer 与 review date。旧
  `custom:<id>@<version>` 仍可供已 pin 的会话/计划任务/Eval 重放，但不能继续对其他用户发布。
- 共享只能由 lifecycle `pilot` / `verified` 派生；不得直接写 `is_shared=true`。迁移把存量行转成 draft v1，
  并把 sessions/scheduled_tasks/eval_runs 的存量 custom 引用 pin 到 `@1`。
- 自动治理只消费 `listReviewDue(at, limit)` 与 `listActiveWithOwners(limit, afterId)`；状态变更可用逻辑 actor
  `system:agent-governance`。发布未显式给 review date 时，low/medium risk 默认 90 天、high risk 默认 60 天，
  禁止产生永不复核的 pilot/verified。review actor 与版本 created_by/backup snapshot 保持逻辑引用，避免账号删除改写历史。

### 统一 Notification Center

- `notifications` 是永久站内事实，按 `(user_id,dedupe_key)` 幂等；只允许用户修改 `read_at`，生产 Service 不提供删除。完整 payload 与 Runtime/Agent provenance 均保留，不做裁剪或 TTL。
- `notification_delivery_attempts` 只表示 企微/飞书/email 等 transport；SKIP LOCKED claim、lease、retry/dead-letter 都不得回写业务 Run、Interrupt 或 Agent lifecycle。创建站内通知成功后，即使外部送达失败，业务结果仍保持原终态。
- 用户和 Run/Interrupt/Event/Agent provenance 是逻辑引用，保证账号停用或领域事实退役后仍能审计；delivery → notification 是域内 FK CASCADE。

### 新增表流程

1. 在对应的 `schema/*.ts` 文件中添加表定义，并在文件底部导出 Row 类型（`typeof table.$inferSelect`）
2. 在 `services/` 中添加 `createXxxService(db: Db)` 工厂（参数类型同文件定义）
3. 在 `provider.ts` 的 `createDatabase()` 中注册一行
4. 在包根 `index.ts` 加 `export * from './services/xxx.js'`
5. 运行 `pnpm drizzle-kit generate` 生成迁移并 **review 生成的 SQL**（见上「push vs migrate」）；本地可 `migrate` 到 scratch 库自测，**不要 push 到共享/持久库**
6. 更新 `db-schema.md`

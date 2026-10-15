# 数据模型（v2）

更新 2026-10-13 · 状态：草案，M0.3 按此实现，改表时同步本文 · 配套 [PRD](prd.md)、[API v2](api.md)、[服务 Provider](providers.md)、[v1 数据迁移](migration-v1.md)

v2 从零建表：只有一份基线迁移，不继承 v1 的迁移链，也不在 v1 库上原地升级。v1 的历史数据以后用离线 ETL 搬进来，见 [migration-v1.md](migration-v1.md)。

本文写到能照着实现的程度，列不求全。实现以 Drizzle schema 为准，改表时同步本文。共 78 张表，分 10 个领域；v1 加上 PR #64 是 137 张。

## 1. 约定

- 命名
  - 表名用复数 snake_case，词汇只取[术语表](prd.md#5-术语表唯一词汇)；子表带父对象前缀（`agent_versions`、`base_fields`）。
  - 外键列写 `<对象>_id`。资源的主人一律 `owner_id`，作者 `created_by` / `updated_by`，都指向 `members.id`。
  - 表名、列名、枚举值里不再出现 `bot`、`super`、`team`（指角色时）、`session`、`profile`。改名在基线里一次做完。
- 主键
  - `text`，由应用生成「类型前缀 + ULID」，如 `mbr_01J…`、`agt_…`、`cnv_…`。
  - 与 v1 不同（v1 混用自增整数和各式字符串），原因有四：API 只认字符串 ID；ULID 按时间排序，可直接做游标；ID 不可枚举（v1 出过凭递增 ID 打开别人私有记忆的漏洞）；迁移时能由 v1 主键确定性生成。
  - 例外：只追加的流水表和内部队列（`run_events`、`usage_events`、`audit_events`、`vault_access_log`、`base_record_events`、`conversation_inbox`）用 `bigint` identity；纯关联表用复合主键；`providers.id` 是可读 slug，因为模型引用写成 `实例/模型`。
- 时间
  - 时间点一律 `timestamptz`（Drizzle `mode: 'string'`，API 输出 ISO 8601 UTC）。`created_at` / `updated_at` 默认 `now()`。
  - 只有日期的值（如记录里的截止日）以 `YYYY-MM-DD` 存在 JSON 里。时区存 IANA 名称（成员、定时、电脑）。
- 外键：同一领域内的强所有权用 FK，写明 `CASCADE` 或 `SET NULL`。日志、审计、用量、通知、运行历史对成员和业务对象只存逻辑引用，不设 FK，生命周期独立（沿用 v1）。
- 归属与共享：只有一套模型。
  - 每个可共享的对象有且只有一个主人 `owner_id`。主人之外的权限只来自 `shares` 一张表，主体是成员、分组或全员。
  - 继承：文件夹的权限传给其中的文档、文件和子文件夹；表格的权限传给数据表、视图、记录和表单。应用的受众只作用于应用本身。
  - 有效权限 = 主人 ∪ 分享 ∪ 继承，再与成员的模块权限求交；Agent 再与它的授权范围求交（[PRD §8.2](prd.md#82-权限与隐私)）。管理员角色本身不带任何私有内容的读权。
  - 与 v1 不同：v1 每类对象各有一套共享方式和自己的查询、界面：知识库的 visibility 加 `group:<id>` 字符串、Drive 的 visibility / owner、Base 的 team_role 与成员和分组成员、应用受众、会话分享、项目成员、Bot 发布受众 JSON。合成一张表后，鉴权、「分享给我」和审计各只有一条路径。
- 归档与删除
  - `archived_at` 表示用户可见、可恢复的归档：Agent、文件夹、文档、文件、表格、数据表、应用、技能；对话按成员归档，记在 `conversation_members`。
  - `deleted_at` 只用在有回收站的地方：记录和评论。其余「删除」都是确认后的硬删除，按 FK 级联。审计、用量、运行时间线、通知永不删除。
  - 与 v1 不同：v1 用 `status='archived'`、`status='deleted'`、`archived_at` 三种写法表达同一件事。
- JSON
  - 一律 `jsonb NOT NULL`，默认 `'{}'` 或 `'[]'`，用 `.$type<T>()` 标注；zod schema 放在 `@greenhouse/contract`。
  - 要算哈希的内容（Agent manifest、应用 spec、模板内容）存 `text`，保证存下的字节就是算哈希的字节（#64 D7）。
  - 与 v1 不同：v1 把 JSON 存成 text，只是因为改造全部读写路径代价太大；v2 从零开始，没有这个代价。
- 并发：可多人编辑的对象带 `revision`，旧 revision 的写入被拒；有状态机的行带 `version`，每次迁移做 CAS；后台工作用 `jobs` 的租约领取（`FOR UPDATE SKIP LOCKED`）。沿用 v1。
- 搜索
  - 中英文全文检索沿用「应用层 jieba 分词 + PostgreSQL `simple` 配置」。分词结果写进 `search_a` / `search_b` / `search_c`（权重 A / B / C），`search_tsv` 是由这三列生成的 `STORED` 列，GIN 索引建在它上面。入库与查询走同一个函数（`packages/db/src/search.ts`）：中文段落用 jieba，其余按字母数字分词，入库时另存长词里的短词。
  - 用在 `docs`、知识库里的 `files`、`base_records`。Agent、技能、应用、对话标题这类小集合用 `ILIKE`。v2.0 不做向量检索（[providers.md §2](providers.md#2-能力)）。
  - 与 v1 不同：v1 的表达式索引必须和 service 里的表达式逐字一致，否则静默全表扫描；生成列让定义只有一份。
- 文件与存储
  - 字节只经存储 Provider（`providers.resolve('storage')`）读写。数据库只存 `files` 元数据：存储实例 `provider_id`、中性的 `storage_key`、大小、MIME、sha256、状态 `pending → active → deleted`。
  - 对象键由服务端生成（`<前缀>/<purpose>/<file_id>`），从不取自用户输入。没有公开读的对象：图片也有 `files` 行。字节只经签名 URL 读取（`<img>` 与下载链接带不了请求头）：为一个成员签发，一到两小时内有效，读取时重查该成员仍是在职成员、仍可读这个文件；唯一不带成员的是工作区 Logo（登录页要显示）。头像和 Logo 只收真图片（按文件头判断），成为头像后所有成员可见。删除时先删对象、再删行，由后台任务完成。
  - 与 v1 不同：v1 有 6 条上传路径，写死腾讯 COS 的 `cos_key`，图片没有数据库行、靠公开读。
- 机密
  - 只写不读。密文列以 `_enc` 结尾，AES-256-GCM，密文带密钥版本前缀以便轮换，AAD 绑定「表 : 行 id : 列」（密码库另绑定成员）。任何读路径都不返回 `_enc` 列。
  - 两把钥匙：`PROVIDER_TOKEN_ENCRYPTION_KEY` 管服务、连接、连接器和自动化密钥；`VAULT_ENCRYPTION_KEY` 管密码库和电脑备份密钥。
  - 能哈希的就不加密：密码（自描述格式 `scrypt$…`）、刷新令牌、OAuth 授权码与令牌、激活链接只存哈希。
- 审计与用量
  - `audit_events` 是唯一的只追加审计表。它记录谁（成员、Agent、外部客户端或系统）代表谁，对什么做了什么，结果如何；不记内容和机密。
  - `usage_events` 每次 Provider 调用写一条（[providers.md §8](providers.md#8-用量与预算)），是用量和费用的唯一事实。预算的已用量按当月直接汇总它，管理页与调用前的检查用同一个求和；`budget_periods` 的计数缓存尚未启用。M2.4 子运行已启用 `budget_reservations`：按当前 UTC 月在覆盖预算的行锁下预留，调用检查计入其他运行的未过期预留，结束按 usage_events 结算或释放。
  - 与 v1 不同：v1 的审计分散在 `platform_audit_events`、`api_audit_log`、`email_send_log` 三张表；用量分散在 `llm_usage` 和预算账本。
- 迁移
  - 只有一份基线 `drizzle/0000_v2_baseline.sql`，之后照旧只 `generate` + `migrate`，不 `push`。生成列、GIN 和部分唯一索引都写进基线。
  - v2 启动时如果发现库里有 v1 的迁移记录，就拒绝启动并指向 [migration-v1.md](migration-v1.md)。
  - 扩展保留自己的迁移通道（`extension_migrations`），表名用 `ext_<扩展 id>_` 前缀。

## 2. 身份与权限

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `members` | 成员账号 | `email`（唯一，小写）、`name`、`avatar_file_id`、`role`（admin / member）、`status`（invited / active / reset_required / disabled，只有 active 能登录）、`password_hash`、`auth_version`（改密码、停用时递增，令牌和推送设备都比对它）、`locale`、`timezone`、`theme`、`about`（「关于我」，所有 Agent 可读）、`modules`（knowledge / tables / apps / computer 开关）、`notification_settings`（`categories`：needs_you / replies / runs / other × email / feishu / wecom / push，没设的按默认；`previews` 默认关）、`last_login_at` |
| `groups` | 管理员维护的分组 | `name`（唯一）、`description`、`created_by` |
| `group_members` | 分组成员 | 主键 `(group_id, member_id)`，两端 `CASCADE` |
| `refresh_tokens` | 刷新令牌 | `member_id` `CASCADE`、`token_hash`、`auth_version`、`client`（web / ios / android / extension / desktop）、`expires_at`、`last_used_at`；单次消费 |
| `auth_links` | 激活与重置密码的一次性链接 | `member_id` `CASCADE`、`purpose`（activate / reset）、`token_hash`（唯一）、`issued_auth_version`、`expires_at`、`consumed_at`、`revoked_at`、`delivery_status`（shown：只给管理员复制 / emailed：邮箱服务发出 / failed：没发出）；每人最多一条有效 |
| `shares` | 唯一的分享表 | `resource_type`（folder / doc / file / base / form / app / agent）、`resource_id`、`principal_type`（member / group / workspace）、`principal_id`（workspace 时为空）、`role`、`custom_role_id`（→ `base_roles`）、`created_by`；唯一 `(resource_type, resource_id, principal_type, principal_id)` |
| `pins` | 成员自己的置顶 | 主键 `(member_id, target_type, target_id)`、`position`；目标是对话、表格、应用或文档 |

`shares.role` 按对象取值：
- 知识库：viewer / editor。团队空间的条目对全员可编辑，不需要分享行。
- 表格：owner / builder / editor / viewer（custom 随自定义角色）；分组和全员只能是 editor 或 viewer。
- 表单：submitter。应用：已发布 spec 里的角色键。公开 Agent：只有 user。

## 3. Agents

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `agents` | Agent 身份与可变状态 | `owner_id` → `members` `CASCADE`、`is_main`（每个成员恰好一个，部分唯一索引）、`name` / `name_key`（主人名下未归档的唯一）、`role`、`avatar`（植物头像）、`current_version`、`visibility`（private / public）、`published_version`、`paused_at`（管理员暂停）、`publication`（授权范围：知识文件夹、电脑、每人每日上限）、`template_key`、`last_active_at`、`archived_at` |
| `agent_versions` | 不可变 manifest，每次保存追加一版 | `agent_id` `CASCADE`、`version`、`manifest`（text：名字、职责、说明、指令、头像、模型引用、技能、连接器、读写权限、工具过滤）、`manifest_hash`、`change_note`、`created_by`；唯一 `(agent_id, version)` |
| `agent_memories` | Agent 的记忆 | `agent_id` `CASCADE`（必填；没有用户级记忆，共享信息写在 `members.about`）、`member_id`、`title`（召回索引，只有它进提示词）、`content`、`category`（含 log：后台运行完成日志，索引只放最近 7 天标题）、`status`（active / dormant / archived / superseded）、`pinned`、`source`、`superseded_by`、`source_conversation_id`、`last_used_at` |
| `standing_approvals` | 成员在卡片上授予的预先授权 | `id`（sap 前缀）、`agent_id` / `member_id`（CASCADE）、`scope_type`（folder / table）、`scope_id`（逻辑引用）、`actions`、`granted_at`、`revoked_at`；未撤销的 `(agent_id, member_id, scope_type, scope_id)` 唯一；第 3 档不能授予，taint 后不能使用，撤销记录保留 |
| `agent_computers` | Agent 电脑的生命周期 | `agent_id` `CASCADE`、`owner_id`（这台电脑是谁的）、`provider_id`（沙箱实例）、`sandbox_ref`（适配器自己的容器、卷或沙箱 id）、`state`（stopped / queued / starting / running / failed）、`queued_at`（FIFO，同时间按 id 排序）、`state_reason`、`timezone`、`version`、`last_active_at`、`last_started_at`；唯一 `(agent_id, owner_id)`：主人一台，公开 Agent 的发布允许电脑时，使用它的成员各一台；观看、接管和终端用一次性 ticket，连接打开期间刷新 `last_active_at`；后台占用 `background_run_id`（逻辑运行引用）及 `egress_restricted`（退出后直到正常网络恢复）；画面租约 `lease_controller`（member / agent，空 = 无人）、`lease_holder`（持有它的控制画面或浏览器动作）、`lease_until`：成员的控制画面打开期间一直持有并续期，Agent 的每个浏览器动作短暂持有；成员总能拿到，Agent 只在无人持有或已过期时拿到（AGNT-22） |
| `computer_backups` | 加密主目录备份 | `computer_id` `CASCADE`、`provider_id`（存储实例）、`object_key`、`status`（complete / failed）、`bytes`、`error`、`created_at`；最近各 3 条，重置电脑先删除存储对象。密文绑定 owner/computer/backup id，使用部署的 provider 加密密钥，不提供下载地址 |
| `computer_backups` | 电脑家目录的加密备份 | `computer_id`、`owner_id`（逻辑）、`status`、`reason`（idle / admin / migration）、`storage_prefix`、`key_enc`、`format`、`bytes`、`restored_at`；每台电脑最多一条 running；先删对象再删行 |
| `computer_watches` | 电脑上的后台进程结束时唤醒 Agent | `computer_id` `CASCADE`、`agent_id`、`member_id`（以谁的权限唤醒）、`conversation_id`、`job_ref`（按电脑唯一）、`name`、`status`（watching / notified / gone，从 watching 单次认领，7 天无果作废） |
| `agent_mailboxes` | Agent 邮箱（AGNT-30） | `agent_id` `CASCADE`（唯一）、`local_part`（工作区内唯一，小写；默认「名字-随机 4 位」）、`allow_members`（工作区成员的来信能叫醒它，默认开）；域名是 `mail` 能力的默认项 `agent_domain`，改域名就改了所有地址；主人第一次查看时建立 |
| `mail_senders` | 主人放行的发件人 | 主键 `(agent_id, address)`、`agent_id` `CASCADE`、`address`（小写）、`added_by`；主人自己总在名单里，成员按 `allow_members` |
| `mail_messages` | Agent 的来信与发信 | `agent_id` `CASCADE`、`owner_id`（逻辑）、`direction`（in / out）、`status`（screened / delivered；sending / sent / failed）、`screen_reason`（sender / unverified / public_agent / archived）、`provider_id` + `provider_message_id`（来信按 `(agent_id, provider_id, provider_message_id)` 唯一）、`message_id` / `in_reply_to` / `references`、`from_address` / `from_name`、`to` / `cc` / `reply_to`、`subject`、`text`（有上限，供阅读与搜索）、`html_file_id`（HTML 正文存进存储服务）、`attachments`（文件 id、名字、类型、大小、被略过的原因）、`auth`（收信服务器的 SPF / DKIM / DMARC 结论）、`verified`（与发件域对齐通过）、`conversation_id`（卡片所在的对话）、`run_id`（发信的那次批准）、`error`、`woke_at`、`at` |

句柄：主 Agent 是 `main`，按成员解析，与显示名无关（默认名 Greeny，可改）。其他 Agent 是 `agent:<id>`，固定版本写 `agent:<id>@<version>`。v1 的 `sprouty`、`bot:`、`custom:` 句柄不再解析。

## 4. 对话与运行

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `conversations` | 所有消息流 | `kind`（main / direct / chat / room）、`owner_id`、`agent_id`（room 与 v1 归档为空）、`title`、`model`（会话选的模型）、`origin`（web / ios / android / extension / desktop / feishu / assistant / v1）、`external_key`（飞书话题键，唯一）、`context`（页面助手带来的上下文）、`read_only`（v1 归档）、`forked_from_message_id`、`digest` + `digest_upto_seq`（滚动摘要）、`last_seq`、`last_activity_at`；部分唯一：每人一个 main，每个（成员，Agent）一个 direct |
| `conversation_members` | 对话里的人和各自的状态 | `conversation_id` / `member_id` `CASCADE`、`role`（owner / member）、`last_read_seq`（已读回执）、`archived_at`、`added_by`；非房间对话只有主人一行。可见性只看这张表 |
| `conversation_agents` | 对话里额外在场的 Agent | `conversation_id` / `agent_id` `CASCADE`、`added_by`（成员）；房间里各人带来的、被拉进对话的 Agent |
| `messages` | 消息 | `conversation_id` `CASCADE`、`seq`（锁定对话行后分配，唯一 `(conversation_id, seq)`）、`role`（user / assistant / event）、`author_member_id`、`agent_id`、`content`（Markdown）、`blocks`（富结果）、`attachments`（file id）、`quote`、`mentions`、`skill`（`/` 调用的技能、运行的版本与填的变量；部分索引 `messages_skill_runs_idx` 用来找成员最常用的技能）、`rich_blocks`（发送端声明能画的富块，空表示未声明）、`citations`、`steps`（工具摘要，待批步骤内部保存 `approvalStepId`，用于决定后更新同一条摘要；API 不输出该内部关联）、`reasoning`、`event`（加入、转交、交还等系统事件）、`run_id`、`status`（complete / stopped / failed）、`edited_at` |
| `message_feedback` | 对一条回复的赞或踩 | `message_id` `CASCADE`、`member_id`、`rating`（1 / -1）、`comment`、`agent_id`、`agent_version`；唯一 `(message_id, member_id)`；公开 Agent 的主人只读这张表，读不到消息 |
| `message_receipts` | Agent 对消息的处理回执 | `message_id` `CASCADE`、`agent_id`、`status`（queued / processing / answered / skipped / failed / canceled）、`processed_at`；唯一 `(message_id, agent_id)` |
| `conversation_notes` | 对话的共享笔记 | `conversation_id` `CASCADE`、`title`、`body`、`author_member_id` 或 `author_agent_id`、`status`（open / done）、`pinned` |
| `conversation_inbox` | 单写者队列与事件合并 | `conversation_id` `CASCADE`、`kind`（event / continue / run_report / message / mention / handback）、`dedupe_key`（对话内唯一，已消费的也去重）、`ready_at`（默认首条事件到达后二分钟）、`payload`（Agent、成员、来源链、深度超限 / 每日上限的抑制原因）、`consumed_at`；消息 > 决定 > 事件，超限事件照样保留 |
| `handoffs` | Agent 之间的转交 | `requested_by`（成员，权限来源）、`source_conversation_id` / `source_agent_id`、`target_conversation_id` / `target_agent_id`、`run_id`、`chain_key` + `path`（深度、次数、循环限制）、`dedupe_key`（唯一）、`status`、`reply`、`returned_at` |
| `requests` | 「需要你」，唯一的请求模型 | `member_id`（由谁决定）、`kind`（approval / login / takeover / question / proposal）、`subject`（如 tool_write、app_action、agent_create、instructions_update、run_start、tables_plan）、`status`（pending / approved / rejected / answered / handed_back / expired / canceled）、`conversation_id`、`run_id`、`step_id`、`agent_id`、`payload`（不含机密）、`result`、`expires_at`、`decided_by`、`decided_at`、`version`；只从 pending 单次 CAS 结算，结算与执行它的 `request_decided` 任务同一事务写入 |
| `runs` | 运行：Agent 做的一件事。每段对话同时最多一个进行中的回合（部分唯一索引 `runs_one_active_turn_key`），这就是单写者 | `agent_id`、`owner_id`（权限来自谁）、`requested_by`、`kind`（background / turn；turn 是前台回合，不进运行列表）、`source`（conversation / schedule / automation / record / handoff / app）+ `source_id`、`conversation_id`、`parent_run_id` `CASCADE`、`root_run_id`、`title`、`brief`、`status`、`desired_state`、`wait_reason`、租约（`lease_owner`、`lease_expires_at`、`heartbeat_at`）、`attempt`、`deadline_at`、`checkpoint`（长任务的续跑点）、`input`、`output`、`error_code`、`version` |
| `run_steps` | 步骤，重试的最小单位；工具调用是一种步骤 | `run_id` `CASCADE`、`parent_step_id`、`key` + `attempt`（唯一）、`kind`（model / tool / handoff / computer / wait；model 是模型步骤结束时记下的新增回复片段与工具结果，`output.messages`，每步约 2 万字，键 `model:<序号>`，重试从这里接着做，运行详情不列出）、`tool_name`、`risk`（read / tier1 / tier2 / tier3）、`undo_state`（撤销前状态及不受展示截断影响的结果引用）、`undone_at`、`idempotency_key`（运行内唯一）、`request_id`、`status`（含 uncertain：外部结果未知，不自动重放）、`input`、`output`、`error`、`tokens`、`duration_ms`、租约 |
| `run_events` | 只追加的运行时间线 | `run_id` `CASCADE`、`seq`（唯一）、`type`、`payload`、`actor`；运行详情和 WebSocket 进度都读它 |

产物不单独建表：运行产生的文件就是 `files` 里 `run_id` 非空、`purpose=artifact` 的行。

## 5. 知识库与文件

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `folders` | 文件夹树，文档和文件在同一棵树里 | `parent_id` `CASCADE`、`space`（team / personal）、`owner_id`（个人空间必填，团队为空，CHECK 约束）、`agent_id`（Agent 私有参考文件夹的根，唯一；外键不级联：文件夹还在时删不掉这个 Agent，删 Agent 的路径先删掉其中的文档和文件，删成员则一并删掉）、`name`、`sort_order`（0 = 没手动排过）、`created_by`、`archived_at`（归档文件夹时其中所有内容盖同一时间戳，恢复只清这一批）；移动时拒绝成环；最多 32 层，新建和移动在树锁下检查，遍历遇到更深或成环就报错而不是截断 |
| `docs` | 文档 | `folder_id` `SET NULL`、`space`、`owner_id`（同 `folders`）、`title`、`content`（Markdown，唯一事实源；文件地址存不带签名的形式）、`is_template`、`tags`、`meta`（摘要、问题、话题，只作检索元数据）、`version`（保存时比较并加一）、`sort_order`、`search_*`（A 标题与标签，B 元数据，C 正文）、`created_by` / `updated_by`、`archived_at` |
| `doc_versions` | 不可变版本 | `doc_id` `CASCADE`、`version`、`title`、`content`、`change_note`、`created_by`、`agent_id`（Agent 代写时）；唯一 `(doc_id, version)`；新建是版本 1，恢复写一个新版本 |
| `doc_links` | 反向链接 | 主键 `(from_doc_id, to_doc_id)`，两端 `CASCADE`；每次保存由正文重建，读反链时逐条过权限 |
| `comments` | 文档和记录的评论 | `target_type`（doc / record）、`target_id`、`base_id`（记录评论）、`created_by`、`agent_id`（Agent 代写时）、`body`（Markdown）、`mentions`（由正文里的 `[@名字](member:<id>)` 得出）、`deleted_at`、`updated_at`；读权限跟随目标，不进全文检索 |
| `files` | 统一文件服务 | `purpose`（attachment / knowledge / record / artifact / export / import / skill / avatar / branding / mail / tool_output）、`provider_id`、`storage_key`（唯一）、`name`、`content_type`、`size_bytes`、`sha256`、`status`、`owner_id`、归属列按 purpose 填一个（`folder_id` + `space`、`conversation_id`、`base_id`、`run_id`；技能包、头像、品牌由引用它的行持有）、`expires_at`（导出；tool_output 在 30 天后到期）、`meta`、`search_*`（知识库文件：A 文件名，C 文本与 PDF 的文字）、`archived_at`；权限跟随归属。知识库文件的 `folder_id` → `folders` `SET NULL`，`owner_id` 同 `folders`；`meta.doc_id` 是贴进文档的图片（不在树里，权限跟随文档），`meta.sort_order` 是手动顺序 |

「他人正在编辑」与在线状态放在进程内存里，不建表；有多个 API 进程时，各自只看得到连在本进程的人。

已知待办：`files.owner_id` 没有外键，硬删成员、删 Agent 的路径都还没有。到时先由后台任务删存储里的对象再删行；知识库文件不会随 `folders` / `docs` 的级联一起走，要显式处理。知识库文件的 `space` 为空时谁都读不到（不当作团队空间）。

## 6. 表格与应用

结构沿用 PR #64 阶段 0–2，表名从 `table_*` 改为 `base_*`，ID 改为文本。

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `bases` | 表格 | `name`、`description`、`icon`、`owner_id`、`template_key` + `template_version`（从模板创建时）、`created_by`、`archived_at`；团队可见、成员和分组的权限都在 `shares` |
| `base_roles` | 表格的自定义角色 | `base_id` `CASCADE`、`name`（表格内唯一）、`description`、`rules`（`{ tables: { 数据表 id: { access: read / edit, rows: 筛选, hidden_fields } } }`，没列出的数据表看不到）、`position`、`revision`；在 `shares` 里以角色 `custom` 加 `custom_role_id` 分出去，删除角色时这些分享一起删除 |
| `base_tables` | 数据表 | `base_id` `CASCADE`、`name`（表格内未删除的唯一，部分唯一索引）、`description`、`position`、`schema_revision`（字段每变一次加一）、`created_by`、`archived_at`（回收站：记录、字段、视图随它回来） |
| `base_fields` | 字段 | `table_id` `CASCADE`、`name`（表内未删除的唯一）、`type`（text / long_text / number / checkbox / date / datetime / single_select / multi_select / member / url / email / phone / attachment / relation / lookup / formula / rollup / ai / parent / dependency）、`required`、`is_primary`（每表一个，部分唯一索引）、`config`（选项、小数位、成员和关联是否多个、关联的目标数据表；公式存解析后的表达式 `formula` 和结果类型 `result`，查找引用与汇总存 `link_field`、`target_field`、`aggregate`，AI 字段存 `prompt`（字段写作 `{#id}`）、`inputs`、`auto_update`）、`position`、`created_by`、`archived_at`（回收站：值留在记录里，彻底删除时才去掉）；每表最多一个父记录字段和一个依赖字段 |
| `base_field_deps` | 公式、汇总、lookup、AI 字段的依赖边 | 主键 `(field_id, depends_on_field_id)`，两端 `CASCADE`、`kind`（same：同一条记录的字段；link：查找引用、汇总沿着的关联字段；target：关联过去读的字段）；用于反查影响、级联重算、成环检查和自定义角色的隐藏 |
| `base_views` | 视图，含仪表盘 | `base_id` / `table_id` `CASCADE`（仪表盘的 `table_id` 为空）、`name`、`type`（grid / kanban / calendar / gallery / timeline / dashboard）、`owner_id`（空 = 共享视图）、`config`（筛选、排序、分组、列宽；仪表盘的卡片与应用共用一套 schema）、`position`、`revision` |
| `base_forms` | 内部表单 | `table_id` `CASCADE`、`name`、`status`（draft / published）、`config`、`revision`；谁能提交由 `shares` 决定，默认是有新建权限的成员 |
| `base_form_submissions` | 表单提交 | `form_id` `CASCADE`、`member_id`、`record_id` `SET NULL`、`single_submit`；只允许提交一次的表单靠部分唯一索引 `(form_id, member_id) WHERE single_submit` |
| `base_records` | 记录 | `table_id` `CASCADE`、`values`（按字段 id，只有标量字段；关联类和附件在下面两张表）、`computed`（公式、查找引用、汇总、AI 字段的值，失败是 `{ error }`，AI 生成中是 `{ pending, job }`）、`revision`（写入时加一）、`computed_revision`（计算值变化时加一）、`seq`（自增，创建顺序；没有排序的视图按它排，id 保持随机）、`search_*`（A 主字段，B 选项名，C 其他文本）、`created_by` / `updated_by`、`deleted_at` + `deleted_by`（回收站，30 天后由每天的 `base_purge` 任务彻底删除） |
| `base_record_links` | 关联、父记录、依赖的规范边 | 主键 `(field_id, source_record_id, target_record_id)`，三列都 `CASCADE`、`position`；指向回收站里记录的边保留，记录恢复时链接跟着回来；父记录与依赖不能成环 |
| `base_record_files` | 记录附件 | 主键 `(record_id, field_id, file_id)`，`record_id` / `field_id` `CASCADE`、`file_id` → `files`（用途 `record`，`files.base_id` 是所在表格，`file_id` 唯一）、`position`；只能挂自己上传到这个表格、还没挂在别的记录上的文件；记录在回收站里时附件打不开；彻底删除后文件字节在提交后由 `base_discard` 任务删除，一天没挂上的上传由每天的清理删除 |
| `base_record_events` | 记录历史 | `record_id` `CASCADE`、`table_id`、`actor_type`（member / agent / automation / form / import / app / system）、`actor_id`、`type`（created / updated / deleted / restored）、`changes`（字段前后值）、`meta` |
| `base_automations` | 自动化规则 | `base_id` / `table_id` `CASCADE`、`name`、`status`、`trigger`（record_created / record_updated / record_matched / schedule / date_reached / button）、`config`（条件与动作：通知成员、Agent 步骤、webhook）、`run_as`（成员）、`secrets_enc`（webhook 签名密钥）、`revision`、`next_fire_at`、`swept_until` |
| `base_automation_runs` | 自动化执行记录 | `automation_id` `CASCADE`、`record_id`（逻辑）、`trigger`、`status`、`dedupe_key`（唯一）、`revision`（固定的规则修订）、`event_chain`（随 Agent 写入继续传递）、`steps`（Agent 派发后为 queued，API 按关联后台运行的状态展示）、`run_id`（最近 Agent 步骤对应的后台运行，逻辑引用）、`error`、`started_at`、`finished_at`；发送中断标记结果未知，旧修订或来源链循环标记停止 |
| `base_imports` | CSV 导入 | `base_id` / `table_id` `CASCADE`、`member_id`、`file_id`（用途 `import`，导入结束即删除）、`mapping`（`{ header, columns, first, samples }`）、`status`（draft / queued / running / done / failed / cancelled）、`total_rows`、`committed_rows`（重试从这里继续）、`result`（`{ created, skipped, errors（最多 100 条）, more_errors, failure }`）、`expires_at`（草稿 24 小时）；后台任务 `base_import`，去重键 `base_import:<id>:<起始行>` |
| `apps` | 应用 | `base_id` `CASCADE`、`name`、`description`、`icon`、`accent`、`owner_id`、`status`（draft / published）、`draft_spec`（text）、`draft_revision`、`published_version`、`featured`、`archived_at`；受众在 `shares` |
| `app_versions` | 已发布的不可变版本 | `app_id` `CASCADE`、`version`、`spec`（text）、`spec_hash`、`review_status`（pending / approved / rejected）、`reviewed_by`、`reviewed_at`、`draft_revision`、`notes`、`published_by`、`published_at` |
| `base_templates` | 表格模板，可带应用；「项目」是内置模板 | `key`（唯一）、`source`（builtin / published）、`name`、`description`、`owner_id`、`latest_version`、`source_app_id`、`source_base_id`、`archived_at` |
| `base_template_versions` | 模板的不可变版本 | `template_id` `CASCADE`、`version`（semver）、`changelog`、`content`（text：表结构、可选的应用 spec、示例行）、`content_hash`、`scan_status`（passed / blocked）、`review_status`（pending / approved / rejected）、`reviewed_by`、`reviewed_at` |

已建（M2.2 第一、二阶段）：`bases`、`base_roles`、`base_tables`、`base_fields`（全部类型）、`base_field_deps`、`base_views`（含仪表盘）、`base_forms`、`base_form_submissions`、`base_records`、`base_record_links`、`base_record_files`、`base_record_events`、`base_imports`；表格的分享在 `shares`，记录评论在 `comments`，置顶在 `pins`。应用人用部分（#70）已建 `apps`、`app_versions`、`base_templates`、`base_template_versions`；#70 新增 `base_automations`、`base_automation_runs`，规则与执行记录通过 `jobs` 串起触发与动作。「项目」定义仍写在代码里（apps/api/src/modules/tables/templates.ts），并登记为内置模板，复用现有安装器。

后台任务（都在 `jobs`，apps/api/src/modules/tables/worker.ts）：`base_recompute`（记录写入时先在同一事务里算好它自己的计算字段，读到它的别处记录排进这个任务，按块重算并继续向下游传播；关联记录的标题变了、被删除或恢复时，读这些关联的记录也重算；字段新建、修改、删除、恢复后整表重算）、`base_ai_field`（快速模型生成 AI 字段的值，按字段创建者计量与预算，旧任务被新任务取代时不写入）、`base_automation`（与记录变化同事务入队，固定规则修订，通知/webhook/Agent 事件逐步记录进度；来源链和每日唤醒限额交给单引擎）、`base_import`、`base_purge`（每天一次：回收站 30 天以上的记录、过期导入、没挂上的附件）、`base_discard`（提交后删除文件字节）。

与 #64 的差别：
- `table_dashboards` / `table_dashboard_widgets` 并入 `base_views`。
- `table_automation_outbox`、`table_recompute_jobs` 由 `jobs` 承接；`table_app_action_requests` 由 `idempotency_keys` 承接。
- `table_notifications` 删除，自动化通知走 `notifications`。

应用的人用部分（#70）：草稿 spec 为声明式 JSON（页面、复用仪表盘 schema 的卡片、记录／表单／按钮、角色）；每个应用最多 20 页、每页 30 张卡、20 个角色，spec 最多 1 MB。受众存 `shares(app)`，role 为 `use`（沿用表格权限）或 spec 的角色 id。发布和替换受众同一事务，发布消耗 draft_revision；已发布 spec 不修改。应用角色与底层表格权限取交集，多个应用角色的可见行取并集，再与表格规则及卡片查询相交。卡片字段是显示投影，计算依赖的禁读仍由角色规则决定；关联标题按目标数据表的权限裁剪。模板内容仅保留表结构、共享视图、字段依赖和发布 spec；管理员审核后才能安装。模板不包含自动化；#70：custom 卡片的发布版本每次重新待审；审核元数据独立于不可变 spec/hash，管理员决定写审计。绑定以 `{id, card}` 复用该应用的数据卡查询，只能读取表格卡，禁止 custom/external/form/button；不提供写桥。external 卡片保存 connector slug、tool、固定 arguments 和 JSON Pointer map；缓存仅在服务进程内存里存 15 秒，不存凭据或跨成员结果。

表格 Web（#70，T3）不增加存储：公式与提示词草稿只在字段抽屉内；角色抽屉写已有 `base_roles.rules`，分享写已有自定义角色引用；计算值由 API 返回，缓存按 `computed_revision` 更新，客户端不把计算字段放进记录写入。

## 7. 技能

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `skills` | 技能 | `name`（`/` 调用名：小写字母（任何文字）、数字、连字符；团队空间内唯一，个人技能在主人名下唯一，归档后名字仍占用）、`display_name`、`description`、`kind`（package / template）、`space`（team / personal）、`owner_id` → `members` `CASCADE`、`tags`（`official` 只属于 skillhub/ 的官方技能）、`latest_version`、`requirements`（最新版本的运行要求：`{ computer, connectors }`，连接器写 slug）、`scan_status`（pending / clean / suspicious / blocked；只有 clean 能运行）、`scan_findings`、`scanned_at`、`scan_reviewed_by`（审核人，新的扫描结论会清空）、`scan_note`、`download_count`、`archived_at` |
| `skill_versions` | 不可变版本 | `skill_id` `CASCADE`、`version`（semver）、`changelog`、`variables`（模板的填空字段，与 ask_user 的字段相同）、`body`（说明正文：模板的正文，或包的 SKILL.md 去掉 frontmatter）、`bundle_file_id`（规范 ZIP，→ `files`，用途 `skill`）、`files`（包里的文件路径与大小）、`file_count`、`size_bytes`、`sha256`（按内容计算：包的文件，或模板的正文、字段与要求；不是 ZIP 字节的 hash）、`created_by`；唯一 `(skill_id, version)` |

技能装备给哪些 Agent，写在 Agent 的 manifest 里（技能 id 列表），不另建关联表。谁能看到技能只有一条规则（modules/skills/access.ts）：个人技能只有主人；团队技能扫描通过后全员可见，否则只有主人和管理员。技能包的文件按同一规则读取。

## 8. 连接、密码库与服务

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `connectors` | 管理员安装的 MCP 服务器 | `slug`（唯一，模型调用时用，不可改）、`name`、`description`、`url`（不含凭据）、`transport`（streamable_http / sse）、`auth_mode`（none / shared / per_member / oauth）、`auth_header` 或 `auth_query_param`、`auth_prefix`（如 `Bearer `）、`auth_enc`（共享 Key）、`key_help` / `key_help_url`（per_member：成员该粘贴什么）、`oauth_scope`、`oauth_client_enc`（本工作区在对方授权服务器的客户端：动态注册或管理员手填）、`oauth_discovery`（公开元数据缓存）、`allowed_tools`（null 表示全部）、`read_only_tools`（管理员担保只读；服务器标为 destructive 的不算）、`catalog_id`、`tools`（最近一次刷新的工具缓存；失败时保留上一份）、`tools_refreshed_at`、`last_error`、`enabled`、`created_by` `SET NULL` |
| `connections` | 成员接入的外部账号 | `member_id` `CASCADE`、`kind`（connector / feishu / wecom / email）、`connector_id` `CASCADE`（只有 connector 有）、`external_id`（飞书 open_id、企微 userid、邮箱地址）、`display_name`、`config`（邮箱的 IMAP / SMTP 主机、端口等明文设置）、`secrets_enc`（OAuth 令牌、个人 Key、邮箱密码）、`scopes`、`expires_at`（访问令牌到期）、`status`（active / needs_reauth / error）、`last_error`、`last_verified_at`；每个成员每个连接器一条（`kind = connector` 时 `(member_id, connector_id)` 唯一）；`kind = email` 是内置连接器「邮箱」的连接，每个成员一条；飞书和企微的 `(kind, external_id)` 唯一，扫码登录按它找成员。刷新令牌只覆盖它读到的那份密文，并发刷新时轮换后的令牌不会被旧的覆盖 |
| `vault_items` | 密码库条目 | `member_id` `CASCADE`、`label`、`origins`（精确 origin 或 `*.域名`）、`username_enc` / `password_enc` / `totp_enc`（`VAULT_ENCRYPTION_KEY`）、`username_hint`（掩码用户名）、`policy`（ask / auto）、`always_origins`（`ask` 条目不发卡片的站点，只能是 `origins` 里的精确站点）、`agent_ids`（自己的 Agent，空 = 所有 Agent）、`last_used_at` |
| `vault_access_log` | 代填日志，只给成员本人看 | `member_id`、`item_id` `SET NULL`、`item_label`、`agent_id`、`conversation_id`、`origin`（浏览器报告的页面站点）、`action`（fill）、`outcome`（requested / filled / declined / origin_mismatch / no_fields / failed）、`approval`（auto / always / member）；不记录任何值。不并入 `audit_events`，因为管理员不读密码库 |
| `providers` | 服务实例（[providers.md §4.4](providers.md#44-运行时数据库)） | `id`、`capability`、`kind`、`preset`、`name`、`scope`（workspace / personal）、`owner_id`、`config`（非机密）、`secrets_enc`、`enabled`、`last_check`、`created_by`、时间戳；环境变量实例只在内存里 |
| `provider_bindings` | 每个能力用哪些实例 | `capability`（主键）、`instance_ids`（有序，第一个出错时依次回退）、`defaults`（默认、强、快模型，音色；沙箱的电脑容量 `idle_minutes`、`max_running`）、`policy`（是否允许个人 Key，个人用量是否计入组织预算）、`version`（解析缓存按它失效） |
| `oauth_clients` | 外部访问的客户端 | `name`、`redirect_uris`（精确匹配，回环地址可换端口）、`auth_method`（none = 交互客户端 / client_secret_post = 机器客户端，密钥放请求体或 HTTP Basic）、`secret_hash`、`bound_member_id` `CASCADE`、`allowed_scopes`（能授予的上限，null 为不设）、`registration`（dynamic = 自行注册 / admin / builtin = 个人令牌的内置客户端，id 固定为 `personal`）、`status`（active / disabled）、`created_by` `SET NULL`；自行注册后 30 天没人授权的会被清掉 |
| `oauth_grants` | 成员对客户端的授权 | `member_id` / `client_id` `CASCADE`、`resource`、`scopes`（实际授予的，读出不加工）、`status`（pending = 管理员绑定给别人的机器客户端，等本人批准 / active / revoked）、`revoked_at`；唯一 `(member_id, client_id, resource)`；scope 变化或撤销后再授权，旧令牌和未用的授权码一并作废 |
| `oauth_codes` | 授权码（PKCE S256） | 主键 `code_hash`、`grant_id` `CASCADE`、`redirect_uri`、`code_challenge`、`scopes`、`auth_version`、`expires_at`（两分钟）、`used_at`；同一个码再次出现时，这次授权的令牌全部作废 |
| `oauth_tokens` | 访问令牌、刷新令牌、个人访问令牌 | `grant_id` `CASCADE`、`kind`（access / refresh / personal）、`name`（个人令牌）、`token_hash`（唯一）、`resource`、`scopes`、`auth_version`（与成员的不同即失效：改密码、停用）、`expires_at`、`rotated_at`（刷新令牌已换新；再出现即当作被盗，这次授权的令牌全部作废）、`revoked_at`、`last_used_at` |

## 9. 通知与定时

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `notifications` | 站内通知 | `member_id`、`kind`（request / run_done / run_failed / reply / mention / comment / share / automation / skill_scan / budget / system）、`title`、`body`、`target_type` + `target_id`（打开即回到来源）、`request_id`、`run_id`、`agent_id`、`payload`（来源附带的信息，不含内容；送达的路由取自 target、request、run 列；回复与提及带 `message_id`、`seq`，提及另带 `from_member_id`，读会话到该 `seq` 即已读）、`dedupe_key`（每人唯一）、`read_at`；只有已读状态可改；外部送达是 `jobs`（`deliver_notification`，每条通知每个渠道一条，和通知在同一事务里写入） |
| `push_devices` | 手机推送设备 | `member_id` `CASCADE`、`token`（Expo push token，唯一，从不返回）、`platform`（ios / android）、`project_id`（按它分组发送）、`client_ref`（工作站 id，推送里原样带回）、`prefs`（needs_you / done / replies / preview / live_activity，只能收窄成员的设置）、`auth_version`（登记时的，改密码或停用后停推）、`last_seen_at`（90 天未见不推）、`disabled_at` + `disabled_reason`（unregistered / device_not_registered / device_limit，每人最多 10 台）；按 token 登记，换人即归新成员并重置开关；只停用不删除 |
| `schedules` | 定时，只属于 Agent | `agent_id` `CASCADE`、`owner_id`、`name`、`brief`（每次运行的简报）、`quiet`（默认 false）、`computer`、`domains`、`continue_after`（默认 false；触发时四项复制到运行 input）、`skill_id`（可选：按技能运行）、`model`、`cron`、`timezone`、`status`（active / paused）、`next_run_at`、`last_run_at`、`last_run_id`、`last_status`、`run_count` |

## 10. 用量与审计

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `usage_events` | 每次 Provider 调用一条 | `capability`、`provider_id`、`source`（env / workspace / personal / builtin）、`member_id`（以谁的权限调用；公开 Agent 的回合记提问的人）、`agent_id`、`run_id`、`conversation_id`、`model`、`input_tokens` / `output_tokens` / `cached_tokens`（llm）、`quantity` + `unit`（秒、字符、张、分钟、字节）、`cost_micros`（按实例模型目录里的单价估算，没有单价为空）、`estimated`（结果未知、按预留量计费）、`budget_key`、`created_at`；按成员、实例、Agent 加时间建索引，另有时间索引 |
| `budgets` | 预算上限 | `scope_type`（workspace / provider / member / agent / field）、`scope_id`、`unit`（tokens / usd_micros …）、`monthly_limit`、`enabled`；唯一 `(scope_type, scope_id, unit)`。组织即 workspace（`scope_id` 为 `default`），field 是 AI 字段的上限；管理接口开放 workspace、provider、member、agent 四种范围；Agent 主人也可管理自己的公开 Agent 预算，取消发布后保留预算并可继续调整 |
| `budget_periods` | 每个预算每月的计数 | 主键 `(budget_id, period_start)`、`period_end`、`reserved`、`spent`、`version`；周期是 UTC 自然月 |
| `budget_reservations` | 调用前的预留 | `budget_id`、`period_start`、`idempotency_key`（同一次调用涉及的各级预算共用）、`estimated`、`actual`、`status`（reserved / settled / released / expired）、`expires_at`、`member_id`、`run_id`；唯一 `(budget_id, idempotency_key)` |
| `audit_events` | 唯一的审计表 | `actor_type`（member / agent / client / system）、`actor_id`、`on_behalf_of`（成员）、`agent_id`、`client_id`、`request_id`、`action`、`resource_type` + `resource_id`、`scope_type` + `scope_id`（如所在表格）、`result`（success / denied / error）、`summary`（不含内容和机密）、`ip`、`created_at` |

#70：真实 DeepSeek 对话已验证 `input_tokens`、`output_tokens` 与 `cached_tokens` 按模型调用入账；缓存命中率由缓存 token ÷ 输入 token 汇总，不新增缓存计数表。模型目录没有单价时 `cost_micros` 为空，界面单列未定价调用。

公开 Agent 的月度预算复用 `budgets.scope_type=agent` 与 Agent ID；主人或管理员可设 token／美元上限，所有使用者的 `usage_events.agent_id` 一起累计，计量调用前统一检查。

v1 的预算账本不再保留：每次花费都对应一条 `usage_events`；预留过期按估算计费时也写一条（`estimated=true`）。

## 11. 工作区设置与基础设施

运维开关复用 `workspace.settings.kill_switches`，无按成员开关；行锁下合并部分更新并在同一事务记审计。未保存时使用部署配置的默认值。

| 表 | 用途 | 关键列与关系 |
| --- | --- | --- |
| `workspace` | 工作区，只有一行 | `id`（固定 `default`）、`name`、`logo_file_id`、`primary_color`、`settings`（新成员的默认模块权限等非机密设置）、`setup_completed_at`、`updated_by`；机密一律在 `providers` |
| `rate_limits` | 多 API 副本共用的固定窗口限流（可选，默认内存） | `key`（命名空间与请求键的 SHA-256 主键，不存邮箱、IP 或凭据）、`count`、`reset_at`（带索引）；UPSERT 按数据库时钟原子计数，worker 每日清理过期窗口 |
| `jobs` | 通用后台任务队列 | `kind`（如 request_decided、deliver_notification、push_receipts、base_automation、recompute、ai_field、video_poll、file_purge、computer_backup、export）、`dedupe_key`（唯一）、`payload`、`status`（pending / claimed / succeeded / failed / dead / suppressed）、`attempts` / `max_attempts`、`available_at`、`lease_owner` / `lease_expires_at`、`last_error`、`result`（处理中途记下的进度，接手的进程据此不重复执行）；和触发它的状态变更在同一事务里写入；领取即算一次尝试，租约过期（进程死了）回到队列，处理期间持有者续租；`apps/api/src/jobs.ts` 是唯一的入队、领取、续租与结算方式。`request_decided`：每张卡片一条，和批准、拒绝、回答、交还或过期在同一事务里写入，结束 7 天后删除；送达任务结束 30 天后删除 |
| `idempotency_keys` | 有副作用请求的幂等记录 | 主键 `(scope, key)`（scope 如成员 id 或 `feishu`）、`request_hash`、`status`（running / done）、`response`、`expires_at`；承接 `Idempotency-Key` 头、应用动作重放和飞书事件去重；电脑画面与终端的一次性 ticket 也在这里（scope `computer_ticket`，`key` 是 ticket 的 keyed hash，一分钟，用时删除）；OAuth 同意请求同理（scope `oauth_request`，十分钟，归第一个打开它的成员，做出决定时删除）；邮件服务商通知的 nonce 也在这里（scope `mail_notice`，处理成功后记下，Resend 两天、Mailgun 13 小时，同一个 nonce 不再处理） |
| `extension_migrations` | 扩展迁移通道的记录 | 主键 `(extension_id, name)`、`checksum`、`applied_at`；扩展表以 `ext_<id>_` 命名，在各自 SQL 目录维护；启动在事务 advisory lock 下执行，修改、删除已执行文件或前插迁移均拒绝 |

v1 迁移工具的 ID 映射与检查点放在单独的 `migration` schema，不属于基线。

## 12. 细节决定

2026-10-13 按建议采用；实现中发现不成立再改，并在 PRD 变更记录里写一行。

1. 知识库分享沿文件夹向下继承；子项可以加分享，但不能收窄，要收窄就移出这个文件夹。
2. 文档只存 Markdown，不存编辑器 JSON。M2.1 先验证编辑器对表格、提及、图片能无损往返，做不到再加 `content_json` 作缓存。
3. 用一个通用 `jobs` 队列，取代 v1 各自实现的租约队列（`runtime_outbox`、`notification_delivery_attempts`、`table_automation_outbox`、`table_recompute_jobs`）；领域事实仍留在各自的表里。
4. 前台回合也记一条 run（`kind=turn`，不进运行列表）。恢复、计量和「需要你」只有一条路径，代价是 `runs` 的行数随回复增长。
5. 邮箱服务与渠道（Resend、Mailgun、SMTP、飞书、企微、推送）存进 `providers`，capability 取 mail / im / push，见 [providers.md](providers.md#2-能力)。
6. 个人访问令牌复用 `oauth_tokens`（`kind=personal`），挂在内置客户端 `personal` 的授权下，吊销与审计走同一条路；它只能调用 `/api/mcp`。
7. 仪表盘并入 `base_views`（`type=dashboard`），卡片与应用共用一套 schema。
8. 「项目」模板的里程碑放进任务表，用单选字段「类型」区分；依赖和父记录都在同一张表内，时间线只读一张表。
9. 技能 v2.0 只有团队和个人两种空间；需要时再给 `shares` 加 `resource_type=skill`。
10. 消息上不存 token 用量，只在 `usage_events` 里按 run 记。管理员读不到消息，消息上的用量没有读者。
11. 成员默认只停用；硬删除时必须指定接收人，共享对象转给接收人，私有数据随之删除。

M1.7：运行检查点保存 `tainted`、`read_private` 与决定结果，后台审批后用已记录的模型步骤及已完成的工具结果重建上下文。结果 `output` 带 `text` 和 `findings`。运行结束和 `run_report` 汇报任务同事务，汇报消息与通知按运行 / 尝试去重；只有选择 `continue_after` 才产生唤醒事件，静默无发现时跳过跟进。事件唤醒仍是 turn 运行，以后台工具规则执行。

M3 页面会话：`conversations.context` 保存有界对象引用，不保存页面 HTML、密钥或客户端快照。每轮重新验证对象读取权限。

M3.4 计数（#70）：`metric_events` 仅存 identity id、member_id（逻辑引用）、kind（active／assigned／adopted／activated）、key（UTC 日期或产出逻辑引用）和 created_at；唯一 `(member_id,kind,key)`。active 为交办、处理卡片或采纳；assigned 仅成员发送请求，首日激活必须先交办后采纳。首次登录／邀请激活只记一次。同一 run 的 👍、引用、下载和成功的逐次／预批准写入合并计一次；无 run 的欢迎消息／文件使用对象键；撤回评分不抹除已经发生的采纳。管理员读聚合，无内容列、任意 metadata 或新增内容副本。

视频复用 runs（kind background、source conversation、input.media=video）、files（purpose artifact）、jobs（media_video 与 run_report）。checkpoint 保留提交中标记、厂商 ID、进度和轮询序号；提交中断没有已知 ID 时标为结果未知，不再购买生成。原引擎的模型运行领取／清扫排除媒体运行，媒体 worker 按 jobs 租约写状态；完成状态与报告排队同一事务提交。

### 12.7 M2.4 引擎补充（#70）

- `agents.publication.folderIds` 保存公开 Agent 的知识授权根。只接受主人未归档的个人文件夹，排除所有 Agent 私有参考文件夹及其后代。每次知识读取重查发布、受众、主人模块与当前子树；授权不变成成员对文档或文件的直接分享。
- 子运行仍是 `runs.kind=background`，`parent_run_id` 指父回合，`input.helper=true`，`input.model_ref` 固定本次工作区模型；父回合以 `wait_reason=helpers` 等待。每回合最多 3 个，完成只经同一个 `run_report` 唤醒层回传摘要；不单独通知。每个子运行预留 100,000 tokens 的估算额度，成本预算按模型价格计算；没有覆盖预算时仍留预留凭证。
- `files.purpose=tool_output` 的文件始终仅 owner 可读，即使带有 run_id 也不继承对话受众；模型读区间按字符偏移。每日 `engine_retention` jobs 清理过期字节，并删除终态运行 90 天以前的 model 步骤及 Eval 提示快照；工具证据保留。编辑或重新生成删除旧回复时同时清除其模型上下文。
- `runs.checkpoint.eval` 保存当时的提示组装配方、实际工具定义、成员模块与模型输入，供本地 Eval 导出。夹具导出清除凭据字段、Bearer、已知 key 形式和文件签名；导出前仍应使用不含私有业务材料的验收对话。

### 12.8 M3.6 发布形态（#70）

- 回合的 `runs.checkpoint` 增加 `turn_step`、`turn_tools`（已记录的工具数）、`turn_ended` / `turn_waiting`、`reply_id`、`reply_chars`、`sources`：和对应 model 步骤、回复的完整文字在同一事务提交；model 上下文仍有 2 万字上限，界面文字不截断。恢复保留同一 message id，把后续未完成步骤的零散文字截回这个边界；tainted / read_private 继续保留。恢复领取与终止都在对话行锁下重查租约，双副本不会同时续跑。插话的收件消费、成员消息标记、新回复、注入的 model 步骤及检查点也在同一事务提交；恢复沿用新回复 id，已结束的旧回复不变，步骤总上限跨插话和恢复累计。
- 前台租约过期不到十分钟、成员仍有效且仍在对话、最后模型步骤完整、其后没有新工具步骤时才自动续跑。其余保持 interrupted；遗留 running 工具按幂等性记为 failed 或 uncertain。
- `conversation_digest` 是回复结束后写入的摘要任务；`mail_inbound` 只保存已验证的实例 id 和通知引用，由 worker 经 providers 拉信，任务去重并保留接手进度；不把签名、Key 或整封信塞进队列。后台运行和其他 jobs 在排空后交还租约，不消耗停机重试次数；后台 `checkpoint.crashes` 单独累计意外进程中断，成员手动重试归零，`attempt` 仍为模型步骤分代。
- `rate_limits` 仅在 RATE_LIMIT_STORE=postgres 时使用；窗口是所有 API 副本共享的，拒绝请求返回 429，存储故障不会退回单机放行。

### v2.0 交付补充（#70，2026-10-15）

- 基线应用器在迁移锁内建立 ICU `greenhouse_natural` collation（`zh-u-co-pinyin-kn-true`），目录树的名称比较、排序与游标使用同一规则，不改变表结构。Postgres 需要 ICU 支持。
- 语音总计直接从 `usage_events.quantity` 汇总：STT + second → `stt_seconds`，TTS + character → `tts_characters`；不增加计数表或缓存。
- 自动化 Agent 子运行的 `runs.input` 同时保存 `automation_run_id` 和 `automation_action_index`。执行历史按每个步骤关联后台运行；尚未建立运行时保持排队，全部完成后才显示完成。派发器的结束时间不作为 Agent 完成时间。

### 移动端 phase 2（#70）

知识库、表格、评论、表单和 Agent 邮箱共用现有 v2 对象与权限，不新增数据表或迁移。移动端复用 `version` / `revision` 做并发检查；Markdown 与字段值由服务端保存，未保存的输入只暂存在当前原生表单。

### 移动端最新 v2 集成（#70）

移动端只消费既有审批范围、步骤回执、日程 `quiet`、记录交办、应用及不可变发布、运行摘要与发现，不新增数据表或迁移。预先授权由成员在当前 tier2 卡片明确选择，授权和撤销均以服务端对象为准。应用卡片的字段范围和发布版本不由原生草稿扩大；未保存字段只留在当前成员／工作站及该对象的原生表单，身份变化清空。

### 请求展示投影（#70）

`requests.payload` 中的标题、审批摘要与详情保存权限检查后的名称／路径，避免把原始对象 id 显示给成员；未知引用以本地化占位替代。房间公开摘要不包含私有对象名，应用详情沿用应用的字段投影。执行用的 `input`、预先授权范围和批次调用保留原 id；本次没有 schema 或迁移变化。已经保存的历史请求不重写。

### 验收展示与回执（#70）

无新增表、列或迁移。`messages.event.type=write_receipt` 保存入口 `step_id`、同一运行同一数据表的 `step_ids`、逻辑引用 `table_id`、`member_id` 和撤销后的 `undone`；人类文字保存在 `content`，不用客户端重建。撤销逐步更新 `run_steps.undone_at`，与整批逆操作处在同一事务。浏览器截图使用已有 `files.purpose=attachment`、`conversation_id`、`run_id`，当前回复 `attachments` 仅保留最后一张截图，读取继续检查对话成员权限并签发短期 URL。

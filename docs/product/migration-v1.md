# v1 数据迁移指南

更新 2026-10-13 · 状态：草案；迁移推迟，工具未实现 · 配套 [数据模型](data-model.md)、[providers.md §11](providers.md#11-从-v1-迁移m5按需)、[PRD §13](prd.md#13-决定记录)

v1 的历史数据以后由一个离线、单向的 ETL 工具搬进 v2：读 v1 dump，写 v2 库。本文是那个工具和那次操作的指南；v2 的表结构见[数据模型](data-model.md)。

## 1. 原则

- v2 从空库开始。基线迁移建好全部表，ETL 是写入历史数据的唯一途径。v2 发现库里有 v1 的迁移记录就拒绝启动，所以没有原地升级。
- 离线、单向。ETL 只读一份由 v1 dump 还原出的源库，只写 v2 库和 v2 存储；不连线上 v1，也不回写 v1。
- v1 冻结后保持只读，直到 v2 验收通过。保留期内 v1 的库、存储和部署不删、不改。
- 幂等、可重跑。同一份源数据跑几次结果都一样；中断后从检查点继续。
- 只迁核心数据，也就是以后还会用到的事实。过程数据、缓存和已删功能的数据只留在 v1 dump 里。
- 源只接受 v1 最终版的库；更早的部署先升级到 v1 最终版。
- 机密只在内存里解密、再加密。报告和日志不含任何内容或机密。

## 2. 范围

- 迁移，迁完能继续用：
  - 成员与分组；Agent（版本、记忆、公开设置、私有参考文件夹）与密码库。
  - Agents 引擎的对话：主线、Agent 对话、任务会话、房间。
  - 知识库：文件夹、文档、版本、分享、评论、文件。
  - 表格与应用（#64 的全部结构，含成员发布的模板）；项目转为「项目」模板的表格。
  - 技能，含由 Prompt Tasks 转成的模板技能；定时；连接器与成员的连接（飞书、企微绑定和邮箱）；服务配置与品牌；可选的电脑备份。
- 只读归档：旧 Chat 引擎的会话（Web、浏览器扩展、飞书、定时产生的）和已退役的 Agent 群聊。能打开、按标题搜索、导出，不能继续。
- 丢弃：
  - 已删除功能的数据：工作台、Missions、Workflows、Eval、Frictions、Feature Requests、LLM 中继，以及会话标签、文件夹、分享、评分。v2 没有它们的界面。
  - 过程数据：运行历史、通知、用量与审计、待处理的「需要你」。它们只对 v1 当时的状态有意义。
  - 登录与授权状态：刷新令牌、OAuth 授权、推送设备。重新登录、重新授权、重新注册即可恢复。
  - 队列与缓存：冻结前排空，或在 v2 里重算。
- 不迁移的功能如果需要「升级前导出」，那是 `release/v1` 上的工作，不归 ETL。

## 3. 表映射

源是 v1 最终版的 `packages/db/src/schema`：main 上 123 张，加上 PR #64 合并后新增的 14 张（`table_base_roles`、`table_base_group_members`、`table_form_submissions`、`table_automation_secrets`、`table_imports`、`table_record_comments`、`table_record_events` 和 7 张 `table_app*`）。

处理方式：复制 = 改列名后原样写入；转换 = 改结构或改写引用；归档 = 变成只读对话；丢弃 = 不进 v2。

| v1 表 | v2 表 | 处理 | 说明 |
| --- | --- | --- | --- |
| `users` | `members` | 转换 | 角色改名，`external` 不迁 |
| `user_features` | `members.modules` | 转换 | 只取 v2 仍有的模块开关 |
| `user_groups`、`group_members` | `groups`、`group_members` | 转换 | 重名加后缀 |
| `bots`、`bot_versions` | `agents`、`agent_versions` | 转换 | Sprouty 成为主 Agent；manifest 哈希重算 |
| `user_memories` | `agent_memories` | 转换 | 用户级记忆归主 Agent |
| `bot_computer_backups` | `computer_backups` | 转换 | 可选：每台电脑最新一份完整备份 |
| `vault_items` | `vault_items` | 转换 | 重新加密，`bot_ids` → `agent_ids` |
| `sessions`（channel=bots）、`bot_conversations` | `conversations` | 转换 | 可以继续的对话 |
| `sessions`（顶层的 web、browser、feishu、task、api、a2a） | `conversations` | 归档 | kind=chat、`read_only` |
| `messages` | `messages` | 转换 | 只迁已迁对话里的消息 |
| `conversation_participants` | `conversation_members` | 转换 | 非房间对话补一行主人 |
| `bot_conversation_members` | `conversation_agents` | 转换 | owner 并入 `conversations.agent_id` |
| `bot_shared_notes` | `conversation_notes` | 复制 | |
| `bot_feedback` | `message_feedback` | 转换 | |
| `chat_files` | `files` | 转换 | 对象复制 |
| `session_groups`、`session_group_members` | `pins` | 转换 | 只取置顶那组 |
| `drive_folders` | `folders` | 转换 | 只取 scope=kb；tables scope 不再需要文件夹；扩展 scope 交给扩展 |
| `drive_files` | `files` | 转换 | 只取 active；对象复制并校验 sha256 |
| `knowledge_base` | `docs` | 转换 | 正文链接改写 |
| `knowledge_base_versions` | `doc_versions` | 复制 | 丢弃 `content_json` |
| `knowledge_base_shares` | `shares` | 转换 | reader → viewer |
| `kb_links` | `doc_links` | 转换 | 链接改写后由正文重建 |
| `kb_comments` | `comments` | 转换 | 跳过已删除的 |
| `agent_skills`、`agent_skill_versions` | `skills`、`skill_versions` | 转换 | 团队空间；技能包进 `files` |
| `user_prompts` | `skills`、`skill_versions` | 转换 | 模板技能 |
| `scheduled_tasks` | `schedules` | 转换 | 归到 Agent |
| `projects`、`project_members`、`tasks`、`task_comments`、`project_activities` | `bases`、`shares`、`base_records`、`base_record_links`、`comments`、`base_record_events` | 转换 | 「项目」模板实例 |
| `table_bases`、`table_base_members`、`table_base_group_members` | `bases`、`shares` | 转换 | team 可见 → 全员分享 |
| `table_base_roles` | `base_roles` | 复制 | |
| `table_tables`、`table_fields`、`table_field_dependencies`、`table_views`、`table_forms`、`table_form_submissions` | `base_tables`、`base_fields`、`base_field_deps`、`base_views`、`base_forms`、`base_form_submissions` | 转换 | ID 重写；字段类型 boolean → checkbox，user / multi_user → member |
| `table_records`、`table_record_links`、`table_record_attachments`、`table_record_comments`、`table_record_events` | `base_records`、`base_record_links`、`base_record_files`、`comments`、`base_record_events` | 转换 | 引用改写；计算列加载后重算 |
| `table_dashboards`、`table_dashboard_widgets` | `base_views` | 转换 | type=dashboard，组件变成卡片 |
| `table_automation_rules`、`table_automation_secrets` | `base_automations` | 转换 | 密钥重新加密 |
| `table_apps`、`table_app_versions` | `apps`、`app_versions` | 转换 | spec 里的 id 改写，`spec_hash` 重算 |
| `table_app_audiences`、`table_app_pins` | `shares`、`pins` | 转换 | |
| `table_app_templates`、`table_app_template_versions` | `base_templates`、`base_template_versions` | 转换 | 只迁成员发布的 |
| `mcp_servers` | `connectors` | 转换 | 凭据重新加密 |
| `user_provider_tokens` | `connections` | 转换 | 飞书 / 企微身份照搬；连接器的 OAuth 令牌默认要重新授权 |
| `email_accounts` | `connections` | 转换 | kind=email，密码重新加密 |
| `workspace_settings` | `providers`、`provider_bindings`、`workspace` | 转换 | 见 providers.md §11 |
| `usage_budget_accounts` | `budgets` | 转换 | 只取当前周期的上限 |
| `refresh_tokens`、`account_password_links`、`push_devices`、`platform_oauth_clients`、`platform_oauth_grants`、`platform_oauth_authorization_codes`、`platform_oauth_tokens` | — | 丢弃 | 登录与授权状态：重新登录、重新授权、重新注册 |
| `user_tools`、`platform_organizations`、`platform_roles`、`platform_role_bindings`、`platform_role_capabilities`、`platform_role_entity_policies`、`platform_user_capability_overrides`、`platform_user_entity_policy_overrides`、`platform_app_releases` | — | 丢弃 | v2 只有 admin / member、模块权限和 `shares`；报告列出存在的单独授权 |
| `bot_computers`、`bot_process_watches`、`bot_requests`、`bot_inbox`、`bot_message_receipts`、`bot_agent_messages`、`chat_artifact_receipts`、`feishu_conversations`、`feishu_message_receipts` | — | 丢弃 | 运行中的状态：冻结前处理完或排空；电脑按需重建 |
| `sessions`（subagent、workflow、mission、评测） | — | 丢弃 | 引擎内部的会话 |
| `runtime_runs`、`runtime_steps`、`runtime_tool_calls`、`runtime_artifacts`、`runtime_interrupts`、`runtime_events`、`runtime_outbox`、`scheduled_task_runtime_occurrences`、`notifications`、`notification_delivery_attempts` | — | 丢弃 | 运行与通知历史从零开始 |
| `llm_usage`、`usage_budget_reservations`、`usage_budget_ledger`、`platform_audit_events`、`api_audit_log`、`email_send_log`、`vault_access_log` | — | 丢弃 | 用量与审计留在 v1 dump |
| `table_schema_versions`、`table_recompute_jobs`、`table_automation_outbox`、`table_automation_runs`、`table_notifications`、`table_imports`、`table_app_action_requests` | — | 丢弃 | 无界面的结构历史、队列和短期账本 |
| `platform_user_workbench_preferences`、`session_tags`、`session_tag_links`、`session_shares`、`session_share_reads` | — | 丢弃 | 功能已删除，升级前可导出 |
| `agent_workspaces`、`agent_runs`、`agent_run_events`、`agent_artifacts`、`agent_run_approvals`、`agent_run_outbox`、`workflows`、`workflow_runs`、`workflow_node_runs`、`workflow_gates` | — | 丢弃 | Missions、Workflows 删除；成员升级前自行下载产物 |
| `eval_datasets`、`eval_runs`、`eval_results`、`chat_eval_results`、`feature_requests`、`tool_frictions`、`llm_calls`、`api_clients` | — | 丢弃 | Eval、Feature Requests、Frictions、`call_llm`、LLM 中继都已删除 |
| `drizzle.__drizzle_migrations`、`extension_migrations` | — | 丢弃 | v2 有自己的记录 |
| 扩展的 `ext_*` 表 | 扩展自己的表 | 由扩展处理 | 见 §8 |

## 4. 特殊情况

- 成员与角色
  - super → admin，team → member；`nickname` → `name`，`notes` → `about`；`monthly_token_limit` → 成员预算，`daily_message_limit` 丢弃。
  - invited 保持 invited，切换后重发激活链接。`auth_version` 归零，因为令牌一个都不迁。
  - `user_features` 写进 `members.modules`：关掉的 tables → 表格模块关，关掉的 bots → 电脑模块关；memory、cloud-agent 和扩展的开关在 v2 没有对应物。被单独授权过工具的成员列入报告，由管理员改用模块权限。
- 密码与登录身份
  - v1 的密码哈希是 scrypt 的 `salt:key`，原样迁移并加前缀写成 `scrypt-v1$…`。v2 用同样的参数校验，登录成功后改写为 v2 格式。
  - 飞书、企微绑定迁成 `connections`，`external_id` 原样，扫码登录照常。前提是 v2 用同一个飞书或企微应用（open_id 按应用区分），换了应用就要成员重新绑定。
- Agent 与主 Agent
  - 每个 Bot 一个 Agent，版本整段复制；manifest 由版本列拼成，哈希重算，原哈希写进报告。`max_steps` 丢弃。
  - Sprouty（`template_key='sprouty'` 的内置 Bot）→ `is_main=true`。名字和指令仍是 v1 模板原文的，换成 v2 的 Greeny 模板；成员改过的保留。成员已有叫 Greeny 的 Agent 时，主 Agent 保留原名并写入报告。
  - 每个成员必须恰好一个主 Agent：没有 Sprouty 的成员，由 ETL 新建一个 Greeny。
  - 句柄改写：`sprouty`、`team` 和空值 → `main`；`bot:<id>[@v]` → `agent:<新 id>[@v]`；`custom:<id>[@v]` 先经 `bots.legacy_custom_id` 找到 Bot。找不到的引用改为 `main` 并写入报告。只改结构化引用（定时、对话的 Agent），不改消息正文。
  - 公开 Agent：受众拆成 `shares`，月度预算拆成 `budgets`，`public_paused` → `paused_at`，其余授权留在 `agents.publication`。
  - 用户级记忆（`bot_id` 为空）归主 Agent；`drive_folders.bot_id` → `folders.agent_id`。
- 对话
  - Agents 引擎的对话迁成可以继续的对话：与 Sprouty 的私聊 → main；与其他 Bot（含公开 Agent）的私聊 → direct；task → chat；room → room。滚动摘要不迁，第一次回合时重算。
  - 归档：已退役的群聊和旧 Chat 引擎的顶层会话变成 kind=chat、`read_only=true`、`origin=v1`，主人是原 `user_id`，不绑定 Agent。`bottask-` 开头的后台任务会话不迁，汇报已在所属对话里。
  - 消息：正文、seq、作者、时间原样；`references_` → `citations`；`pipeline` 只保留工具摘要（`steps`）；`images` 和 `chat_files` → `files` 并写进 `attachments`；`bot_event` → `event`；token、置信度丢弃；`model` 原样保留，只作展示。
- 知识库与文件
  - 文件夹与文档：visibility team → space team，private → space personal；Markdown 为准，`content_json` 丢弃；archived → `archived_at`；draft 当普通文档迁移，报告列出数量。
  - 正文里已知的 v1 深链（文档、表格记录、项目任务、`/api/upload/<id>` 图片）改写成 v2 的路由或文件引用，再重建 `doc_links`；改写不了的原样保留并计入报告。
  - 字节：`drive_files`、`chat_files`、上传的图片（COS 或 `data/uploads` 里的扁平 id）、技能包、电脑备份逐个复制到 v2 存储实例的新键，校验 sha256 后再写 `files`。源对象一个都不删；两边是同一个桶时做服务端复制。
- 表格、应用与项目
  - 所有 ID 重写。字段配置、公式表达式、记录 `values` 和应用 spec 里引用的表、字段、视图、记录、成员、文件 id 同步改写；`spec_hash` 重算。
  - 公式、汇总、lookup 加载后全量重算，与 v1 的 `computed_values` 抽样比对。AI 字段的值原样保留，不重新生成。
  - 内置模板不迁，v2 启动时自己同步。
  - 项目默认每个 v1 项目一个表格（「项目」模板），保留原来的可见性和成员；`--projects single-base` 可把公开项目合进一个表格。
  - 项目映射：`projects` → 「项目」表的一条记录；`tasks` → 「任务」表（字段照搬，`task_type=milestone` 按模板对里程碑的定义写入）；`parent_id` → 父记录；`dependencies` → 依赖；`project_activities` → 记录历史（meta 标 legacy）；public → 全员 viewer；`project_members` → editor。`tasks.agent_id` 不迁。
- 技能与 Prompt Tasks
  - `agent_skills` 进团队空间；扫描结论和人工裁定复制，`scanned_at` 为空的仍是 pending。
  - `user_prompts` → 模板技能：个人空间，`is_global` → 团队空间；`content` → 版本 1.0.0 的 `body`；`variables` 照搬；`expected_tools` → 运行要求（只作展示）；`shortcut` 或标题 → 技能名，重名加后缀。
- 定时
  - `profile_id` 按上面的句柄规则落到 Agent；`task_prompt` → `brief`；cron、时区、启用状态、`run_count` 复制；`next_run_at` 在切换时重算。
  - `notify_email`、`notify_wecom`、`notify_feishu` 合并进成员的通知设置。`notify_webhook`（群机器人）、`unattended_tools` 和 `max_steps` 不迁，报告列出受影响的定时。
- 连接与授权
  - 连接器配置原样迁移，共享凭据与 OAuth 客户端重新加密；工具缓存切换后刷新。
  - 成员的连接器个人 Key 重新加密后迁移。OAuth 令牌默认标为 `needs_reauth`，因为 v2 的回调地址和 scope 可能变；域名和连接器 OAuth 客户端都不变时，可加 `--keep-oauth-tokens` 保留。
  - 外部访问不迁：外部 Agent 和 CLI 重新授权，机器客户端由管理员重建。v2 的 MCP 工具已经改名，旧 scope 对不上。
- 机密与密钥轮换
  - v1 的密文把 AAD 绑在 v1 的行 id 上（如 `vault:<user_id>:<item_id>:<field>`），ID 一变就解不开。所以每个机密都要用 v1 密钥解密，再用 v2 的 AAD 和密钥加密。
  - ETL 同时持有 v1 密钥（`PROVIDER_TOKEN_ENCRYPTION_KEY`、`VAULT_ENCRYPTION_KEY`，轮换中的还有 `VAULT_ENCRYPTION_KEY_PREVIOUS`）和 v2 密钥，明文只在内存里。
  - 借这次迁移轮换：v2 用新生成的两把加密钥匙和新的 `TOKEN_SIGNING_KEY`。迁移机上的 v1 密钥副本在验收后销毁；v1 部署自己的环境变量保留到 v1 下线。
  - 解不开的密文在 dry-run 里按表计数。这样的密码库条目只迁标签和站点，机密留空，等成员重新填写；这样的连接标为 `needs_reauth`。
  - 电脑备份的对象不用重新加密，只把每份备份自己的密钥（`key_enc`）用 v2 的 `VAULT_ENCRYPTION_KEY` 重新封装。
- 服务配置与环境变量
  - `workspace_settings` 里的 `llm.*`、`media.*`、`search.*`、`bots.computer_*` 写成 `providers` 实例与 `provider_bindings`，`llm.model_pro` 对应 strong 别名；`branding.*` 写进 `workspace`，`theme_tokens` 只取主色。
  - 环境变量由运维按 providers.md §11 改名，如 `LLM_MODEL_PRO` → `LLM_MODEL_STRONG`，`TENCENT_CLOUD_COS_*` / `SKILLS_S3_*` / `BOTS_COMPUTER_BACKUP_S3_*` → `STORAGE_*`；`MISSION_*` 删除。
  - Agent 与定时里写死的 v1 模型 id（如 `flash`、`pro`）改写成 `default` / `strong` 别名。
- 电脑：冻结时对每台电脑做一次「立即备份」。加上 `--computer-backups` 时，ETL 迁移每台电脑最新的一份完整备份（reason 记为 migration），v2 第一次启动那台电脑时恢复家目录。v1 的电脑 id 是成员 id（主 Agent）或 `<成员 id>.<Bot id>`，按此对应到 Agent。
- 分组：v1 的分组是成员自建的，v2 由管理员维护。知识库分享依赖分组，所以全部保留，重名加后缀；报告列出分组和原创建人，由管理员整理。

## 5. 操作步骤

1. 演练：在一份 v1 快照上跑通 dry-run 和正式迁移，按 §6 验收（[roadmap M5](roadmap.md#m5-v1-数据迁移按需)）。
2. 准备：v1 升到最终版；公告停机窗口；备好 v2 的环境变量、新密钥和存储实例。
3. 冻结 v1：反向代理挂维护页，只留管理员入口；停掉定时和自动化；处理完待处理的「需要你」；给每台电脑做一次备份；确认 `bot_inbox` 与 `table_automation_outbox` 已排空；停止 v1 API。
4. 导出：`pg_dump -Fc` 得到 v1 dump，再列出 v1 存储（COS 桶、`data/` 目录）的对象清单，两者各记 sha256。
5. 还原源库：把 dump 还原到一个单独的库，ETL 用只读账号连它。
6. 建 v2：对空库跑 v2 基线迁移，以维护模式启动 v2：只有管理员能登录，定时、自动化和对外发送都不运行。
7. dry-run：`pnpm cli migrate-v1 plan`，审阅报告。
8. 正式运行：`pnpm cli migrate-v1 run`；中断了就重跑同一命令。
9. 验证：`pnpm cli migrate-v1 verify`，再按 §6 人工抽查。
10. 切换：DNS 或反向代理指向 v2；更新飞书、企微应用和连接器 OAuth 的回调地址；解除维护模式；同时发布 v2 的 iOS、Android、浏览器扩展和桌面客户端。
11. 通知成员：重新登录，重新连接标为需要授权的连接器，外部 Agent 和 CLI 重新授权；给未激活的成员重发激活链接。
12. 保留：v1 dump、v1 存储和停止状态的 v1 部署至少保留 90 天；迁移报告存档。

## 6. 验证清单

- 计数：每条映射都满足「读入 = 写入 + 跳过」，每条跳过都有原因。
- 成员：admin 数等于 v1 的 super 数；抽样用原密码登录成功，登录后哈希已改写为 v2 格式。
- 主 Agent：每个成员恰好一个 `is_main`，`main` 句柄解析正确；默认名已改为 Greeny，改过名的不变。
- 权限：对抽样成员，逐个文档、文件夹、表格、应用比较 v1 与 v2 的可读、可写结论，必须完全一致。
- 知识库：抽样文档除链接改写外逐字一致；中英文检索都能命中；反链数一致。
- 文件：抽样下载，sha256 与 v1 一致；`files` 里没有残留的 pending 行。
- 表格与应用：每张数据表的记录数一致；公式与汇总的重算结果与 v1 抽样一致；已发布的应用能按角色打开。
- 项目：每个 v1 项目都有对应的表格，任务数、父子关系和依赖数一致，时间线能显示。
- 对话：可以继续的对话能发新消息；归档对话只读；附件能打开。
- 技能与定时：技能包 sha256 一致，模板技能能用 `/` 调用；`next_run_at` 合理，维护模式下没有触发。
- 机密：密码库条目数一致，抽样代填成功且不显示明文；邮箱连接测试通过；需要重新授权的连接状态正确。
- 服务：`/health` 各能力正常，管理端「测试连接」通过；环境变量里没有 v1 的旧名字。
- 安全：用已知的测试机密搜索报告、日志和临时目录，一处都不能命中。

## 7. 回滚

- 切换前：丢弃 v2 库和 v2 的存储前缀，修正后重跑。v1 一直没动过。
- 切换后：DNS 指回 v1 并解除冻结。v2 期间产生的新数据不会回写 v1，需要时手工导出；所以回滚窗口要短（建议一周内决定），期间不删 v1 的任何东西。
- v2 客户端连回 v1 会提示服务器版本过旧；回滚期间成员用 Web 或旧版 App。

## 8. ETL 工具（待实现）

- 位置：`apps/api/src/cli/migrate-v1/`，复用 v2 的 db service、加密模块和存储 Provider。每个领域一个步骤，按依赖顺序执行：服务与品牌 → 成员与分组 → Agent → 知识库 → 文件 → 表格、应用与项目 → 技能 → 定时 → 连接与密码库 → 对话 → 重建索引与重算。
- 命令：`pnpm cli migrate-v1 plan | run | verify --source <v1 源库 URL> --source-storage <v1 存储配置>`；可选 `--only <步骤>`、`--report <目录>`、`--keep-oauth-tokens`、`--projects per-project|single-base`、`--computer-backups`。目标库和目标存储用 v2 自己的配置。
- 读源库只用 SQL，不依赖 v1 代码；启动时核对源库的迁移记录是否是 v1 最终版，不是就退出。
- 幂等：v2 ID 确定性生成，ULID 的时间取 v1 的 `created_at`，随机部分取 `sha256(v1 表名:v1 主键)` 的前 80 位；写入用 upsert；对象按 sha256 跳过已复制的。
- 检查点：放在 v2 库单独的 `migration` schema 里：`legacy_ids`（v1 表、v1 id、v2 id）和 `steps`（步骤、状态、计数、起止时间）。目标库只能是只跑过基线、或只被本工具写过的库，否则拒绝。
- dry-run 报告：`report.json` 加一页 Markdown 摘要，不含内容和机密。内容包括：
  - 每张 v1 表的读入、将写入、跳过（按原因）；
  - 需要人处理的清单：重新授权的连接、丢掉的 webhook、找不到的 Agent 引用、解不开的密文、缺失的对象、重名的分组和技能；
  - 对象数、总字节和预计耗时。
- 扩展：扩展可以注册自己的 `migrateV1` 步骤，处理自己的 `ext_*` 表和 drive scope；没有注册的扩展数据在报告里列为未迁移。
- 测试：用 v1 种子数据生成一份小 dump，在 CI 里端到端跑 plan、run、verify，覆盖 §3 的每一行。

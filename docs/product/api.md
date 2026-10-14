# API v2

更新 2026-10-13 · 状态：约定已定，待实现（[功能清单](features.md) SYS-02）· 配套 [PRD](prd.md)、[providers.md](providers.md)

v2 和 v1 不兼容，不加 `/api/v2` 前缀，也不保留旧路由。`GET /api/bootstrap` 返回 `api_version: 2`；客户端发现版本不匹配时，提示「请更新 App」。

## 1. 约定

| 主题 | 规则 |
| --- | --- |
| 分层 | 每个领域一个模块：`apps/api/src/modules/<domain>/{routes,service,tools,schema}.ts`。HTTP 路由和 Agent 工具都调用同一个 service，人和 Agent 的能力一致；只有 service 访问数据库服务层 |
| 路径 | 资源用复数名词；只有所属关系才嵌套（`/tables/bases/:id/tables`）；动作写成子路径加动词（`POST /runs/:id/cancel`） |
| 校验 | 所有输入和输出都用 zod schema，并从 `@greenhouse/contract` 导出给 Web、扩展和移动端 |
| 返回 | 单个对象直接返回资源本身；列表返回 `{ items, next_cursor }` |
| 错误 | `{ error: { code, message, details? } }`；`code` 是稳定的 snake_case，客户端按它判断；`message` 给人看 |
| 分页 | 游标分页：`?cursor=&limit=`，默认 50，最大 200。总数单独给（`?count=1`），不和列表混在一起 |
| 时间与 ID | ISO 8601 UTC；ID 是「类型前缀 + ULID」的字符串（如 `agt_01J…`），见[数据模型](data-model.md#1-约定) |
| 鉴权 | Web、移动端、扩展用 Bearer 访问令牌加刷新令牌；`/api/mcp` 只认 OAuth 2.1 访问令牌或个人访问令牌（不认 App 的令牌）；电脑画面和终端用一次性 ticket；文件内容用按成员签发的短期签名 URL，因为 `<img>` 和下载链接带不了请求头 |
| 实时 | 只有一个 WebSocket `/api/ws`，事件为 `{ type, data }`，类型定义在 contract 里。消息增量、运行进度、需要你、通知、在线状态、表格的记录变更（`records.changed`，带每条记录现在的 revision）和结构变更（`base.updated`）都走它；发送消息仍用 `POST` |
| 幂等 | 有副作用的 `POST` 接受 `Idempotency-Key` 头；卡片动作（批准、拒绝）天然幂等 |
| 注册顺序 | 路由挂载顺序有安全含义，保持单链定义；公开路径白名单越小越好 |
| 配置 | 只有 `apps/api/src/config/` 可以读 `process.env`；外部服务一律通过 `providers.resolve()` 获取 |

## 2. 资源

### 2.1 公共与账号

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/bootstrap` | 公开接口：品牌、`api_version`、可用登录方式、`setup_pending` |
| `POST /api/auth/login` · `/refresh` · `/logout` | 登录、刷新、登出 |
| `GET /api/auth/links/inspect` · `POST /api/auth/links/complete` | 一次性链接：查看用途；设密码完成激活或重置，随即登录 |
| `GET /api/auth/feishu/*` | 飞书扫码登录 |
| `GET` / `PATCH /api/me` | 我：名字、头像、语言、主题、「关于我」、模块权限与可用能力（只读） |
| `GET /api/me/usage?period=month\|30d` | 我的用量：总计，按能力、Agent、天；我的成员预算 |
| `/api/me/providers[/:id][/test]` | 我的服务，即个人 Key |
| `GET /api/me/models` | 我能给 Agent 选的模型：为我服务的各实例的模型，按顺序 |
| `GET` / `POST /api/me/connections` · `POST …/oauth/start` · `…/oauth/finish` · `POST …/:id/test` · `DELETE …/:id` | 连接：MCP 连接器账号；飞书 / 企微、邮箱随渠道。`GET` 返回我的连接和我能用的连接器；`POST` 存我自己的 Key（服务器先验证，拒绝时 `key_rejected`）；OAuth：`start` 返回授权地址，回调把 `oauth_state`、`oauth_code` 交给 Web，由发起登录的同一成员 `finish`（别人是 `sign_in_not_yours`）；`test` 用我的连接列工具并记下状态；`DELETE` 断开，OAuth 同时撤销 |
| `/api/me/vault[/:id]` · `GET /api/me/vault/log` | 密码库：列出、新建、读取、修改（留空的值不变，空字符串清除）、删除。用户名、密码、TOTP 密钥只写不读，响应只有标签、站点、掩码用户名和是否已设置；站点是精确 origin 或 `*.域名`，「总是允许」只能是其中的站点，`agent_ids` 只能是自己的 Agent（空 = 全部）。`log` 是本人的代填记录，新的在前，不含任何值。没配 `VAULT_ENCRYPTION_KEY` 时都返回 503 `vault_unavailable` |
| `/api/me/grants[/:id]` · `POST …/:id/approve` | 外部访问：我授权过的客户端（不含个人令牌）；撤销即作废它的全部令牌；管理员绑定给我的机器客户端要我批准后才生效 |
| `/api/me/tokens[/:id]` | 个人访问令牌：名称、scope、有效期（1–366 天），令牌只在创建时显示一次；只能调用 `/api/mcp` |
| `GET` / `POST /api/oauth/consent` | OAuth 同意页 `#/oauth/consent?request=`：`GET ?request=` 看是谁要什么（请求归第一个打开它的成员）；`POST { request, decision, scopes? }` 批准（可少勾）或拒绝，返回 `{ redirect_to }` 交给浏览器 |
| `GET` / `PUT /api/me/notification-settings` | 通知送达设置：`channels`（我此刻能用的渠道：管理员已配置，且对我已连接：邮箱地址、绑定的飞书 / 企微账号、装了应用的手机）、`categories`（`needs_you` / `replies` / `runs` / `other` 各自用哪些渠道，只含能用的渠道；站内总有）、`previews`（默认关）；`PUT` 只改给出的字段 |
| `GET` / `PUT /api/me/push-devices` · `PATCH` / `DELETE …/:id` · `POST …/:id/test` | 推送设备，沿用 v1 的请求与应答形状（App 在 M4 只改路径）：`PUT { token, platform: ios \| android, project_id, client_ref?, prefs? }` 按 token 登记或刷新，返回 `{ device, enabled }`，本部署不推送时 `{ device: null, enabled: false }` 且什么都不存；`GET` 返回 `{ devices, enabled }`；`PATCH { prefs }` 改这台手机的开关（只能收窄我的设置）；`DELETE` 只停用不删除，返回 `{ ok: true }`；`test` 立刻发一条（每台 10 秒一次，错误码 `push_disabled`、`device_disabled`、`too_soon`、`device_not_registered`、`send_failed`）；token 从不返回 |

### 2.2 Agents 与对话

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/agents?scope=mine\|public\|archived` · `POST /api/agents` | Agent 目录、新建 |
| `GET` / `PATCH` / `DELETE /api/agents/:id` · `POST …/restore` | 资料（`main` 可作 id）；`DELETE` 是归档，`restore` 恢复 |
| `/api/agents/:id/versions` · `/memories` · `/schedules` · `/usage` · `/activity` · `/publication` | Agent 资料的各个分页；`/usage`、`/activity` 只给主人，只有计数、结果与评价，没有内容 |
| `PUT` / `DELETE /api/agents/:id/publication` | 发布固定版本给受众（成员、分组、全员），附电脑与每人每日上限；再次 `PUT` 改版本或受众；`DELETE` 取消发布。主 Agent 不能发布 |
| `/api/agents/:id/computer` · `POST …/start` · `…/stop` · `…/restart` · `GET …/processes` · `POST …/ticket` · `…/files[?path=]` · `GET …/files/content?path=` | 电脑：状态、启停、重启（进程结束、文件保留）、后台进程；公开 Agent 的使用者用自己的一台。`ticket` 换取画面（`view` / `control`）或终端（`terminal`）的一次性 ticket，一分钟内用一次；家目录文件按相对路径列出、下载（一律下载）、上传（multipart，最大 50 MB）、删除 |
| `GET /api/conversations?kind=&q=&archived=` · `POST /api/conversations` | 对话列表与新建，`kind` 取 `main` / `direct` / `chat` / `room` |
| `PATCH` / `DELETE /api/conversations/:id` | 改名、置顶、归档、删除 |
| `GET` / `POST /api/conversations/:id/messages` | 分页读取；发送（附件、引用、技能调用、`@` 点名，以及这个界面能画的富块 `rich_blocks`；不声明时只用五种通用块） |
| `PATCH /api/conversations/:id/messages/:mid` · `POST …/:mid/regenerate` · `PUT …/:mid/feedback` | 编辑最后一条、重新生成、👍 / 👎 |
| `POST /api/conversations/:id/stop` · `…/read` | 停止、已读 |
| `/api/conversations/:id/members` · `/notes` · `/export` | 房间成员、共享笔记、导出 Markdown |
| `POST /api/voice/transcriptions` | 语音输入：multipart `file`（录音，最大 25 MB；能从容器读出时长时最长 10 分钟，超出 `audio_too_large` / `audio_too_long`）和可选 `language`，返回 `{ text, duration_seconds }`；没有为我服务的 STT 时 503 `stt_not_configured`，服务商出错 502 `provider_failed` |
| `POST /api/voice/speech` | 朗读：`{ text（纯文本，最多 4000 字）, format?, voice?, speed? }`，返回音频；没有 TTS 时 503 `tts_not_configured`。客户端去掉 Markdown 后分段请求 |
| `GET /api/requests?state=pending` · `POST /api/requests/:id/{approve,reject,answer,handback}` | 需要你：批准、拒绝、回答、交还。登录卡片可以批准（服务端随即代填）、拒绝，或在成员手动登录后交还；接管卡片只能交还 |

### 2.3 运行

| 方法与路径 | 用途 |
| --- | --- |
| `GET /api/runs?state=active\|done&agent=&source=` · `GET /api/runs/:id` | 运行列表与详情（步骤、产物） |
| `POST /api/runs/:id/cancel` · `…/retry` | 取消；只重试失败的步骤 |
| `/api/schedules[/:id]` · `POST …/:id/run-now` · `…/pause` · `…/resume` | 定时，都属于某个 Agent；五段 cron 加时区，最短 15 分钟 |

### 2.4 工作底座

| 方法与路径 | 用途 |
| --- | --- |
| `POST /api/files` · `GET` / `DELETE /api/files/:id` · `GET …/:id/content?exp=&m=&sig=` | 统一文件服务：multipart 上传（预签名直传随 M2），带用途与归属；字节只经 `FileView.url` 读取，它为当前成员签发、一到两小时内有效，读取时重查权限；网页与 SVG 一律下载；替代 v1 的 6 条上传路径 |
| `GET /api/knowledge/folders?space=team\|personal\|shared` · `POST /api/knowledge/folders` · `GET` / `PATCH` / `DELETE /api/knowledge/folders/:id` · `POST …/restore` · `GET` / `PUT …/share` · `GET …/export` | 文件夹树（文件夹、文档、文件同列，先按手动顺序，再文件夹在前，再按名称；名称按数据库的排序规则，顺序和分页都在库里做）：空间根，或「分享给我」的最上层；文件夹带路径与内容。列表和文件夹的内容都分页：`cursor`、`limit`（默认 200，最多 1000），文件夹的下一页在 `next_cursor`（别人分享的东西，路径只含读者看得到的上层文件夹，检索结果与继承的分享同理）。文件夹最多 32 层，新建或移动超过时返回 `folder_too_deep`。`PATCH` 改名或移动：不能移进自己或下层（`folder_cycle`），个人的只能由主人移进团队空间，不能反向、不能跨主人（`cross_space_move`）。`DELETE` 连同其中全部归档，`restore` 只带回一起归档的。`share` 是自己的分享加上从上层继承的；`PUT` 整体替换，只有个人空间的主人（团队空间 `team_space`，Agent 文件夹 `agent_folder_private`）。`export` 是边写边下载的 ZIP |
| `POST /api/knowledge/reorder` · `GET /api/knowledge/archived?space=` · `GET /api/knowledge/export?space=` | 同一层的手动顺序；已归档（只列最上层，新的在前，分页同上）；整个空间导出为 ZIP |
| `GET /api/knowledge/docs?space=&template=` · `POST /api/knowledge/docs` · `GET` / `PATCH` / `DELETE /api/knowledge/docs/:id` · `POST …/restore` | 最近更新的文档（`template=true` 是模板）；新建（空白或 `template_id`）；读取时正文里的文件地址按读者签名。`PATCH` 改标题或正文要带读到的 `version`，旧的返回 409 `stale_version`（`details` 有当前版本、谁、何时）；标签、摘要、模板标记原地改；`folder_id` / `space` 移动 |
| `…/docs/:id/versions` · `…/versions/:v` · `POST …/versions/:v/restore` · `GET …/diff?from=&to=&mode=line\|word` | 版本（新的在前）、某一版、恢复（带当前 `version`，写一个新版本）、对比（两行上下文的 hunks，长的未改动内容截短） |
| `…/docs/:id/backlinks` · `…/comments[/:commentId]` · `…/share` · `…/presence` · `…/export` | 反向链接（按读者权限过滤）；评论（能读就能评，只改、删自己的）；分享（同文件夹）；在线：`PUT { state: viewing\|editing }` 是心跳，`DELETE` 是离开；导出 Markdown |
| `POST /api/knowledge/files` · `GET` / `PATCH` / `DELETE /api/knowledge/files/:id` · `POST …/restore` | 知识库文件：multipart 传到 `folder_id`、`space` 根或 `doc_id`（贴进文档的图片，跟随文档）；返回预览方式（image / pdf / text / audio / video / none）与签名地址；改名、移动、归档。`DELETE /api/files/:id` 对它们返回 `file_governed` |
| `GET /api/knowledge/search?q=&space=&folder_id=&limit=` | 中英文全文检索（文档与文件），只含读者能读的，分数高的在前，带片段和路径 |
| `GET /api/tables/bases?archived=` · `POST /api/tables/bases` · `GET` / `PATCH /api/tables/bases/:id` · `POST …/archive` · `…/restore` · `…/delete` | 表格：我的和分享给我的（带数据表与我看得到的视图；`archived=true` 是我拥有的已归档表格）；新建空白表格（一张数据表、一个表格视图）或从模板新建（`template: project`）；详情是数据表、字段、视图和我的角色；`PATCH` 改名、说明（搭建者）或给自己置顶；归档、恢复、彻底删除只有拥有者，彻底删除要再输一遍名称（`{ name }`） |
| `GET` / `PUT /api/tables/bases/:id/share` | 分享：拥有者加分享列表；`PUT` 整体替换，只有拥有者。角色是 owner / builder / editor / viewer，分组和全员只能是 editor / viewer；新加的人收到通知；写审计 |
| `GET /api/tables/bases/:id/trash` · `…/audit` · `POST …/files` · `POST …/tables` | 回收站：删除的记录、字段和数据表，新的在前（编辑者；超过 30 天的记录先彻底删除）；审计：分享、归档、删除（拥有者）；附件字段的上传（multipart `file`，编辑者，记录引用它时才挂上）；新建数据表（带主字段和表格视图，搭建者） |
| `PATCH` / `DELETE /api/tables/tables/:id` · `POST …/restore` · `…/purge` · `GET …/titles?q=` · `GET …/export?view_id=` | 数据表：改名、说明、顺序；删除进回收站；恢复；彻底删除（连同记录和附件）；记录标题（选择器用）；导出某个视图（筛选、排序、显示的字段）或整张表的 CSV（带 BOM） |
| `POST /api/tables/tables/:id/fields` · `PATCH` / `DELETE /api/tables/fields/:id` · `POST …/restore` · `…/purge` | 字段（搭建者）：文本、长文本、数字、勾选、日期、日期时间、单选、多选、成员、链接、邮箱、电话、附件、关联、父记录、依赖；名称在表内唯一（`name_taken`）；每张表一个父记录字段和一个依赖字段（`one_per_table`）；类型只在值能保留时可改（文本类之间、单选到多选、日期到日期时间，否则 `type_change_unsupported`）；主字段不能删；删除进回收站，所有视图里去掉它，值留到彻底删除 |
| `POST /api/tables/tables/:id/views` · `PATCH` / `DELETE /api/tables/views/:id` | 视图：表格、看板、日历、画册、时间线；个人视图任何能看的人都能建，共享视图要搭建者；配置是筛选、排序、分组、字段顺序、隐藏、列宽、冻结列、行高和各类型的设置；改动带 `revision`，旧的返回 409 `stale_revision`；每张表至少留一个共享视图（`last_view`） |
| `POST /api/tables/tables/:id/records/query` | 查询记录：`{ filter, sorts, group, search, cursor, limit, count }`，筛选里 `$me` 是读者，`$today` 等按读者时区；分组先于排序；游标是带查询指纹的偏移；返回记录（关联、依赖、父记录、附件填好 id）、关联记录的标题、附件的签名地址，`count` 时带总数 |
| `POST /api/tables/tables/:id/records` · `…/records/bulk` · `…/records/delete` | 新建记录；批量粘贴（每条各自成功或失败：`stale_revision`、`invalid_input`、`not_found`）；批量删除进回收站（编辑者） |
| `GET` / `PATCH` / `DELETE /api/tables/records/:id` · `POST …/restore` · `…/purge` · `GET …/activity` · `…/comments[/:commentId]` | 一条记录（带子记录）；修改要带读到的 `revision`，旧的返回 409 `stale_revision`（`details.record` 是现在的记录）；删除进回收站，恢复，彻底删除（搭建者）；活动是评论和变更历史，新的在前；评论（能读就能评，提及的人和记录创建者收到通知；只改自己的，拥有者能删任何一条） |
| `GET /api/search?q=&kinds=` | `⌘K` 全局搜索；`records` 是我能读的表格里的记录（中英文全文检索），带 `base_id`、`table_id` |
| `/api/apps[/:id]/…` · `POST /api/forms/:id` | 应用、表单提交 |
| `GET /api/skills?q=&space=&kind=&scan_status=&archived=&agent=` · `POST /api/skills` · `GET` / `PATCH` / `DELETE /api/skills/:id` · `POST …/restore` · `GET` / `POST …/versions` · `POST …/scan` · `GET …/download?version=` · `GET /api/skills/starters?agent=` | 技能：我看得到的技能，`available` 与原因按 `agent`（默认主 Agent）判断；新建模板，或用 purpose `skill` 上传的 ZIP 新建包；`PATCH` 改显示名、说明、标签，`DELETE` 是归档；新版本（新 ZIP，或模板的新正文、字段、要求）；`scan` 重扫，或审核（`safe` / `malicious`，团队技能由管理员、个人技能由主人）；下载返回包的签名链接；`starters` 是新会话的 3 个常用技能（没有时给模板开场） |
| `GET /api/notifications` · `POST …/read` | 通知 |
| `GET /api/members?q=` · `GET /api/groups` | 成员与分组选择器（只读） |

### 2.5 管理（仅管理员）

| 路径 | 用途 |
| --- | --- |
| `/api/admin/members[/:id]` | 邀请、角色、停用、重置链接、模块权限、预算 |
| `/api/admin/groups[/:id]` | 分组 |
| `/api/admin/providers[/:id][/test\|/copy]` · `PUT /api/admin/provider-bindings/:capability` | 服务：实例、测试连接、复制环境变量实例；能力的顺序、默认项与策略 |
| `GET /api/admin/channels` · `PUT …/:channel` · `POST …/:channel/test` | 渠道 `email`（SMTP）、`feishu`、`wecom`、`push`（Expo）：`GET` 列出每个渠道能否送达（`configured`）、来源（`env` / `workspace`）、设置、哪些机密已填、最近一次成功与失败；`PUT` 保存一个渠道的设置（email：`host`、`port`、`security` tls / starttls / none、`username`、`from_address`、`from_name`、`password`；feishu：`base_url`、`app_id`、`app_secret`；wecom：`base_url`、`corp_id`、`agent_id`、`secret`；push：`base_url`、`access_token`；都可带 `enabled`），机密只写不读、省略即保留、`''` 清空，换主机或地址同时清空机密；第一次保存或改环境变量来的设置时生成工作区实例，排在同类之首；`test` 给管理员自己发一条（邮箱、绑定的账号、手机），没有可发的对象时只验证凭据，返回 `{ ok, delivered, latency_ms, error }` |
| `GET /api/admin/computers` · `PUT …/capacity` · `POST …/:id/stop` · `DELETE …/:id` | 电脑：所有成员的电脑与状态（不含画面和文件）；容量（空闲多少分钟后关机、最多同时开机，0 为不限，超出时开机返回 `computers_full`）；停止；重置（连主目录删除，下次使用重开） |
| `GET /api/admin/usage?period=&group_by=member\|agent\|provider\|capability` | 工作区用量 |
| `GET` / `PUT /api/admin/budgets` · `DELETE …/:id` | 预算：组织、服务实例、成员三级，token 或美元，按月；`PUT` 建立或替换一个范围与单位的预算；列表带本月已用 |
| `/api/admin/connectors[/:id]` · `GET …/catalog` · `GET …/registry?q=` · `POST …/probe` · `POST …/:id/refresh` · `…/test` | 安装连接器：内置目录（`{ catalog_id }`）、Registry 搜索（慢，服务端缓存）、URL（`probe` 先看要哪种鉴权）；鉴权 none / shared / per_member / oauth，共享 Key 与 OAuth 客户端密钥只写不读；工具缓存（`refresh` 重列，per_member / oauth 用管理员自己的连接）、白名单、只读工具；启用 / 停用；改地址或鉴权方式会断开所有成员的连接 |
| `/api/admin/clients[/:id]` · `POST …/:id/rotate-secret` | 外部访问客户端：交互客户端（自行注册或管理员添加，可设 scope 上限）与机器客户端（绑定一个成员，本人批准后生效；密钥只显示一次）；停用即作废全部令牌；列表带最近使用、在用授权与令牌数；变更写审计 |
| `GET /api/admin/public-agents` · `POST …/:id/pause` · `…/resume` | 公开 Agent：主人、受众人数、本月用量；暂停与恢复 |
| `/api/admin/branding` | 名称、Logo、主色 |

### 2.6 对外与其他

| 路径 | 用途 |
| --- | --- |
| `/api/mcp` · `/oauth/*` · `/.well-known/*` | MCP 服务器与 OAuth 2.1，是唯一对外接口，见下 |
| `GET /api/connectors/oauth/callback` | 连接器 OAuth 回调（公开）：不改任何数据，302 到 `#/settings/connections?connector=&oauth_state=&oauth_code=`（失败时带 `oauth_error`），Web 用成员自己的会话调用 `finish`。不在 `/api/mcp` 下，那是 Greenhouse 自己的 MCP 服务器 |
| `/api/ws` · `/api/ws/computer?ticket=` · `/api/ws/computer-terminal?ticket=` | 实时通道、电脑画面（RFB，`view` ticket 的输入由服务端丢弃）、终端（二进制按键与输出，`resize` 文本消息） |
| `/api/ext/<id>/*` | 扩展 |
| `GET /health` | 健康检查：各能力是否可用（不含机密）；数据库不可用时返回 503 |

OAuth 2.1 与 MCP（公开路径，错误按 RFC 6749 返回 `{ error, error_description }`，不用 API 信封；元数据、注册、令牌、撤销与 `/api/mcp` 对任意来源开放 CORS，因为它们不读 cookie）：

| 路径 | 规则 |
| --- | --- |
| `GET /.well-known/oauth-authorization-server` · `/.well-known/oauth-protected-resource[/api/mcp]` | RFC 8414、RFC 9728 元数据；issuer 是 `PUBLIC_URL`，资源是 `PUBLIC_URL/api/mcp` |
| `POST /oauth/register` | RFC 7591：只注册交互（公开）客户端，PKCE、无密钥；回调须是 https、回环 http 或 App 私有 scheme，不带 fragment；按 IP 每小时 20 次 |
| `GET /oauth/authorize` | 只收 `response_type=code` 与 S256；回调精确匹配（回环地址可换端口）；不认识的 scope 忽略，一个都没有就请求全部；`resource` 只能是 `/api/mcp`；通过后浏览器去 `#/oauth/consent?request=`（一次性，十分钟）；客户端或回调不对时去 `#/oauth/consent?error=`；其他错误只对管理员添加的客户端跳回它的回调，自行注册的同样留在 `?error=`，不做开放跳转 |
| `POST /oauth/token` | `authorization_code`（两分钟、一次性；再出现即作废这次授权的全部令牌）、`refresh_token`（每次轮换；旧的再出现同样全部作废；`scope` 只能收窄）、`client_credentials`（机器客户端，`client_secret_post` 或 Basic，只发访问令牌）；访问令牌一小时，刷新令牌 30 天；令牌带成员的 `auth_version`，改密码或停用即失效 |
| `POST /oauth/revoke` | RFC 7009：吊销自己的令牌；吊销刷新令牌连同这次授权的全部令牌 |
| `POST /api/mcp` | 无状态 streamable HTTP（JSON 应答；`GET` / `DELETE` 返回 405）；没有有效令牌时 401 加 `WWW-Authenticate: Bearer resource_metadata=…, scope=…`；每个授权每分钟 120 次 |

| scope | MCP 工具 |
| --- | --- |
| `agents:read` | `agents_list`：我的 Agents 与分享给我的公开 Agents |
| `agents:ask` | `agents_list`、`agent_message`（写进该 Agent 的对话，最多等 50 秒）、`agent_conversation_get`（读之后的回复，可再等）；需要我批准的写操作留在 App 的卡片里，结果为 `needs_you` 并附链接 |
| `conversations:read` | `conversations_list`、`conversations_search`、`conversation_get` |
| `runs:read` | `runs_list`、`run_get`、`schedules_list` |
| `memories:read` | `memories_list`：Agent 关于我的记忆 |

## 3. v1 → v2 去向

| v1 | v2 |
| --- | --- |
| `/api/chat`、`/api/sessions`、`/api/session-tags`、`/api/session-groups`、`/api/shares` | `/api/conversations`；标签、文件夹、分享删除 |
| `/api/bots`、`/api/rooms`、`/api/agents`（公开目录） | `/api/agents` 加 `/api/conversations` |
| `/api/bots/requests`、运行时 interrupts、Mission 审批、Workflow 关卡 | `/api/requests` |
| `/api/runtime`、`/api/tasks`（Automations） | `/api/runs`、`/api/schedules` |
| `/api/missions`、`/api/cloud-agent`、`/api/workflows` | 删除 |
| `/api/upload`、`/api/chat-files`、`/api/drive`、Mission 附件、电脑上传、Agent 参考文件夹 | `/api/files`；电脑文件仍在 `/api/agents/:id/computer/files` |
| `/api/projects` | 删除，由表格「项目」模板承接 |
| `/api/prompts` | 删除，由 `/api/skills` 承接（模板技能） |
| `/api/workbench`、`/api/platform`（目录与偏好） | 删除；权限放进 `/api/me` |
| `/api/agent`（工具代理）、`/api/llm`、`/api/auth/llm-keys` | 删除 |
| `/api/eval`、`/api/admin/feature-requests`、`/api/admin/frictions`、`/api/admin/llm-gateway`、`/api/admin/operations` | 删除 |
| `/api/admin/settings` | `/api/admin/providers`、`/api/admin/branding` |
| `/api/admin/bot-computers` | `/api/admin/computers` |
| `/api/admin`（用户、功能开关、工具授权） | `/api/admin/members`；按成员的功能开关删除 |
| `/api/admin/platform`（未使用的角色、策略、审计接口） | 删除；平台内核内部保留 |
| `/api/email`、`/api/wecom`、`/api/feishu`（绑定） | `/api/me/connections` |
| `/api/profiles`、`/api/tools` | 删除；需要时由 `/api/agents/:id` 返回 |
| `/api/auth/me/*`（memories、features、usage） | `/api/agents/:id/memories`、`/api/me`、`/api/me/usage` |

## 4. Agent 工具（v2 命名）

工具和 HTTP 共用 service，元数据与实现写在同一个文件里（沿用 `defineTool`），并按 v2 词汇改名。

| 领域 | 工具 |
| --- | --- |
| 对话与协作 | `ask_user`、`conversation_query`、`handoff`（转交给 Agent）、`self`（修改自己指令的提议） |
| 运行 | `run_start`（后台运行，需要先确认简报）、`schedule_query`、`schedule_mutation` |
| 知识库 | `knowledge_query`、`knowledge_mutation` |
| 表格与应用 | `tables_query`、`tables_mutation`、`tables_schema_plan`、`apps_query`、`apps_action` |
| 技能 | `skill_query`（search、load、read_file，有电脑时 install）、`skill_mutation`（只提议「存为技能」，成员接受后保存为模板） |
| 多媒体（来自 Provider） | `web_search`、`web_fetch`、`generate_image`、`generate_video`、`speak`（TTS 生成音频）、`transcribe`（STT）、`analyze_image` |
| 其他 | `compute`（isolated-vm）、`read_attachment`、`export_data`、`memory`、`mcp_call`、`email_query`、`email_mutation` |
| 只在 Agent 内使用 | `browser`、`computer`、`request_takeover`、`vault` |
| 删除 | `workbench_*`、`project_*`、`mission_dispatch`、`workflow_plan`、`spawn_session`、`call_llm`、`task_capture`、`eval_*`、`manage_eval_dataset`、`query_eval_runs`、`feature_request`、`log_friction`、`automation_*`（改为 `schedule_*`）、`external_search`（改为 `web_search`）、`session_query`（改为 `conversation_query`） |

工具出现的条件：成员的模块权限允许，并且依赖的 Provider 可用。例如没有图像服务时就没有 `generate_image`，不会出现「未配置」的错误工具。

`skill_query` 的描述每个回合重建，列出这个 Agent 装备的技能，不能运行的写明原因；它按提问者的权限读技能库，公开 Agent 也提供。成员用 `/` 运行的技能在发送时检查（看得到、扫描通过、未归档、回答的 Agent 满足运行要求、必填项已填），正文作为成员的请求进入回合。

`knowledge_query`（`search`、`read`、`list`）以提问者的权限读知识库：读过的文档列为回复的出处（`kind: doc`，地址 `#/knowledge/<id>`），搜索到的文档在回复链接到时列出；`space: agent` 是这个 Agent 的私有参考文件夹。`knowledge_mutation`（`create`、`edit`、`move`、`comment`）改知识库：`edit` 带读到的 `version`，整体替换或给只出现一次的 find / replace；除了 Agent 自己的私有参考文件夹，写入都先弹出批准卡（`tool_write`）；版本和评论记下代写的 Agent。写入只在回合里，公开 Agent 两个都没有。

知识库正文的约定：引用其他文档写作 `[标题](#/knowledge/<文档 id>)`（编辑器的 `[[`），提及写作 `[@名字](member:<成员 id>)`，图片与文件写作 `/api/files/<id>/content`，存储时去掉签名、读取时按读者签名。实时事件：`doc.updated`、`doc.presence`、`comments.updated`，发给打开着这篇文档的人；`knowledge.changed`（不带任何内容）在新建、改名、移动、排序、保存、分享、归档、恢复之后发给看得到那个位置的人（团队空间是所有开着知识库的成员，个人空间是主人和分享覆盖到的人，取消分享时也告诉原来覆盖到的人；归档或恢复文件夹时，分享到其中任何文件夹或文档的人也会收到），各端据此刷新屏幕上的知识库列表。保存分享时只校验新加的成员和分组：已有的分享即使对象已停用或已删除也原样保留。

`mcp_call` 是连接器的唯一工具（`list`、`describe`、`call`）。它的描述每个回合重建，只列出这个 Agent 此刻能为提问者用的连接器和工具：已启用、在 manifest 的 `connectors` 里（空值表示全部）、per_member / oauth 的已由提问者连接；不能写的 Agent 只看到只读工具。只读工具直接运行；其余工具弹出批准卡（`tool_write`，原样参数），批准后用提问者的 Key 或登录执行。只在回合里提供，公开 Agent 不提供。

`browser` 与 `vault` 只在回合里，和 `computer` 同时出现。`browser` 经 DevTools 操作电脑里的 Chromium：`open`、`snapshot`（带 ref 的短行，可从 `from_line` 续读）、`read`、`click`、`type`、`press`、`scroll`、`wait`、`back`、`tabs`、`switch_tab`、`close_tab`、`screenshot`（模型能看图时，图片随下一步给模型，不入库）；只开 http 和 https，成员控制画面时不操作。`vault` 有 `find`（当前页面站点的条目，只有标签和掩码用户名）和 `fill {item_id, submit}`（服务端代填，`ask` 条目先发登录卡片）；公开 Agent 没有 `vault`。

## 5. 模块布局

```
apps/api/src/
  app.ts            挂载顺序（单链）
  config/           唯一读取环境变量的地方
  providers/        Provider 解析与管理（见 providers.md）
  engine/           Agent 引擎：回合、排队、需要你、运行（Runtime kernel 收敛后）、定时
  platform/         权限内核：角色、模块权限、资源策略
  modules/
    auth/ me/ agents/ conversations/ requests/ runs/ files/
    knowledge/ tables/ apps/ skills/ notifications/ search/
    connectors/ admin/ oauth/ mcp/ channels/
```

每个模块都附测试：service 单元测试、路由 API 测试、关键流程端到端测试。删除模块时，按 [功能清单](features.md) 的维护规则同步清理。

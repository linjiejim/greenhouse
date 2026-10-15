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
| 实时 | 只有一个 WebSocket `/api/ws`，事件为 `{ type, data }`，类型定义在 contract 里。消息增量、运行进度、需要你、通知、在线状态、表格的记录变更（`records.changed`，带每条记录现在的 revision 和 computed_revision；只凭自定义角色看表格的人只收到空列表，不知道是哪几条）和结构变更（`base.updated`）都走它；发送消息仍用 `POST`。回复的文字增量每 75 ms 合成一帧（`message.delta`，`offset` 是这一帧开头在回复里的位置）。进程之间经 PostgreSQL NOTIFY 转发；一条事件大到转不过去时，另一个进程上的客户端收到补拉提示：长回复的最终消息变成 `conversation.resync { conversation_id, after_seq }`，用 `GET /api/conversations/:id/messages?after=<after_seq>` 补拉；一次改了太多条记录的 `records.changed` 变成记录列表为空的同一事件（表示很多条变了）。重连后只补拉屏幕上打开的对话（和「需要你」的计数），其余查询标为过期，下次显示时再取 |
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
| `GET /api/me/operations` | 活跃成员读取当前运维状态：仅返回 `pause_background_runs`、`disable_computers`、`disable_outbound_mail` 三个布尔值，供客户端解释暂停；不能修改开关 |
| `GET /api/me/usage?period=month\|30d` | 我的用量：总计，按能力、Agent、天；我的成员预算。每组带 `cached_tokens` 与缓存命中率 `cache_hit_rate`（没有输入 token 时为空） |
| `/api/me/providers[/:id][/test]` | 我的服务，即个人 Key |
| `GET /api/me/models` | 我能给 Agent 选的模型：为我服务的各实例的模型，按顺序 |
| `GET` / `POST /api/me/connections` · `POST …/oauth/start` · `…/oauth/finish` · `POST …/:id/test` · `DELETE …/:id` | 连接：MCP 连接器账号，以及内置连接器「邮箱」（`kind: email`）；飞书 / 企微随 IM 渠道。`GET` 返回我的连接和我能用的连接器（内置的带 `builtin`）；`POST` 存我自己的 Key（服务器先验证，拒绝时 `key_rejected`），或连我自己的邮箱（`{ kind: 'email', address, imap: { host, port, security }, smtp: {…}, username?, password }`：IMAP 与 SMTP 都连通才保存，否则 `mailbox_rejected`，`details` 里分别说明；内网地址拒绝；每个成员一个，再连即替换）；OAuth：`start` 返回授权地址，回调把 `oauth_state`、`oauth_code` 交给 Web，由发起登录的同一成员 `finish`（别人是 `sign_in_not_yours`）；`test` 用我的连接列工具并记下状态；`DELETE` 断开，OAuth 同时撤销 |
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
| `GET` / `PUT /api/agents/:id/budgets` | 公开 Agent 的月度预算；主人或管理员可读写，token 或美元，复用统一预算检查与用量；取消发布后已有预算保留并可继续调整，仍约束这个 Agent；管理员也可经 `/api/admin/budgets` 管理 |
| `/api/agents/:id/computer` · `POST …/start` · `…/stop` · `…/restart` · `GET …/processes` · `POST …/ticket` · `…/files[?path=]` · `GET …/files/content?path=` | 电脑：状态、启停、重启（进程结束、文件保留）、后台进程；公开 Agent 的使用者用自己的一台。`ticket` 换取画面（`view` / `control`）或终端（`terminal`）的一次性 ticket，一分钟内用一次；家目录文件按相对路径列出、下载（一律下载）、上传（multipart，最大 50 MB）、删除 |
| `GET` / `PATCH /api/agents/:id/mailbox` · `POST …/mailbox/senders` · `DELETE …/mailbox/senders/:address` · `GET /api/agents/:id/mail?status=` · `GET …/mail/:mailId` · `POST …/mail/:mailId/release` | Agent 邮箱，只给主人：`GET` 第一次查看时建立地址，邮箱不可用时返回 `{ available: false, reason }`（not_configured / public_agent / archived）；`PATCH` 改前缀（`mailbox_taken`、`mailbox_reserved`）或成员能否叫醒它；发件人名单；邮件列表（新的在前，`status` 可筛 screened 等）与详情（纯文本、原样的 HTML 由客户端净化、附件的签名链接）；`release` 放行一封留存邮件的发件人，他留存的信全部送进对话，Agent 被叫醒一次（`mail_not_screened`） |
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
| `GET /api/runs?state=active\|done&agent=&source=` · `GET /api/runs/:id` | 运行列表与详情（步骤、产物）。步骤状态：pending（等批准）、running、succeeded、failed、skipped、uncertain（进程中断时正在执行、又有副作用，不知道是否生效，不会自动重做） |
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
| `GET /api/tables/bases?archived=&cursor=&limit=` · `POST /api/tables/bases` · `GET` / `PATCH /api/tables/bases/:id` · `POST …/archive` · `…/restore` · `…/delete` | 表格：我的和分享给我的，按名称分页（默认 200，最多 500，`next_cursor`），带数据表与我看得到的视图（`archived=true` 是我拥有的已归档表格）；只凭自定义角色看的人只拿到角色看得到的数据表和字段，带 `custom_role`，每张数据表带 `access`（read / edit）；新建空白表格（一张数据表、一个表格视图）或从模板新建（`template: project`）；详情是数据表、字段、视图和我的角色；`PATCH` 改名、说明（搭建者）或给自己置顶；归档、恢复、彻底删除只有拥有者，彻底删除要再输一遍名称（`{ name }`） |
| `GET` / `PUT /api/tables/bases/:id/share` | 分享：拥有者加分享列表；`PUT` 整体替换，只有拥有者。角色是 owner / builder / editor / viewer，分组和全员只能是 editor / viewer；也可以是 `custom` 加 `custom_role_id`（这个表格的自定义角色，成员、分组、全员都行）；四种角色胜过自定义角色，多个自定义角色叠加；新加的人收到通知；写审计 |
| `GET` / `POST /api/tables/bases/:id/roles` · `PATCH` / `DELETE /api/tables/roles/:id` | 自定义角色（拥有者）：按数据表不可见、只读或可编辑，行规则（和视图一样的筛选，`$me` 是读者）与隐藏字段（主字段不能隐藏）；每个表格最多 20 个，名称唯一（`name_taken`）；修改带 `revision`（旧的 `stale_revision`，`details.role`）；删除时它的分享一起删除。规则在服务里对每条读路径生效：列表、记录、标题、搜索、导出、仪表盘、历史、评论、附件、实时事件；读了隐藏字段或读不全的数据表的计算字段一起隐藏；只能写看得到的字段，记录只能写在自己看得到的范围里（否则 403）；回收站不对它开放 |
| `GET /api/tables/bases/:id/trash` · `…/audit` · `POST …/files` · `POST …/tables` | 回收站：删除的记录、字段和数据表，新的在前（四种角色里的编辑者；游标带精确的删除时间，坏游标 400；超过 30 天的记录由每天的清理任务彻底删除）；审计：分享、角色、归档、删除（拥有者）；附件字段的上传（multipart `file`，编辑者；先查权限再读正文，没有长度的正文边读边计，超过 50 MB 返回 413，记录引用它时才挂上，一天内没挂上的由清理任务删除）；新建数据表（带主字段和表格视图，搭建者） |
| `PATCH` / `DELETE /api/tables/tables/:id` · `POST …/restore` · `…/purge` · `GET …/titles?q=` · `GET …/export?view_id=` | 数据表：改名、说明、顺序；删除进回收站；恢复；彻底删除（连同记录和附件）；记录标题（选择器用）；导出某个视图（筛选、排序、显示的字段）或整张表的 CSV（带 BOM，按读者能看到的字段和记录，最多 5 万条，分批流式写出；会被表格软件当公式的文本前加 `'`，数字原样） |
| `POST /api/tables/tables/:id/fields` · `PATCH` / `DELETE /api/tables/fields/:id` · `POST …/restore` · `…/purge` | 字段（搭建者）：文本、长文本、数字、勾选、日期、日期时间、单选、多选、成员、链接、邮箱、电话、附件、关联、父记录、依赖；名称在表内唯一（`name_taken`）；每张表一个父记录字段和一个依赖字段（`one_per_table`）；类型只在值能保留时可改（文本类之间、单选到多选、日期到日期时间，否则 `type_change_unsupported`）；主字段不能删；删除进回收站，所有视图里去掉它，值留到彻底删除。改类型时每个值按新类型检查，有不合的就拒绝（`type_change_values`，`details` 带条数和前 20 条记录）；修改带 `schema_revision`（旧的 `stale_schema`）。计算字段：公式（`config.formula_text`，读同表字段，错误返回 400 `invalid_formula`，`details` 是错误码和位置；返回时 `formula_text` 用现在的名称）、查找引用与汇总（`link_field` 加关联表里的 `target_field`，汇总 `aggregate` 为 count / count_values / count_unique / sum / avg / min / max / join）、AI 字段（`prompt` 里 `{名称}` 引用字段，`auto_update`；只有配置了模型才能加，否则 409 `ai_unavailable`）；会互相引用成环的拒绝（409 `field_cycle`）。`POST /api/tables/fields/:id/generate { record_ids }` 让 AI 字段为这些记录重新生成（编辑者，最多 100 条，模型费用记在字段创建者名下） |
| `POST /api/tables/tables/:id/views` · `PATCH` / `DELETE /api/tables/views/:id` | 视图：表格、看板、日历、画册、时间线；个人视图任何能看的人都能建，共享视图要搭建者；配置是筛选、排序、分组、字段顺序、隐藏、列宽、冻结列、行高和各类型的设置；改动带 `revision`，旧的返回 409 `stale_revision`；每张表至少留一个共享视图（`last_view`）；每人每张表看得到的视图最多 100 个（`too_many_views`）。仪表盘：`POST /api/tables/bases/:id/dashboards`（共享的要搭建者，个人的谁都能建），卡片在视图配置里；`GET /api/tables/views/:id/cards` 按读者的权限算出每张卡片（每张各自成败），`POST /api/tables/cards/query` 算一张没保存的卡片 |
| `POST /api/tables/tables/:id/records/query` | 查询记录：`{ filter, sorts, group, search, cursor, limit, count }`，筛选里 `$me` 是读者，`$today` 等按读者时区；分组先于排序；游标是带查询指纹的偏移；返回记录（关联、依赖、父记录、附件填好 id；计算字段的值也在 `values` 里，失败是 `{ error }`，AI 生成中是 `{ pending: true }`；`computed_revision` 在计算值变化时加一）、关联记录的标题、附件的签名地址，`count` 时带总数 |
| `POST /api/tables/tables/:id/records` · `…/records/bulk` · `…/records/delete` | 新建记录；批量粘贴（每条各自成功或失败：`stale_revision`、`invalid_input`、`not_found`，意外错误是 `failed`，不影响已经写好的）；批量删除进回收站（编辑者）；计算字段不能写。表格接口的 JSON 正文最多 8 MB（413 `too_large`），所有接口的 JSON 正文最多 16 MB |
| `GET` / `POST /api/tables/tables/:id/forms` · `GET` / `PATCH` / `DELETE /api/tables/forms/:id` · `POST …/publish` · `…/unpublish` · `GET` / `PUT …/share` · `GET …/submissions` · `GET …/fill` · `POST …/files` · `POST …/submissions` | 内部表单：搭建者建、改（带 `revision`）、发布、停止；谁能提交默认是能新建记录的成员，`PUT …/share` 另定（角色 `submitter`）；提交写一条记录（历史里记为表单），只允许提交一次的表单第二次返回 409 `already_submitted`；未发布 `form_closed`；附件经表单自己的上传（先查能否提交再读正文）；提交列表给四种角色里的编辑者 |
| `POST` / `GET /api/tables/tables/:id/imports` · `GET` / `PATCH /api/tables/imports/:id` · `POST …/start` · `…/cancel` | CSV 导入（编辑者）：上传成为草稿（24 小时，最多 20 MB、5 万行、500 列），按列名对应字段可改，开始后由后台任务分批写入，失败重试从已写入的行继续；读不出或被拒的行跳过，结果报告行号、列和原因；只有导入者看得到自己的导入 |
| `GET` / `PATCH` / `DELETE /api/tables/records/:id` · `POST …/restore` · `…/purge` · `GET …/activity` · `…/comments[/:commentId]` | 一条记录（带子记录）；修改要带读到的 `revision`，旧的返回 409 `stale_revision`（`details.record` 是现在的记录）；删除进回收站，恢复，彻底删除（搭建者）；活动是评论和变更历史，新的在前；评论（能读就能评，提及的人和记录创建者收到通知；只改自己的，拥有者能删任何一条） |
| `GET /api/search?q=&kinds=` | `⌘K` 全局搜索；`records` 是我能读的表格里的记录（中英文全文检索），带 `base_id`、`table_id`；只凭自定义角色看的表格里只搜角色看得到的字段和记录 |
| `GET` / `POST /api/apps` | 应用目录（游标、名称搜索）与新建（表格搭建者）；目录包含我可用的发布应用和我搭建的草稿。应用开关和底层表格权限每次复核 |
| `GET` / `PUT /api/apps/:id/draft` · `POST …/publish` · `GET …/versions` · `POST …/restore` | 搭建者只能修改自己的应用。草稿保存、发布、恢复带 `revision`，旧的 409 `stale_revision`；发布事务写不可变 spec/hash 和受众，并消耗 revision。恢复只改变草稿，旧发布继续生效；版本列表使用游标 |
| `GET /api/apps/:id` · `POST …/cards/query` · `POST …/cards/:card/records/:record` · `POST …/actions` | 发布运行页面、保存的卡片求值／记录详情、固定动作与内部表单。数据按底层权限 ∩ 应用角色 ∩ 卡片查询／字段；应用永不扩大表格权限。动作带 `version` 和保存的 card/action id，旧发布版 409 `stale_version`；按钮不接收覆盖值。写入者是成员，记录历史 actor_type=app、meta.app_id。卡片记录查询支持游标；搭建者可用 `preview_role` 只读预览草稿，卡片查询带 version=0 和相同 preview_role，不允许预览动作；custom 卡片仅在该发布版本通过管理员审核后返回源码；未批准及草稿预览不返回源码，显示占位 |
| `GET /api/apps/reviews` · `POST /api/apps/:id/review` | 管理员分页查看发布 spec，按 `{version, spec_hash, decision}` 批准／拒绝代码；新版本一律 pending，hash 不符 409 stale_version，审核写审计。管理员可读结构，不因此得到底层记录权限 |
| `POST /api/apps/:id/bindings/query` | 已批准的 custom 卡片 `{version, card, binding, cursor?}`，只读其声明的本应用表格数据卡；沿用卡片权限、字段和查询，禁止外部连接器绑定。桥只收合法来源的 JSON-RPC tools/call query.*，每窗口最多 30 次／分钟且一次一个在途查询，不给身份或 token |
| `PUT /api/apps/:id/pin` · `…/featured` | 本人置顶；管理员精选（管理员也需有应用和表格访问权，写审计） |
| `GET /api/apps/templates[/:id]` · `POST /api/apps/:id/templates` · `POST /api/apps/templates/:id/review` · `…/install` | 查看可用／自己的模板（管理员可看待审结构）、从发布应用存结构模板、管理员审核、安装到新表格与应用草稿。只有审核通过的版本可安装；不复制线上记录、受众或自动化。未通过的模板对其他成员不可见。项目内置模板复用表格安装器 |
| `GET /api/skills?q=&space=&kind=&scan_status=&archived=&agent=` · `POST /api/skills` · `GET` / `PATCH` / `DELETE /api/skills/:id` · `POST …/restore` · `GET` / `POST …/versions` · `POST …/scan` · `GET …/download?version=` · `GET /api/skills/starters?agent=` | 技能：我看得到的技能，`available` 与原因按 `agent`（默认主 Agent）判断；新建模板，或用 purpose `skill` 上传的 ZIP 新建包；`PATCH` 改显示名、说明、标签，`DELETE` 是归档；新版本（新 ZIP，或模板的新正文、字段、要求）；`scan` 重扫，或审核（`safe` / `malicious`，团队技能由管理员、个人技能由主人）；下载返回包的签名链接；`starters` 是新会话的 3 个常用技能（没有时给模板开场） |
| `GET /api/notifications` · `POST …/read` | 通知 |
| `GET /api/members?q=` · `GET /api/groups` | 成员与分组选择器（只读） |

### 2.5 管理（仅管理员）

| 路径 | 用途 |
| --- | --- |
| `/api/admin/members[/:id]` | 邀请、角色、停用、重置链接、模块权限、预算；邀请和 `POST …/:id/link` 返回的链接带 `delivery`（emailed：已由邮箱服务发出 / failed / shown：没有邮箱服务），链接都可复制 |
| `/api/admin/groups[/:id]` | 分组 |
| `/api/admin/providers[/:id][/test\|/copy]` · `PUT /api/admin/provider-bindings/:capability` | 服务：实例、测试连接、复制环境变量实例；能力的顺序、默认项与策略 |
| `GET /api/admin/channels` · `PUT …/:channel` · `POST …/:channel/test` | 渠道 `feishu`、`wecom`、`push`（Expo；飞书、企微在界面隐藏，随 IM 渠道开放）：`GET` 列出每个渠道能否送达（`configured`）、来源（`env` / `workspace`）、设置、哪些机密已填、最近一次成功与失败；`PUT` 保存一个渠道的设置（feishu：`base_url`、`app_id`、`app_secret`；wecom：`base_url`、`corp_id`、`agent_id`、`secret`；push：`base_url`、`access_token`；都可带 `enabled`），机密只写不读、省略即保留、`''` 清空，换地址同时清空机密；第一次保存或改环境变量来的设置时生成工作区实例，排在同类之首；`test` 给管理员自己发一条（绑定的账号、手机），没有可发的对象时只验证凭据，返回 `{ ok, delivered, latency_ms, error }`。邮件不在这里：它是邮箱服务 |
| `GET` / `PUT /api/admin/mail` · `POST /api/admin/mail/test` | 邮箱服务：能否发信、Agent 邮箱的域名（来源 env / workspace，另附 `MAIL_AGENT_DOMAIN` 的值；`PUT { agent_domain }`，null 回到它，写审计）、Agent 邮箱是否开通、每个能收信的实例要填到服务商那里的入站地址；`test` 经第一个能发的实例给管理员自己发一封（`mail_not_configured`） |
| `GET /api/admin/computers` · `PUT …/capacity` · `POST …/:id/stop` · `DELETE …/:id` | 电脑：所有成员的电脑与状态（不含画面和文件）；容量（空闲多少分钟后关机、最多同时开机，0 为不限，超出时开机返回 200 queued 和 queue_position，停机取消排队）；停止；重置（连主目录删除，下次使用重开） |
| `POST /api/admin/computers/:id/backups` · `POST …/:id/backups/:backup/restore` | 管理员按需备份运行中的电脑；停机后恢复归属此电脑的成功备份（覆盖两个主目录，弹确认）。列表返回备份 id、时间、大小、状态、错误，永不返回存储位置或密钥。每进程最多同时 2 个备份，每个压缩主目录最多 32 MiB，恢复展开最多 256 MiB、10 万项，拒绝路径穿越／设备／越界链接；先验证完整密文再写盘。`backup_unavailable` 503、`backup_failed` 502、`backup_invalid`／`backup_restore_failed`／`computer_not_stopped` 409 |
| `GET /api/admin/usage?period=&group_by=member\|agent\|provider\|capability` | 工作区用量 |
| `GET` / `PUT /api/admin/budgets` · `DELETE …/:id` | 预算：组织、服务实例、成员、公开 Agent 四种范围，token 或美元，按月；`PUT` 建立或替换一个范围与单位的预算；列表带本月已用 |
| `GET` / `PATCH /api/admin/operations` | 运维开关（仅管理员）：`pause_background_runs`、`disable_computers`、`disable_outbound_mail`，部分更新，审计只记字段名 |
| `/api/admin/connectors[/:id]` · `GET …/catalog` · `GET …/registry?q=` · `POST …/probe` · `POST …/:id/refresh` · `…/test` | 安装连接器：内置目录（`{ catalog_id }`）、Registry 搜索（慢，服务端缓存）、URL（`probe` 先看要哪种鉴权）；鉴权 none / shared / per_member / oauth，共享 Key 与 OAuth 客户端密钥只写不读；工具缓存（`refresh` 重列，per_member / oauth 用管理员自己的连接）、白名单、只读工具；启用 / 停用；改地址或鉴权方式会断开所有成员的连接 |
| `/api/admin/clients[/:id]` · `POST …/:id/rotate-secret` | 外部访问客户端：交互客户端（自行注册或管理员添加，可设 scope 上限）与机器客户端（绑定一个成员，本人批准后生效；密钥只显示一次）；停用即作废全部令牌；列表带最近使用、在用授权与令牌数；变更写审计 |
| `GET /api/admin/public-agents` · `POST …/:id/pause` · `…/resume` | 公开 Agent：主人、受众人数、本月用量；暂停与恢复 |
| `/api/admin/branding` | 名称、Logo、主色 |

### 2.6 对外与其他

| 路径 | 用途 |
| --- | --- |
| `/api/mcp` · `/oauth/*` · `/.well-known/*` | MCP 服务器与 OAuth 2.1，是唯一对外接口，见下 |
| `GET /api/connectors/oauth/callback` | 连接器 OAuth 回调（公开）：不改任何数据，302 到 `#/settings/connections?connector=&oauth_state=&oauth_code=`（失败时带 `oauth_error`），Web 用成员自己的会话调用 `finish`。不在 `/api/mcp` 下，那是 Greenhouse 自己的 MCP 服务器 |
| `POST /api/mail/inbound/:instance` | 邮件服务商的收信通知（公开，凭服务商的签名）：Resend 的 Svix 签名 webhook、Mailgun `store(notify=…)` 的 HMAC；先验签（失败 401 `invalid_signature`），再持久写入 mail_inbound 任务并应答 200 `{ status: queued, job_id, delivered: 0, screened: 0 }`；worker 用实例的 Key 拉信，失败按 jobs 退避重试，不能把 queued 当作已投递；重复通知 status=duplicate、无关通知 status=ignored；同一封信只存一次；过大的通知 413 |
| `/api/ws` · `/api/ws/computer?ticket=` · `/api/ws/computer-terminal?ticket=` | 实时通道、电脑画面（RFB，`view` ticket 的输入由服务端丢弃）、终端（二进制按键与输出，`resize` 文本消息） |
| `GET /api/extensions` | 已启用扩展及其页面、设置、管理、实体面板声明；管理分区仅管理员可见 |
| `/api/ext/<id>/*` | 可信扩展的路由，统一成员鉴权；`/admin` 子树另需管理员。Agent 工具沿用审批，搜索经 `/api/search?kinds=extensions` 返回限定到自己页面的链接 |
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
| `apps:read` | `apps_query`：按我的应用与表格角色读发布页面、卡片及记录 |
| `apps:write` | `apps_action`：执行已保存动作；共享写入等我在 Greenhouse 批准 |

表格 Web（#70，T3）直接消费上述计算字段与角色接口：公式错误 `details` 的 `code/start/end/params` 用于本地化提示和标记；`records.changed` 中的 `computed_revision` 与编辑 revision 分开比较。字段生成仍通过 `POST /api/tables/fields/:id/generate`；标签栏为非搭建者创建仪表盘时固定 `personal: true`。


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

#70：发给所有模型服务的工具参数都是顶层 `type: object` 与 `properties`，顶层不含 `anyOf`、`oneOf` 或 `allOf`。按 action 分支的 Zod 输入合并成一个对象（action 枚举、分支字段可选），Schema 说明各分支的必填项；调用返回后仍用原 Zod 输入校验必填项、长度、默认值与分支，再计算风险或执行。真实 DeepSeek 与会拒绝旧格式的模拟服务均已验证。

| 领域 | 工具 |
| --- | --- |
| 对话与协作 | `ask_user`、`conversation_query`、`handoff`（转交给 Agent）、`self`（修改自己指令的提议） |
| 运行 | `run_start`（后台运行，需要先确认简报）、`schedule_query`、`schedule_mutation` |
| 知识库 | `knowledge_query`、`knowledge_mutation` |
| 表格与应用（规划，当前未提供） | `tables_query`、`tables_mutation`、`tables_schema_plan`、`apps_query`、`apps_action` |
| 技能 | `skill_query`（search、load、read_file，有电脑时 install）、`skill_mutation`（只提议「存为技能」，成员接受后保存为模板） |
| 多媒体（来自 Provider） | `web_search`、`web_fetch`、`generate_image`、`generate_video`、`speak`（TTS 生成音频）、`transcribe`（STT）、`analyze_image` |
| 其他 | `compute`（isolated-vm）、`read_attachment`、`export_data`、`memory`、`mcp_call`（成员自己的邮箱经内置连接器 `mailbox`）、`mail`（Agent 自己的邮箱） |
| 只在 Agent 内使用 | `browser`、`computer`、`request_takeover`、`vault` |
| 删除 | `workbench_*`、`project_*`、`mission_dispatch`、`workflow_plan`、`spawn_session`、`call_llm`、`task_capture`、`eval_*`、`manage_eval_dataset`、`query_eval_runs`、`feature_request`、`log_friction`、`automation_*`（改为 `schedule_*`）、`external_search`（改为 `web_search`）、`session_query`（改为 `conversation_query`） |

工具出现的条件：成员的模块权限允许，并且依赖的 Provider 可用。例如没有图像服务时就没有 `generate_image`，不会出现「未配置」的错误工具。

`skill_query` 的描述每个回合重建，列出这个 Agent 装备的技能，不能运行的写明原因；它按提问者的权限读技能库，公开 Agent 也提供。成员用 `/` 运行的技能在发送时检查（看得到、扫描通过、未归档、回答的 Agent 满足运行要求、必填项已填），正文作为成员的请求进入回合。

`knowledge_query`（`search`、`read`、`list`）以提问者的权限读知识库：读过的文档列为回复的出处（`kind: doc`，地址 `#/knowledge/<id>`），搜索到的文档在回复链接到时列出；`space: agent` 是这个 Agent 的私有参考文件夹。`knowledge_mutation`（`create`、`edit`、`move`、`comment`）改知识库：`edit` 带读到的 `version`，整体替换或给只出现一次的 find / replace；成员独享的可撤销写入直接执行并留回执；共享写入发批准卡（`tool_write`）或使用该范围及动作的预先授权；taint 后不用预先授权；版本和评论记下代写的 Agent。读写可在回合和后台运行中使用；后台卡片暂停运行，决定后按步骤续跑；公开 Agent 仅提供 knowledge_query，范围固定为主人发布时授权文件夹的当前子树；不提供 knowledge_mutation，也不读取使用者或主人的其他知识。引用按使用者直接权限或当前发布授权过滤。

知识库正文的约定：引用其他文档写作 `[标题](#/knowledge/<文档 id>)`（编辑器的 `[[`），提及成员写作 `[@名字](member:<成员 id>)`，主人提及自己的 Agent 写作 `[@名字](agent:<Agent id>)`，文档与评论经唤醒层送到其 Agent 对话，图片与文件写作 `/api/files/<id>/content`，存储时去掉签名、读取时按读者签名。实时事件：`doc.updated`、`doc.presence`、`comments.updated`，发给打开着这篇文档的人；`knowledge.changed`（不带任何内容）在新建、改名、移动、排序、保存、分享、归档、恢复之后发给看得到那个位置的人（团队空间是所有开着知识库的成员，个人空间是主人和分享覆盖到的人，取消分享时也告诉原来覆盖到的人；归档或恢复文件夹时，分享到其中任何文件夹或文档的人也会收到），各端据此刷新屏幕上的知识库列表。保存分享时只校验新加的成员和分组：已有的分享即使对象已停用或已删除也原样保留。

`mail` 是 Agent 自己的邮箱（AGNT-30）：`list`（收件箱或已发送）、`search`、`read` 只读，读信让回合 taint，正文用 fence 隔开；留存（screened）的信读不到；`send`、`reply` 是第 3 档：每次都弹出批准卡（收件人、主题、正文摘录），批准后从 Agent 的地址发出，回信带 In-Reply-To 与 References。只为主人自己的 Agent 发信，不在房间里；后台与事件回合同样每次要求人批；不能写的 Agent 只能读；公开 Agent 没有这个工具。

`mcp_call` 是连接器的唯一工具（`list`、`describe`、`call`）。它的描述每个回合重建，只列出这个 Agent 此刻能为提问者用的连接器和工具：已启用、在 manifest 的 `connectors` 里（空值表示全部）、per_member / oauth 的已由提问者连接；不能写的 Agent 只看到只读工具。只读工具直接运行；其余工具弹出批准卡（`tool_write`，原样参数），批准后用提问者的 Key 或登录执行。回合里提供，后台只允许只读调用；公开 Agent 不提供。

`browser` 与 `vault` 只在回合里，和 `computer` 同时出现。`browser` 经 DevTools 操作电脑里的 Chromium：`open`、`snapshot`（带 ref 的短行，可从 `from_line` 续读）、`read`、`click`、`type`、`press`、`scroll`、`wait`、`back`、`tabs`、`switch_tab`、`close_tab`、`screenshot`（经控制租约与密码库敏感值检查后保存为附件，返回 `file_id` 并在当前回复内联一张图片；模型能看图时也随下一步提供，不能看图时明确告知成员可见、模型不可见，仍可用 snapshot / read 决策）；只开 http 和 https，成员控制画面时不操作。`vault` 有 `find`（当前页面站点的条目，只有标签和掩码用户名）和 `fill {item_id, submit}`（服务端代填，`ask` 条目先发登录卡片）；公开 Agent 没有 `vault`。

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


## 5. 常驻（M1.7）

- `POST /api/requests/:id/approve` 的可选正文：`{ standing: false, continue_after?: boolean }`。省略正文仍可批准。`standing: true` 只能授予卡片展示的第 2 档范围和动作；其他卡片返回 409 `standing_not_allowed`。`continue_after` 只用于后台简报卡。多写卡片 `payload.calls` 展示全部写入，`batch_ready` 为 false 时不能批准（409 `request_building`）。
- `GET /api/agents/:id/standing-approvals?cursor=&limit=`：拥有者的分页列表，`items` 含 `id`、`agent_id`、`scope_type`、`scope_id`、`actions`、`granted_at`、`revoked_at`，仍可读时附 `scope_name` 和 `scope_href`；权限失去时不泄露对象名。
- `DELETE /api/agents/:id/standing-approvals/:approval_id`：撤销自己的授权，204。
- `POST /api/runs/steps/:step_id/undo`：撤销自己回执的写入，204；`already_undone` / `undo_conflict` / `undo_unavailable` 为 409。撤销与成员的服务权限相同，文档版本或记录修订改变后不覆盖。同一运行在同一数据表的回执包含 `event.step_ids`，保留 `step_id` 作为入口；调用批中任一步骤均在一个事务内倒序撤销整个批次，任一冲突则全部回滚。
- `run_start` 简报参数新增 `computer`（默认 false）、`domains`（明确域名，最多 20 个，不接受 URL 或通配符）、`continue_after`（默认 false）。卡片显示电脑与域名，成员可以勾选「完成后继续」。Docker 后台期间断网；E2B 通过网络更新接口限制域名，不支持该接口的兼容服务拒绝后台电脑。
- `schedule_mutation` 与定时的 POST / PATCH 新增 `quiet`（默认 false）及同样的电脑 / 域名 / 跟进参数。后台用 `run_finish { report, findings }` 结束；`GET /api/runs/:id` 新增 `findings`。静默且无发现时不发完成通知，也不再唤醒跟进；失败总是通知。
- `table_query`（list / read）和 `table_mutation`（create / update / delete / bulk）调用同一个表格服务；bulk 最多 20 项，一张卡；delete 是移入回收站，彻底删除不提供给它。表格和知识库按三档，move 改变范围不能获得预先授权。
- `engine.deliver` 不是对外 HTTP 接口。事件必须送到 Agent 与主人的对话；来源键去重，默认两分钟合并，每 UTC 日默认 50 次事件回合，深度最多三层。事件是 untrusted 数据，不能代替成员批准。进程结束的事件可离线检查原进程输出，新电脑工作仍要批准简报。
- `AGENT_EVENT_WAKES_PER_DAY` 配置每日上限（1–1000，默认 50）；`AGENT_EVENT_MERGE_MS` 默认 120000，测试夹具使用较短窗口。客户端新增字段均有默认值，旧调用可以继续省略。

`memory` 的 recall 可用于后台；前台私有记忆 remember/update 按第 1 档留下可撤销回执，forget 为彻底删除、按第 3 档审批且不能预批；读过外部内容后不改记忆。


### 表格与 Agent（#70）

- `POST /api/tables/records/:id/handoff`：`{ agent_id, brief, output_field_id? }`，仅自己的 Agent；读取成员可见记录，响应 `{ run_id }`。负责人仍是成员，来源为 `record`；默认结果作为评论，经 `table_mutation` 分档写回；可选文字字段使用交办时的修订，不能覆盖后来的修改。
- `GET /api/tables/bases/:id/automations`（游标分页）、`POST`（创建），`PATCH /api/tables/automations/:id`（完整规则与 `revision`）、`DELETE`：需要搭建者权限，执行者为保存规则的成员。触发为 `record_created / record_updated / record_matched / schedule / date_reached / button`；`config` 含筛选、限定更新字段、间隔分钟或日期字段与动作列表。
- `GET /api/tables/automations/:id/runs`（游标分页）给出步骤、状态与 Agent `run_id`（Agent 事件尚在合并、未建立后台运行时为 queued；步骤派发成功不代表 Agent 已完成；多个 Agent 步骤全部成功才返回 succeeded）；`POST /api/tables/automations/:id/run` 显式执行按钮规则（可附 `record_id`）。执行前复核执行者与通知收件人的权限。
- 通知动作 `{type:"notify",members,title}` 统一经通知服务；Agent 动作 `{type:"agent",agent_id,brief,tools:"none"|"same_base_read",output_field_id?}` 经事件唤醒入口，默认无工具；可选回写仍需按档批准。webhook `{type:"webhook",url}` 仅公网 HTTPS、拒绝重定向、连接时复核 DNS、10 秒超时。创建含 webhook 的规则或首次添加 webhook 时仅一次返回 `webhook_secret`，后续不读取；请求头 `x-greenhouse-id` 为执行 id、`x-greenhouse-timestamp` 为 Unix 秒、`x-greenhouse-signature` 为 `v1=` 加 HMAC-SHA256(secret, timestamp + "." + 原始请求体)。接收方应校验时间窗口并按 id 去重；发送结果未知不会自动重发。
- `table_query` 发现表格、数据表、视图，按成员的自定义角色筛选记录与聚合；读取的记录引用会再次按接收者权限裁剪。`table_mutation` 支持记录批量修改、回收、评论和彻底删除；私有可逆操作有回执与撤销、共享按数据表动作批准、彻底删除逐次批准。`table_schema_plan` 的精确结构计划逐次确认后才落库；新增字段可标记 `primary: true`（只能一个文本字段），否则第一字段为 text 时复用为主字段，不再另加默认名称列。
- `apps_query` 读取已发布应用与卡片，`apps_action` 只执行已保存的动作，按查看者的应用与表格权限交集。MCP 对应独立的 `apps:read` / `apps:write`，不扩大其他已授权范围；共享动作返回 `needs_you`，外部客户端不能代替成员批准。

页面会话（CONV-28）：`POST /api/conversations` 的 chat.context 只接受引用 `{kind: doc|record|run|agent, id}`、`{kind: app, id, page_id?}` 或 `{kind: page, name}`。服务端验证对象访问，每轮按当前权限读取并作为不可信数据带入；不接受客户端内容快照。

M3 媒体与计数（#70）：
- `POST /api/media/files/:id/save`，`{space?: personal|team, folder_id?}`：按成员权限将已有 artifact 复制到知识库，不改变原会话文件。
- `GET /api/runs/:id` 增加 `progress`（0–100 或 null）和 `file_ids`；视频后台运行也走既有 list/cancel 接口，取消停止本地检查，普通 retry 拒绝 `media_not_retryable`。
- `POST /api/metrics/adopt`，只接受 `{kind: download, file_id} 或 {kind: download, message_id}` 或 `{kind: citation, message_id}`；读权限在服务层复查，同一成员对同一产出只计一次。
- `GET /api/admin/usage/metrics?weeks=8`（1–12）：仅管理员，返回每周计数与比例，不返回任何成员／对话／产物 ID 或内容。无分母时为 null。
- 排队成员消息的 event 为 `{type: interjection, state: queued}`；步骤边界带入后更新为 `{type: interjection, state: incorporated, run_id}`，原 seq 不变，新的 assistant 行沿用 run_id。停止仍丢弃排队项。

## 6. M2.4 引擎接口（#70）

- `PUT /api/agents/:id/publication` 新增 `folder_ids`（最多 100 个，默认空）；读取发布设置也返回它。只能选主人当前可用的个人知识文件夹，排除 Agent 私有参考文件夹。
- `GET /api/runs?parent=<run id>` 仅返回当前成员拥有的子运行；运行视图带 `parent_run_id` 和子运行的 `summary`。子运行仍经已有详情与取消接口查看，不允许直接重试（`helper_retry`），由新的主 Agent 回合重新安排。
- `helper_run { briefs: [{ title, brief }] }` 仅在主 Agent 的个人回合提供。一个回合最多 3 个、每个 8 步、仅只读后台工具，父回合暂停后经 `run_report` 一次收齐最多三个摘要（总上限 8,000 字符）；摘要续回不能再开一批，只有新的成员消息重置上限。摘要和工作日志正文均按不可信数据处理。拒绝码包括 `helper_limit`、`helper_forbidden`、`parent_unavailable`、`budget_exceeded`、`budget_estimate_unavailable`。
- 工具输出超过约 8,000 字符时返回 `{ file: { id, name }, head, length, note }`。`tool_output_read { file_id, offset?, length? }` 返回 `offset`、总长度 `length`、本段消耗的字符数 `read_length`、正文 `content` 与 `next_offset`（默认和上限均为 3,500 字符；含 JSON 转义的完整结果不超过 8,000 字符，必要时缩小窗口，不再次省略；按 `next_offset` 读到 null 即读完），每次检查成员的文件权限。文件到期或无权读取均返回 `not_found`。文件仅主人可读不等于来源私有：公开网页、搜索和未读私有数据时自行生成的输出，读回后仍可联网；知识库、记忆和需鉴权的连接器输出继续按私有数据限制后台联网，缺失来源信息也按私有处理。若动作已完成但输出存储失败，步骤仍成功，结果明确返回 `storage_error`、开头与长度，不虚构文件，也不诱发重复写入。
- `memory.recall` 支持索引中的 `id` 精确读取，以及 `query` 查询词、`from` / `to`（UTC 日期 YYYY-MM-DD，含两端）；至少给记忆编号、非空查询词或日期范围。编号仍只在当前成员与 Agent 的记忆分区内匹配。后台提供的工具参数只包含 recall，不提供 remember / update / forget；系统在后台运行结束时写工作日志，不接受运行结果中的记忆指令。
- 工程命令：`pnpm cli eval export <run|message id>` 在本地连接的 v2 数据库导出 `fixtures/eval/*.json`；成员消息会找到当前对应的回合，多个 Agent 同时回答时返回 `eval_ambiguous`，应指定回复或运行 id；`TEST_DATABASE_URL=... pnpm eval` 用脚本模型回放，不请求真实模型。夜间真实模型用例留 M3.6。

插话与恢复（#70）：已带入的消息、后续模型上下文和新回复检查点同事务持久化；进程崩溃后接着写当前回复，不重复已完成工具，也可继续插话。排空中的 API 不再带入新消息，由其他 API 接手队列。

### M3.6 进程与限流（#70）

`GREENHOUSE_ROLE=all`（默认）提供全部能力；`api` 提供 HTTP、WebSocket 和前台回合，`worker` 不监听 HTTP，运行后台任务与清扫。收到 SIGTERM 后停止领取新回合 / 任务，进行中的回复最多等待 60 秒。符合十分钟、成员仍在、步骤完成条件的回合由另一个 API 接着写原 message id；续跑先发送小的 `message.resumed { conversation_id, message_id, offset }`，客户端丢弃未完成的增量并把 streaming 文字截回 offset；随后按 message.updated 与增量 offset 同步，不产生第二条回复。这个小事件可跨副本传递，即使长回复全文需要 resync 补拉。

`RATE_LIMIT_STORE=memory|postgres` 控制现有限流的计数位置。多副本应全部设为 postgres：登录的 IP 与邮箱窗口每分钟各 10 次；OAuth 注册每 IP 每小时 20 次、授权每分钟 30 次、令牌 / 作废每分钟 60 次、客户端凭据尝试每分钟 10 次；MCP 每 grant 的窗口沿用每分钟 120 次；成员 multipart 上传（文件、知识库、表格与语音）每分钟 30 次，在读取正文前检查。超过返回 429 `rate_limited`；OAuth 保持 RFC 6749 错误形状，其余保持 API 错误包，OAuth / MCP / 上传带 Retry-After。成功登录只重置邮箱计数，不重置 IP。

### v2.0 交付约定（#70）

- 知识库目录分页使用固定的 ICU `zh-u-co-pinyin-kn-true` 排序规则；手动位置、文件夹优先级、自然名称、id 共同构成稳定游标。中文按拼音，数字按数值（Doc 2 在 Doc 10 前），不依赖数据库默认 locale。
- `/api/me/usage`、`/api/admin/usage`、`/api/agents/:id/usage` 的总计与各分组包含 `stt_seconds`（音频秒数，可有小数）和 `tts_characters`（朗读字符数）。分别只合计 STT 的 second 与 TTS 的 character 计量；未知数量计零，不由 token 或费用推算。
- `run_steps.kind=model` 是恢复上下文，不是永久运行证据：终态运行结束满 90 天由每日清理删除；编辑或重新生成删除旧回复时立即删除对应模型步骤与 Eval 提示快照。工具步骤保留。

### 原生移动端 phase 2（#70）

移动端复用知识库、表格、语音和 Agent 邮箱接口，不增加原生专用接口。文档修改发送编辑开始时的 `version`，记录修改发送起始 `revision` 和变化字段；409 时保留草稿，明确重新载入。文件预览仍用签名 URL。转写只填入输入框，朗读使用 `/api/voice/speech` 或设备语音。原生页接收 `knowledge.changed`、`doc.updated`、`doc.presence`、`comments.updated`、`records.changed`、`base.updated`，重连和回到前台时重新读取。邮件正文用原生纯文本呈现，附件使用签名链接。

### 原生移动端最新 v2 集成（#70）

移动端继续复用标准接口：批准发送 `standing`，运行提议可发送 `continue_after`；仅 tier2 且有明确范围的卡片提供预先授权，`batch_ready=false` 时禁止批准。写入回执按 `step_id` 调用 `POST /api/runs/steps/:id/undo`，由服务检查本人和当前修订。主人可分页读取／撤销 Agent 的预先授权，并通过 `/api/schedules` 保存 `quiet`；日程修改只发送本次变化的字段，避免覆盖另一端的无关配置。记录交办使用 `POST /api/tables/records/:id/handoff`。

应用列表与运行页、卡片查询、限定字段详情、表单提交和固定动作全部走 `/api/apps`；查询及写入钉住 `version`，记录动作携带 `revision`，不经更宽的表格接口读写应用记录。`stale_version` 保留原生表单草稿，只有明确重新载入才采用新的发布版本。搭建与发布仍在网页端，自定义 HTML 在手机端也禁用。没有新增接口或更改错误码。

应用关联选项只查询当前发布的记录卡片，复用卡片筛选与应用权限；没有对应候选卡片时提供网页填写入口，不查询完整表格目录。成员候选使用成员目录，附件沿用受控上传与签名文件链接。

#70 电脑与应用补充：电脑停机前备份是有界同步操作；存储暂不可用时记录失败，保留原主目录并继续停机。队列由数据库状态保存，以事务锁认领容量，worker 每分钟补偿，超过 15 分钟的 starting 复核沙箱状态。丢失持久主目录时从最新成功备份恢复；密文不可用时失败，不悄悄用空目录开机。备份依赖部署的 provider 加密密钥，恢复部署时必须保留该密钥。

external 卡片仅执行保存的只读连接器工具，auth_mode 必须是 per_member 或 oauth；每次求值和缓存命中前重查查看者的连接及连接器版本。缓存 15 秒、最多 500 项，结果最多 256 KB／100 行，JSON Pointer 映射标量，连接器 HTML 永不执行。应用角色不裁剪外部系统数据，但应用和底层表格访问权仍是入口条件。

custom 网页运行使用双层 `sandbox="allow-scripts"` iframe，均无 allow-same-origin；平台先放 CSP（default-src none、connect-src none、frame-src none、form-action none），只允许内联脚本／样式及 data/blob 图片。外层限制内层跳转；postMessage 双层检查 source。去掉直接的 RTCPeerConnection 并关闭 DNS 预取，但这不能证明浏览器 WebRTC／DNS 残余外泄通道不存在（嵌套 srcdoc 可以重新取得 WebRTC）。因此每个版本必须人工审核，绑定不得含连接器数据；不宣称是任意恶意代码的完整网络隔离。手机端继续禁用 custom 执行。

### 请求卡片的对象名称（#70）

所有新请求的标题、`payload.summary` 与 `payload.details` 在服务端保存前转为人可读文字：内部引用显示当前成员可读的对象标题或路径，正文片段与嵌套参数预览中的引用也一样；不存在或不可读的对象只显示本地化的「不可用的对象」。每张卡最多解析 64 个不同引用，超出的引用同样隐藏 id。房间标题／摘要只显示「关联对象」，私有详情仍仅给被请求成员；应用动作的字段名称受发布角色和卡片列投影约束。`payload.input`、`standing_scope` 与批次 `calls` 的执行参数保持原样，批准后仍精确执行原调用，不能把展示文字当参数。Web 与原生移动端直接消费同一 payload；不新增接口和 schema。

### 验收展示载荷（#70）

`tool_write.payload.details` 是按顺序的 `{label, value, format?, chips?}`。`value` 已是成员语言的人类文字，内部引用经过权限检查；原始 `input` 与审批范围不参与展示转换。`format: markdown` 表示正文短预览，Web 仅允许标题、列表、强调和代码等安全文本结构，不加载远程图片，可展开；`chips` 是选项标签，`value` 同时保留标签以供原生读取。表结构、记录写入与应用动作不再把 JSON 序列化为详情。

消息步骤的 `summary` 由服务端区分待批、完成、拒绝和结果未知；决定后更新原回复并发送 `message.updated`。运行详情 `steps[].summary` 使用同一套语义，`tool` 仍供程序识别，不作为界面标签。写入回执的 `content` 包含表名、正确操作动词与记录名，多项用换行列出；房间中的公开摘要和回执不命名私有对象。

### 第二批真实模型验收的展示约定（#70）

- `run_start` 请求载荷的 `access_summary` 是服务端生成的人类文字。离线电脑不能把研究网站显示成电脑联网许可；域名仍保留原始审批输入。支持域名隔离的电脑才声明可访问域名。
- 知识工具结果保留执行枚举，同时提供 `space_label`、`access_label`；空路径的 `where` 使用知识库中文名称。表格工具也为返回的访问级别提供 `access_label`。这些标签不改变权限。
- 房间消息发送前，服务端将正文中精确且唯一的 `@名字` 补入 `mentions`；只解析房间已有成员和 Agent，不通过名字扩大可回应的 Agent 范围。显式句柄保留，最多 50 项。
- `messages.steps[].recovered?` 表示同一操作和对象在后续步骤成功重试，原失败步骤仍保留人类原因。只有整个回复成功结束才标记。已批准写入失败同样显示操作与原因，房间共享摘要不暴露私有字段名。
- 数字字段 `config.currency?` 为三位大写币种代码，与 `precision?` 共用；未指定小数位时使用币种默认位数。应用记录、表格和内部表单使用相同字段设置。
- 未选择受众的已发布应用仍仅应用拥有者可打开；其他成员需要显式应用受众及底层表格权限，管理员身份不绕过这两层访问检查。

- `GET /api/runs?state=active` 的列表为空时附 `recent_finished`：按实际结束时间取最近三条已结束运行，沿用本人、Agent、来源及父运行筛选；原有 `items/next_cursor` 分页不变。这样较早创建、刚结束的长运行也会出现在空状态。

整合回归（#70，T14）：工具失败的模型结果与步骤摘要继续使用本地化的人类文字；`run_steps.error.code` 保留服务的稳定错误码，意外异常才记为 `tool_failed`。预算不足为 `budget_exceeded`，未设置价格为 `budget_estimate_unavailable`，表格自动化越过批准的来源表格为 `source_base_only`。知识查询的 `space` 保留范围枚举，`space_label` 和 `where` 提供可读范围与位置。

运维开关拒绝操作时统一返回 `operation_disabled`，`details.switch` 区分 `pause_background_runs`、`disable_computers`、`disable_outbound_mail`；Web 与原生按此字段显示本地化原因。截图已作为回复附件展示时，浏览器工具只向模型返回 `file_name` 和展示说明，文件编号仍由服务端保存。

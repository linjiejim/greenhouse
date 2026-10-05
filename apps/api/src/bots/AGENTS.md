## Bots（个人助理）— 领域规则与 HTTP 契约

每个成员开箱就有的常驻 Bot：有名字、角色和自己的记忆；多个 Bot 可以在同一个对话里协作（点名、
交接、共享笔记）；开了电脑后，一个成员的所有 Bot 共用一台云电脑（浏览器 + shell），成员随时可以
观看和接管；登录凭证来自只写不读的密码库。方案与决策（D1–D17）见
[spec](../../../../docs/specs/20261005-personal-assistant-bots.md)。数据层规则（单写者 / `bot_inbox`、
`MemoryScope`、`bot_computers` CAS）在 [packages/db/src/AGENTS.md](../../../../packages/db/src/AGENTS.md)。

```
bots/
├── engine/     # 对话引擎：chain（一条成员消息的整条链）、floor（发言调度）、turn（单个 Bot 回合）、
│               #   prompt / projection（历史投影）/ digest（滚动摘要）/ context-trim（回合内观测裁剪）、
│               #   inbox（单写者队列）、run-slot（跨进程互斥）、requests / approvals（「需要你」卡片）、
│               #   tasks / background（后台任务）、tools-assembly（工具面）、taint（污染判定兜底）
├── computer/   # 电脑：config / runtime（预检 + 生命周期循环）/ controller（DB 权威状态机）/ docker、
│               #   access（exec 隧道、文件、浏览器连接、打码集合）/ browser-session / tab-leases / snapshot、
│               #   lease（接管租约）/ viewer + rfb-filter（观看 WS）/ view-token / routes（含管理端）
├── vault/      # 密码库：crypto（AAD）/ origin / service / fill（代填）/ totp / turn-observations / routes
├── tools/      # Bot 工具（kind `special`）：team / conversation / bot-tasks / browser / computer / takeover / vault
├── routes.ts   # /api/bots 主路由（Bot、对话、笔记、请求、任务）
├── views.ts    # 行 → 视图（唯一的序列化出口）
└── purge.ts    # 删除成员时带走其 Bots 会话
```

### 铁律

- **Bot ≠ 自定义 Agent**：Bot 是轻量身份（名字 / 角色 / 守则 / 头像 / 可选模型）跑在 sprouty 基座上，
  工具面 = 主人自己的有效工具（Bot 永远不超过主人）+ Bot 工具。不要把 Bot 做成 profile 版本。
- **单写者**：Bots 对话只有持有该会话 run 的引擎写。服务端在对话进行中产生的一切（交还、续跑、后台
  汇报、忙时插话）走 `deliverToConversation()` → 抢到 run 就直接写，否则进 `bot_inbox`。inbox 是
  **先应用后消费**（稳定 message id `bot-inbox:<id>`，失败计数，5 次后隔离），跨进程互斥是会话级
  pg advisory lock（`bots-run:<sessionId>`，每进程一条保留连接）——蓝绿两个槽位共享一个库。
- **只有主人**：Bots 会话读写都只比 `user_id`（super 也不行，`sessions/access.ts`）；所有 `/api/bots/*`
  对他人的行一律 404。停用 / 删除 / 关掉 `bots` 开关 → 先停掉该成员进程内的 Bots run（关开关走
  `stopBotsRunsForUser()`，停用走 `chatRunRegistry.stopForUser`），再 `purgeUserComputer()`（停容器、断观看、
  取消后台任务，撤权类原因下 Docker 不可达也不抛）；删除成员另调 `purgeBotsConversations()`。
- **不可信输入会话**：一个回合里 Bot 会读网页、shell 输出、别的 Bot 的话，同时又能行动，所以：
  - 写 greenhouse 数据的工具（`BOT_APPROVAL_TOOL_IDS` + 目录里 `surface.proxy:'write'` 的）一律先出
    审批卡，成员点「允许」才执行；模型传 `confirm:true` 不算同意。审批等待 ≤110 s（回合的流超时 120 s
    覆盖工具执行）。卡片展示的是**将要发生的事**，不是模型的参数：发邮件卡经 `peekDraftToken` 显示已存
    草稿的发件人 / 收件人 / 主题 / 正文开头。
  - 污染判定：`engine/taint.ts` 是兜底（`TAINTING_TOOLS`），浏览器 / 电脑在真正读到外部内容时自己标记；
    `import_attachment` 不算污染（成员自己给的文件），但和其他外部来源一样记进密码库的外部读取账本——
    同一回合读过别的网站或外部内容后，代填一律要卡（`policy=auto` 也一样）。
  - 回合被污染（读过网页 / 外部内容）或不是成员直接发起（ask / followup / continue）时：`memory`
    remember 强制落 Bot 私有、update/forget 拒绝动用户级记忆；密码库代填一律要卡。
  - 历史投影给每条非本 Bot 的消息加保留说话人标签，伪造的 `[名字]:` 头被中和成引用。
- **后台任务只读且不把私有数据带上公网**：执行面是只读子集（无点击/输入/shell/密码库/团队/卡片），
  不给 mail 与其他会话；任何私有读取之后浏览器不能再打开或后退到新页面。汇报经单写者回到对话。
- **电脑零端口**：容器不发布端口、不访问 API；一切走 `docker exec`（VNC / CDP 是容器内 0600 的
  Unix socket，`agent` uid 读不到 `browser` uid 的东西）。硬化模式必须：gVisor `runsc`、IPv6 off +
  ICC off 网桥、`scripts/cloud-agent-net.sh --profile bots` 的出口规则（预检 + 每 10 分钟复验 +
  启动后探测宿主 API 端口与元数据地址必须不通）；任何一项不过只关电脑，Bots 照常聊天。
- **群聊的负责人**：归档 / 移除 Bot 时 `lead_bot_id` 交给按位置的下一个 active 成员，成员角色
  （`lead` / `member`）同步；私聊的 owner / guest 角色从不变。
- **DB 权威生命周期**：`bot_computers` 每次迁移都是 `version` CAS，单成员操作在用户锁里、容量判断在
  全局锁里；闲置停止 + LRU 淘汰会跳过有待处理登录 / 接管卡的电脑（`HUMAN_WAIT_HOLD_MS`）；健康 tick
  对账卡住的 starting / stopping 行（成员锁空闲时立即，否则 5 分钟兜底）。
- **一个成员的 DevTools 连接同一时刻只归一个 API 槽位**（蓝绿两槽共享 Docker）：会话级 pg advisory
  lock，等待方举手最多等 15 s 后报 `busy`（可重试）；持有方只在闲置 20 s 且有人在等时才让出（否则元素
  引用保持有效），停止 / 清除 / 关机时释放；接手死掉槽位的锁时立即清理它遗留的后台标签上下文。
- **接管 = 租约**：`lease_controller` + 单调 `lease_epoch`；电脑类工具在动作前与观测（快照 / 截图）
  前各校验一次 epoch，变了就丢弃观测；接管会中止在途的浏览器 / shell / 文件动作。观看 WS 的输入由
  `rfb-filter` 在服务端过滤（只读状态丢弃键鼠 / 剪贴板，SetEncodings 只放行能分帧的伪编码，未知即断）。
- **密码库只写不读**：读接口只返回 `VaultItemView`；没有任何工具或接口返回秘密字段；代填前按真实
  主框架 origin 精确匹配（子域要显式 `*.host`），拒收 greenhouse 自身 origin；已填值进电脑的打码集合
  （15 分钟）。安全登录卡的输入只经过一次请求体，不落库、不进消息、不进模型；两步登录（先用户名后
  密码）服务端会跟到同源的密码页或再出一张卡；等待的页面没了就按卡上的 URL 重新打开再填，实在不行
  （电脑重启过）才回 `computer_restarted`。
- **隐式接管卡**：成员在 Bot 动作进行中接管，或 Bot 要用电脑时成员正持有，电脑工具会留一张
  `takeover` 卡（`payload.implicit`，同会话同 Bot 去重，60 分钟过期，不发应用内通知——成员就在电脑前），
  交还即唤醒那个 Bot。卡上的页面标题是页面内容，只给成员看，绝不进转录行或通知。

### 上下文管理（数字以代码为准）

| 层 | 规则 |
|---|---|
| Prompt | system = S1 静态守则（按实际注册的工具拼段落）→ S2 Bot 身份与守则 → S3 成员自己的备注 → S4 滚动摘要（≤1500 字）；每回合重建、不落库的最后一条 user = T1（名册 / 群规 / 记忆索引 / 共享笔记索引 ≤1500 字，定界数据块）+ T2（本回合说明）；system 与历史前缀只追加，可缓存 |
| 历史投影 | 摘要边界之后的行逐行 sanitize + 说话人标签，按预算 48k token 开窗 |
| 滚动摘要 | 投影超过 24k token 时在**链边界**折叠，保留最近 ≥2 条链 / 8k token；结构化 JSON（目标、决定、待办、事实…），CAS 更新 |
| 回合内 | `browser` / `computer` 观测超过 12k token 时旧观测压成存根；文件产物（截图、share_file）整条保留 |
| 记忆 | 用户级 + 本 Bot 私有两个分区；Bot 只看自己的私有分区 |
| 预算 | 每条成员消息一条链：Bot 回合 ≤8、交接 ≤4、深度 <3、输入 600k（缓存 ×0.25）、输出 30k、步数 60、墙钟 20 分钟；单回合步数：点名 / 续跑 30、被问 12、收尾 4 |

### 测试

- 引擎、电脑、密码库的绝大多数逻辑用注入的假 Docker / 假时钟 / 脚本化模型做单测；数据库语义用
  `*.db.test.ts`；跨连接锁与容量竞争用 `*.db-commit.test.ts`。
- 浏览器适配层的套件（代填、安全登录、快照打码、BrowserSession、标签租约、页面工具）跑真 Chromium，
  需要 Playwright headless shell（`pnpm exec playwright install --only-shell chromium`）。CI 的 test
  job 已安装；`CI` 下缺浏览器直接失败。fork 的 CI 若跑 `pnpm test` 要加同一步，或设
  `BOTS_BROWSER_TESTS=skip`。
- 真容器套件（`computer.live.db-commit.test.ts`、`browser.live.db-commit.test.ts`）只在 `BOTS_LIVE=1` 且
  本机有镜像时跑；镜像本身用 `scripts/bot-computer-smoke.sh` 验（双 uid 隔离、零端口、CDP 中继）。
- 浏览器端：`tests/e2e-ui/bots.spec.ts`；带真模型真电脑的截图巡游 `scripts/capture-bots.mjs`
  （`node scripts/run-dev.mjs up web --bots` 之后跑）。

### HTTP 契约

类型在 `packages/types/src/bots.ts`（`@greenhouse/types/bots`），Web 端唯一客户端是
`apps/web/src/lib/api/bots.ts`（rpc）。所有 `/api/bots/*` 在 `requireInternal()` + `requireFeature('bots')`
之后，且按主人隔离（他人的行 = 404）。错误形如 `{ error, code }`。

**Bot 与对话**（`routes.ts`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/bots` | — | `{ bots, archived_bots, computer, vault_available, pending_requests }`（`bots` 只含 active） |
| POST | `/api/bots/bootstrap` | — | `{ bot, dm_session_id, created }`——首个 Bot（模板 `chief`）+ 私聊 + 固定欢迎语；幂等 |
| POST | `/api/bots` | `{ template_key?, name?, role?, instructions?, avatar?, model_id? }` | `{ bot, dm_session_id }` |
| PATCH / DELETE | `/api/bots/:id` | 同上字段 | `{ bot }` / `{ ok }`（删除 = 归档） |
| GET / DELETE | `/api/bots/:id/memories[/:memoryId]` | — | 该 Bot 的私有记忆 / `{ ok }` |
| GET / POST | `/api/bots/conversations` | `{ bot_ids, title? }` | 列表 / `{ conversation }`（1 个 id = 该 Bot 私聊，2–6 = 新群聊） |
| GET | `/api/bots/conversations/:id` | `before_seq?`、`limit?` | `{ conversation, messages, has_more, memory_states? }` |
| PATCH | `/api/bots/conversations/:id` | `{ title?, description?, lead_bot_id?, allow_bot_chat? }` | `{ conversation }` |
| POST / DELETE | `/api/bots/conversations/:id/members[/:botId]` | `{ bot_id }` | `{ conversation }`（私聊里邀请 = guest） |
| POST | `/api/bots/conversations/:id/read` · `/compact` | — | `{ ok }` · `{ digest }`（回合进行中 409） |
| GET / POST / PATCH / DELETE | `/api/bots/conversations/:id/notes[/:noteId]` | `{ title, body?, status?, pinned? }` | 共享笔记 |
| GET / POST | `/api/bots/conversations/:id/tasks` · `/api/bots/tasks/:runId/cancel` | — | 后台任务 |
| GET / POST | `/api/bots/requests` · `/api/bots/requests/:id` | `BotRequestDecision` | `{ request }`；冲突 409 `already_decided` / `deciding`，其他 409 带具体 code（`BotRequestErrorCode`：`page_gone` / `origin_mismatch` / `no_fields` / `failed` / `invalid` / `limit` / `computer_restarted` / `bot_gone`）且卡片保持待处理 |

名字校验：1–24 字，不含 `[ ] : ：` 与换行，非保留词、不等于成员昵称、在成员的 active Bot 中唯一 →
`400 { code: 'bot_name_invalid' | 'bot_name_taken' | 'bot_limit' }`。

**发消息**：`POST /api/chat` `{ session_id, messages:[{ role:'user', content, images? }], mentions? }`（文字或
图片至少一样；附件走 Chat 的 ```attachments 围栏）。`200` NDJSON（与 Chat 同传输、同重连）：每个 Bot
`bot-turn-start` → 常规事件 → `bot-turn-end`，卡片 `bot-request`，整条只有一个 `finish`。会话忙时
`202 { queued:true }`（回合之间送达）。私聊主人已归档 `409 { code:'bot_archived' }`；群里没有 active
Bot `409 { code:'no_active_members' }`。编辑 / 重新生成对 Bots 会话一律 409；停止走
`POST /api/chat/runs/:sessionId/stop`。

**卡片种类**：`approval`（`always` = 此站点以后自动代填）、`login`（安全登录，值服务端代填不落库；
两步登录会继续跟到密码页或再出一张卡）、`takeover`（`payload.implicit` = 成员在 Bot 干活时自己接管 /
Bot 等着用电脑，交还即唤醒它）、`bot_create`、`task_start`。登录 / 接管卡 60 分钟过期（`expired`）。

**电脑**（`computer/routes.ts`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET / POST | `/api/bots/computer` · `/start` · `/stop` · `/reset` | reset: `{ wipe_data? }` | `ComputerStatusView`（start 会等就绪或排队 ≤45 s） |
| POST | `/api/bots/computer/view-token` | — | `{ token, expires_at }`（60 s、一次性） |
| WS | `/api/ws/computer?token=` | 二进制 RFB | 非租约持有者服务端强制只读 |
| POST | `/api/bots/computer/takeover` | — | `ComputerStatusView` |
| POST | `/api/bots/computer/handback` | `{ note?, request_id?, session_id? }` | 结算点名的接管 / 登录卡（须属于 `session_id`），否则该会话里唯一的待处理接管 / 登录卡，否则只释放租约——从不跨会话猜 |
| POST | `/api/bots/computer/type` | `{ text }` | `{ ok }`（成员持有租约；写入焦点，支持中文） |
| GET | `/api/bots/computer/screenshot` | — | `image/png`；不唤醒电脑，停着时 `409 stopped` |

错误 code 见 `ComputerErrorCode`：`disabled`（含该成员没有 `bots`）、`unavailable`、`busy`（503 +
Retry-After；也可能是另一个 API 槽位正持有这台电脑的浏览器）、`start_failed`（502）、`user_in_control`、
`stopped`、`over_quota`（`reason:'host_disk'` = 宿主 Docker 磁盘剩余 <10 %，管理员处理；否则是成员 home
超软限额）、`lease_required`（409）、`invalid`（400）。观看关闭码：4001 票据无效（换票重连）、4003 开关关闭、4009 电脑不可用、4010 服务端
关闭、1011 电脑停止。WS 推送：`bots:computer`、`bots:conversation`、`bots:attention`。

**密码库**（`vault/routes.ts`）：`GET/POST /api/bots/vault`、`PATCH/DELETE /api/bots/vault/:id`、
`GET /api/bots/vault/log`。条目只返回元数据；未配置 `PROVIDER_TOKEN_ENCRYPTION_KEY` → `503 vault_unavailable`；
其余错误见 `VaultErrorCode`。

**管理端**（super）：`GET /api/admin/bot-computers`（运行时、每台电脑、旋钮、检查清单 `checks[]`：
docker / runtime / image / network / egress / host_disk …，每项带修复命令）、
`POST /api/admin/bot-computers/:userId/stop|reset`。旋钮是工作区设置 `bots.computer_idle_minutes` /
`bots.computer_max_running`。

**电脑工具 `import_attachment {file_id, path?}`**：只在前台回合；把本对话的聊天附件拷进
`~/work/inbox/`（或 `~/work` 内指定路径），≤20 MB，二进制安全。

**相关面**：`GET /api/auth/me/memories` 每行带 `bot_id` + `bot_name`（null = 用户级）；浏览器截图工具的
结果是本会话的聊天文件（`/api/chat-files/<id>/content`，主人鉴权），不进公共上传区。

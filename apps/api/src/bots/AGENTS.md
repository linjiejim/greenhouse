## Bots（个人助理）— 领域规则与 HTTP 契约

每个成员开箱就有的常驻 Bot：有名字、角色和自己的记忆；对话就是某个 Bot 的私聊，需要时它把成员的
其他 Bot 拉进来做客串，在同一个对话里协作（点名、交接、共享笔记）；开了电脑后，一个成员的所有 Bot 共用一台云电脑（浏览器 + shell），成员随时可以
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

- **每个成员都有 Sprouty**：内置主 Bot（`template_key = 'sprouty'`，sprout 植物，中英文都叫 Sprouty，岗位「主助手」），
  由 `POST /bootstrap` 保证存在（幂等，每次进入都可调；早于它的老成员下次进入补建，不占 20 个上限）——Bot 行本身也可能由
  聊天页先建（`ensureSproutyBot`），bootstrap 只补私聊与欢迎语。它在侧栏
  置顶、**不能归档**（`DELETE` 返回 400 `bot_protected`），可以改名改守则；它就是原来的「总管」——用 `team`
  工具把成员的其他 Bot 拉进对话（客串）、转交工作、提议新建。`POST /api/bots` 只接受模板库模板
  （`galleryTemplate`：研究员/操作员/写手/分析师）：Sprouty 只来自 bootstrap，「总管」模板已退役（旧的 chief Bot
  照常工作，`botTemplate('chief')` 仍能查到它的开场白与 starters）。
- **欢迎语一两句**（`engine/greeting.ts`，不调模型）：`你好，我是 **{名字}**，你的{岗位}。{pitch}`（无岗位就省掉那半句），
  不列能力清单、不写记忆行、不收尾提问——起手式由客户端显示在下面。它不能承诺部署没有的能力：`needsComputer`
  模板在电脑未就绪时用 `pitchNoComputer`。模板 pitch 保持短（中文 ≤30 字、英文 ≤90 字符，`greeting.test.ts` 守着）。
  已写入的欢迎语从不改写，改文案只影响之后新建的 Bot。
- **回复风格**：S1 的「Reply style」就是 `REPLY_STYLE_RULE`（`@greenhouse/utils/prompts`，开门见山、不复述不收尾客套、
  显而易见且安全的下一步直接做、否则最多给一个具体的下一步提议），与聊天页 `sprouty.yaml` 的 `## Communication`
  同一份措辞；模板守则只补岗位相关的话，不重复它。紧跟其后的「Cards speak for themselves」：Bot 发起卡片（审批 / 新建 Bot /
  后台任务 / 登录 / 守则修改）后不复述卡片内容，最多一句「你决定后会怎样」——成员看得到卡片。
- **Bot 就是 Agent 身份**（2026-10-07 收敛，[spec](../../../../docs/specs/20261007-agent-bot-convergence.md)；
  推翻 20261005 的 D2）：原「自定义 Agent」表已删，`bots` 吸收了它的 `description` / `tools`（null = 继承主人全部
  有效工具，列表 = 只能收窄的过滤器）/ `max_steps` / 不可变版本（`bot_versions`，每次创建或编辑追加一版，供
  `bot:<id>@<v>` 固定引用、守则提议卡与抽屉「历史」读）。**Bot 是私有的**（2026-10-08 决定）：没有分享、评审、
  发布或克隆，旧自定义 Agent 的治理列已随迁移 0014 删除；他人（super 除外）拿任何版本都是 403。
  同一个 Bot 有两种对话模式：**Bots 页的永续线程**（本引擎：摘要 / recall / 多 Bot / 电脑 / 审批卡）与**聊天页的新上下文**
  （chat 引擎，窗口化历史；`sessions.profile_id = 'bot:<id>'` 跟随主人的最新定义，无人值守固定 `bot:<id>@<v>`）。
  聊天页的默认身份 `sprouty` 按成员解析成**他自己的 Sprouty Bot**（`bots/sprouty.ts`，首次使用即建行），所以改名
  改守则到处生效。本引擎每回合按发言 Bot 的工具过滤与模型跑（`engine/bot-tools.ts`、`profileFromBot`），用量归属仍记
  `sprouty`。存量 `custom:<id>[@v]` 引用经 `bots.legacy_custom_id` 继续解析，不改写任何已存的 profile_id。
- **`bots` 开关只管永续线程与电脑，不管身份**：`/api/bots` 的身份类路径（列表 / 新建 / 修改 / 版本 / 记忆 / 文件）
  只要 `requireInternal()`；`bootstrap`、conversations、requests、tasks、computer、vault 才要 `requireFeature('bots')`。
  开关关闭时 `POST /api/bots` 不建私聊（`dm_session_id: null`），Web 不显示 Bots 导航，成员在「设置 → 我的 Bot」管理身份、
  在聊天页 `@` 使用。
- **Bot 私有参考资料夹**（`bots/folder.ts`，`drive_folders.bot_id`）：成员个人知识库下每 Bot 一个顶层私有文件夹，
  首次使用即建、随 Bot 改名。只新增一条**排除**规则：以 Bot X 身份跑的回合读个人知识库时看不到其他 Bot 的文件夹，
  `scope:'bot'` 只看自己的；没有 Bot 身份的面（MCP `desktop`、无身份的无人值守）看不到任何 Bot 文件夹；主人自己的
  HTTP 面什么都不排除。写入仍过审批卡。
- **守则由成员说了算**：`self` 工具只能**提议**（`instructions_update` 卡带理由与 diff，有效 7 天），成员接受才
  追加一版；污染回合也能提议，因为提议本身没有效果。
- **头像是一株植物**：`bots.avatar` 每次写入（创建 / PATCH / 确认 `bot_create` 卡）都过 `avatarConfigSchema`，
  未知键被剥掉，超长值返回 400。服务端统一用 `plantAvatarConfig()` 写：`plant`（物种 id）加最近的旧
  `color`（给不认识 `plant` 的老客户端），静息眼神存成旧的 `faceStyle`。这和 Web 编辑器是同一条规则，都不写
  `mood` 键：`legacyToMood` 先读 `mood`，旧客户端改了 `faceStyle` 会被一个过期的 `mood` 盖住（2026-10-09 起
  渲染端不再读神态，表情跟状态走；编辑器改写颜色 `tint`，`PLANT_TINTS` 之外的值由渲染端退回原色）。`plant` 不校验
  是否在 `PLANT_IDS` 里，未知值由渲染端的 `legacyToPlant` 兜底。模板就是同名植物（`TEMPLATE_PLANT`：
  sprouty → sprout（内置主 Bot）、researcher → dandelion 蒲蒲、operator → opuntia（仙人掌）仙仙、writer → fern 卷卷、
  analyst → clover 叶叶，退役的 chief → ivy；默认名在 `SPROUTY_BOT_TEMPLATE` / `BOT_TEMPLATES`）。已建的 Bot 存了自己的 `plant`，改这张表只影响新 Bot。`team` create 提议的
  Bot 取 `IMPLICIT_POOL[hashSeed(名字) % 14]`：同名总是同一株，也永远不会落到内置 Sprouty 专用的 sprout。
- **单写者**：Bots 对话只有持有该会话 run 的引擎写。服务端在对话进行中产生的一切（交还、续跑、后台
  汇报、忙时插话）走 `deliverToConversation()` → 抢到 run 就直接写，否则进 `bot_inbox`。inbox 是
  **先应用后消费**（稳定 message id `bot-inbox:<id>`，失败计数，5 次后隔离），跨进程互斥是会话级
  pg advisory lock（`bots-run:<sessionId>`，每进程一条保留连接）——蓝绿两个槽位共享一个库。
- **只有主人**：Bots 会话及 `bottask-` 子会话读写都只比 `user_id`（super 也不行，`sessions/access.ts`）；所有 `/api/bots/*`
  对他人的行一律 404。停用 / 删除 / 关掉 `bots` 开关 → 先停掉该成员进程内的 Bots run（关开关走
  `stopBotsRunsForUser()`，停用走 `chatRunRegistry.stopForUser`），再 `purgeUserComputer()`（停容器、断观看、
  取消后台任务，撤权类原因下 Docker 不可达也不抛）；删除成员另调 `purgeBotsConversations()`。
- **派生记录继承隐私**：Runtime 列表/详情/事件/命令/审批/统计与评测提取同样只有主人；
  使用持久的 `bots:` / `bottask-` 标记和 `source_mode=bots`，删除原会话不能重新开放历史 trace。
  禁止分享子会话，旧分享也不能在列表或未读数中泄露内容。
- **不可信输入会话**：一个回合里 Bot 会读网页、shell 输出、别的 Bot 的话，同时又能行动，所以：
  - 写 greenhouse 数据的工具（`BOT_APPROVAL_TOOL_IDS` + 目录里 `surface.proxy:'write'` 的）一律先出
    审批卡，成员点「允许」才执行；模型传 `confirm:true` 不算同意。审批等待 ≤110 s（回合的流超时 120 s
    覆盖工具执行）。卡片展示的是**将要发生的事**，不是模型的参数：发邮件卡经 `peekDraftToken` 显示已存
    草稿的发件人 / 收件人 / 主题 / 正文开头。卡片标题按成员 locale 写成动作短语（`copy.ts` `toolAction`：
    `允许 X 修改知识库？` / `Allow X to edit the knowledge base?`；`email_mutation` 分 draft / send），工具目录的
    英文 `name`（「Knowledge Mutation」）只给没有短语的写工具（扩展工具）兜底（`使用「name」`）；新增内置写工具要同时补短语。
    同一短语存进 `payload.summary`，转录行 / 通知只点一次名（`Sprouty 请你批准：修改知识库` / `Sprouty asks to edit the
    knowledge base`；没有 summary 的旧卡照旧用标题）。参数行的标签按 locale 译（`approvalFieldLabel`，没收录的键人性化
    显示），值保持调用原样；只藏 `APPROVAL_HIDDEN_FIELDS`（`confirm` / `user_confirmed` / `revision` / `draft_token`），
    目标 ID 照常显示。截断标记 `…(+N more characters)` 与 `…` / `+K more fields` 是客户端解析的协议，保持英文。
  - **外部连接器（`mcp_call`，spec 20261009-mcp-connectors D8/D9）**：不走上面的整工具包装——同一个工具里有只读也有写，
    读写只有它自己知道，所以 `createBotMcpCallTool` 把审批做成工具内回调：非只读远程工具每次 `call` 弹卡（标题
    `在「Linear」上运行 create_issue？` / `Run create_issue on Linear?`，参数行加「连接器」「工具」两行再列原样参数，
    服务器声明 destructive 时多一行说明），只读调用不弹；Bots 脸的 schema 里没有 `confirm`。成员没连接时先返回
    `needs_connection`（不弹卡、不碰远端）。Bot 的 `connectors`（JSON 文本，null = 主人能用的全部，`[]` = 不用）
    随版本走，manifest hash 只在非 null 时纳入（老版本 hash 不变）。后台任务仍拿不到（无人审批）。
  - 污染判定：`engine/taint.ts` 是兜底（`TAINTING_TOOLS`，含 `mcp_call` 的所有动作——远程工具的描述也是外部文本），浏览器 / 电脑在真正读到外部内容时自己标记；
    `import_attachment` 不算污染（成员自己给的文件），但和其他外部来源一样记进密码库的外部读取账本——
    同一回合读过别的网站或外部内容后，代填一律要卡（`policy=auto` 也一样）。
  - 回合被污染（读过网页 / 外部内容）或不是成员直接发起（ask / followup / continue）时：`memory`
    remember 强制落 Bot 私有、update/forget 拒绝动用户级记忆；密码库代填一律要卡。
  - 历史投影给每条非本 Bot 的消息加保留说话人标签，伪造的 `[名字]:` 头被中和成引用。
- **后台任务只读且不把私有数据带上公网**：执行面是只读子集（无点击/输入/shell/密码库/团队/卡片），
  不给 mail 与其他会话；初始上下文只有成员确认卡上的完整 brief，不自动注入历史、摘要、笔记索引、
  记忆或个人/Bot 指令。需要本会话私有上下文时显式调用 `conversation notes/recall`；它们与文件、
  内部资源一样，在读取前就锁住后续全部浏览器动作（包括滚动/查看/等待，已加载页面的事件也能外发数据）。汇报经单写者回到对话。
- **电脑零端口**：容器不发布端口、不访问 API；一切走 `docker exec`（VNC / CDP 是容器内 0600 的
  Unix socket，`agent` uid 读不到 `browser` uid 的东西）。硬化模式必须：gVisor `runsc`、IPv6 off +
  ICC off 网桥、`scripts/cloud-agent-net.sh --profile bots` 的出口规则（预检 + 每 10 分钟复验 +
  启动后探测宿主 API 端口与元数据地址必须不通）；任何一项不过只关电脑，Bots 照常聊天。
- **镜像契约 2**：API 只认 `IMAGE_CONTRACT` 同版本的镜像（`greenhouse.bots.computer.contract`），升级 API 必须
  重建镜像。契约 2 = 桌面（tint2 任务栏 + `gh-window` 看门狗：所有浏览器窗口都被最小化 3 s 后自动恢复）、
  软件 WebGL（`--enable-unsafe-swiftshader`，边界仍是 gVisor）、浏览器语言用 `LANGUAGE` + `--accept-lang`
  （Linux Chromium 不认 `--lang`）、`gh-term` / `gh-jobs` / `gh-window` / `gh-agent-kill`，以及预装的
  pip / Node / ffmpeg / pandoc / sqlite 等；`agent` 的 pip / npm / pipx 用户级安装落在 home 卷，系统目录仍只读；
  组织级额外软件包在构建时用 `BOTS_COMPUTER_EXTRA_PACKAGES`（镜像标签记录，预检里展示）。
- **群聊已退役（2026-10-09）**：一段对话就是一个 Bot 的私聊（`kind = 'direct'`，`lead_bot_id` = 主人，主人归档后为
  null），其他 Bot 只以客串（`guest`）身份加入——Bot 用 `team.add` 自己拉人、成员手动邀请照旧；Bot 之间的交接
  （`team.ask`）**永远允许**，没有开关（`allow_bot_chat` 列保留但不再读取，迁移 `0015_bots_groups_retired` 把它全置
  true，API 视图恒报 `true`）。存量群聊（`kind = 'group'`）是只读历史：照常列出、可读，但发消息 / 邀请 / 移出 / 处理
  卡片一律 `409 group_closed`；引擎**从不**在群里开或续一个回合——`deliverToConversation` / 清扫器对群只把排队项
  （事件、后台汇报、唤醒的那行字、关闭前排队的成员消息）作为记录写入、不唤醒任何 Bot，`runBotsRun` 落到群里也只记录后
  结束（两道闸都有测试）。迁移同时把群里所有仍待处理的卡片置为 `canceled`（`result = {"decision":"group_closed"}`），
  不删任何行。测试里的旧群用 `__tests__/helpers/legacy-group.ts` 直接插库（API 已经建不出来）。私聊的 owner / guest
  角色从不变；归档一个 Bot 把它从所有客串位（以及旧群的名单）里移出，不再改派负责人。
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
  （电脑重启过）才回 `computer_restarted`。`request_takeover` 的 login / otp 出的是安全登录卡：S1 规则、
  工具说明和工具返回都要求 Bot 请成员「填写上面的卡片」，别说「接管浏览器」（模型默认会这么说）；
  captcha / other 才是接管卡。
- **人机验证只交给人**：浏览器在导航 / 提交后嗅探（`needs-human.ts`）：「Just a moment…」类过渡页每 1.5 s
  复查、最多 6 s（自己会放行的不出卡）；仍是过渡页、页面上有验证组件，或导航响应是带 Cloudflare 信号
  （`cf-mitigated`，或 `server: cloudflare` + 挑战标题）的 403 / 406 / 429 / 503 → 前台回合由浏览器工具
  **自己**出 `takeover` 卡（`payload.kind:'captcha'`，同会话同 Bot 去重）并在这一步后结束回合；同一回合
  里再 `open` 这个站点直接拒绝（`human_check`），后台回合只给提示、不出卡。成员在卡片里「在这里验证」
  （接管）、自己完成，再点「完成，交还」唤醒 Bot——交还永远由成员决定，服务端不判断验证是否通过。
  不解验证码、不隐藏自动化特征、不伪装指纹、不接打码服务。
- **长任务走 `gh-jobs`**：shell 每条 ≤120 s；更长的用 `computer run_background`（独立会话、日志在
  `~/.local/state/gh-jobs/<id>/`）。运行中的作业让电脑不因闲置休眠（自 `last_active_at` 起最多
  `BOTS_COMPUTER_JOB_MAX_HOURS`，默认 8 小时）；接管时的杀进程（`gh-agent-kill`）放过作业和成员的终端 /
  tmux 会话；容器回收后作业显示 `lost`。
- **打断 ≠ 停止**：`POST /api/chat/runs/:sessionId/interrupt` 让当前回合**这一步做完**再结束（在途工具
  照常完成并落库，比如已经在生成的图），丢掉链里排好的回合；有排队的成员消息就开新链回答它，否则
  结束 run 并写停止提示。`/stop` 仍是立即硬停（在途工具结果丢弃）。
- **隐式接管卡**：成员在 Bot 动作进行中接管，或 Bot 要用电脑时成员正持有，电脑工具会留一张
  `takeover` 卡（`payload.implicit`，同会话同 Bot 去重，60 分钟过期，不发应用内通知——成员就在电脑前），
  交还即唤醒那个 Bot。卡上的页面标题是页面内容，只给成员看，绝不进转录行或通知。

### 上下文管理（数字以代码为准）

| 层 | 规则 |
|---|---|
| Prompt | system = S1 静态守则（按实际注册的工具拼段落）→ S2 Bot 身份与守则 → S3 成员自己的备注 → S4 滚动摘要（≤1500 字）；每回合重建、不落库的最后一条 user = T1（名册：主人与客串 / 记忆索引 / 共享笔记索引 ≤1500 字，定界数据块）+ T2（本回合说明）；system 与历史前缀只追加，可缓存 |
| 历史投影 | 摘要边界之后的行逐行 sanitize + 说话人标签，按预算 48k token 开窗 |
| 滚动摘要 | 投影超过 24k token 时在**链边界**折叠，保留最近 ≥2 条链 / 8k token；结构化 JSON（目标、决定、待办、事实…），CAS 更新 |
| 回合内 | `browser` / `computer` 观测超过 12k token 时旧观测压成存根（机制是 agent-core 的 `createToolResultMasker`，与 chat 共用；策略不同：只遮观测、只留最新一条、**不开** `pinRefetched`——同一个 `snapshot` 入参每次拿到的是新页面，是「后者取代前者」而不是重取）；文件产物（截图、share_file）整条保留 |
| 记忆 | 用户级 + 本 Bot 私有两个分区；Bot 只看自己的私有分区；索引预算 3000 字 = 用户级 1800 + 私有 1200（`llm/memory.ts`） |
| 预算 | 每条成员消息一条链：Bot 回合 ≤8、交接 ≤4、深度 <3、输入 600k（缓存 ×0.25）、输出 30k、步数 60、墙钟 20 分钟；单回合步数：点名 / 续跑 30、被问 12、收尾 4 |

### 测试

- 引擎、电脑、密码库的绝大多数逻辑用注入的假 Docker / 假时钟 / 脚本化模型做单测；数据库语义用
  `*.db.test.ts`；跨连接锁与容量竞争用 `*.db-commit.test.ts`。
- 浏览器适配层的套件（代填、安全登录、快照打码、BrowserSession、标签租约、页面工具）跑真 Chromium，
  需要 Playwright headless shell（`pnpm exec playwright install --only-shell chromium`）。CI 的 test
  job 已安装；`CI` 下缺浏览器直接失败。fork 的 CI 若跑 `pnpm test` 要加同一步，或设
  `BOTS_BROWSER_TESTS=skip`。
- 真容器套件（`computer.live.db-commit.test.ts`、`browser.live.db-commit.test.ts`）只在 `BOTS_LIVE=1` 且
  本机有镜像时跑；镜像本身用 `scripts/bot-computer-smoke.sh` 验（双 uid 隔离、零端口、CDP 中继，以及
  契约 2 的任务栏 / 窗口恢复 / WebGL / 语言 / gh-term / gh-jobs / gh-agent-kill / 用户级安装持久化）。
- 浏览器端：`tests/e2e-ui/bots.spec.ts`；带真模型真电脑的截图巡游 `scripts/capture-bots.mjs`
  （`node scripts/run-dev.mjs up web --bots` 之后跑）。

### HTTP 契约

类型在 `packages/types/src/bots.ts`（`@greenhouse/types/bots`），Web 端唯一客户端是
`apps/web/src/lib/api/bots.ts`（rpc），移动端是 `apps/mobile/src/api/bots.ts`（vendored 类型
`apps/mobile/src/shared/bots.ts`）。所有 `/api/bots/*` 都在 `requireInternal()` 之后；`requireFeature('bots')`
只挡永续线程那一侧——`bootstrap`、`conversations*`、`requests*`、`tasks/*`、`computer*`、`vault*`；
Bot 身份本身（列表 / 新建 / 编辑 / 版本 / 文件夹 / 记忆）只要内部账号（见 `apps/api/src/index.ts`）。
全部按主人隔离（他人的行 = 404）。错误形如 `{ error, code }`。

**Bot 与对话**（`routes.ts`）

| 方法 | 路径 | 请求 | 响应 |
|---|---|---|---|
| GET | `/api/bots` | — | `{ bots, archived_bots, computer, vault_available, pending_requests }`（`bots` 只含 active） |
| POST | `/api/bots/bootstrap` | — | `{ bot, dm_session_id, created }`——确保 Sprouty（模板 `sprouty`）+ 私聊 + 固定欢迎语存在；幂等，老成员也会补建 |
| POST | `/api/bots` | `{ template_key?, name?, role?, description?, instructions?, avatar?, model_id?, tools?, max_steps?, change_log? }`（`template_key` 只收模板库：`sprouty` / `chief` → 400；`tools` null = 继承、列表须在主人 allow-set 内否则 400/403） | `{ bot, dm_session_id }`（`bots` 开关关闭时 `dm_session_id: null`） |
| PATCH / DELETE | `/api/bots/:id` | 同上字段（每次 PATCH 追加一版） | `{ bot }` / `{ ok }`（删除 = 归档；Sprouty → 400 `bot_protected`） |
| GET | `/api/bots/:id/versions` | — | `{ bot_id, profile_id, current_version, versions }`（仅主人；super 可查） |
| GET / POST | `/api/bots/:id/files` · `/api/bots/:id/files/ensure` | — | `{ folder, docs }`（无文件夹时 `folder: null`）· `{ folder }`（首次使用建文件夹） |
| GET / DELETE | `/api/bots/:id/memories[/:memoryId]` | — | 该 Bot 的私有记忆 / `{ ok }`；改为共享走 `PATCH /api/auth/me/memories/:id { bot_id: null }` |
| GET / POST | `/api/bots/conversations` | `{ bot_ids }`（恰好 1 个 id） | 列表 / `{ conversation }`（该 Bot 的私聊，没有就建）；0 个或多个 id → `400 groups_retired`（群聊已退役）。每行带 `attention`（需要你 > 未读 > 在忙）、`pending_requests` 与 `unread_count`（`last_read_at` 之后 Bot 的回复条数，`assistant` 行，封顶 99；只来了系统事件时 `attention:'unread'` 而计数为 0） |
| GET | `/api/bots/conversations/:id` | `before_seq?`、`limit?` | `{ conversation, messages, has_more, memory_states? }`（`allow_bot_chat` 已废弃、恒为 `true`；旧群 `kind:'group'` 照常可读） |
| POST / DELETE | `/api/bots/conversations/:id/members[/:botId]` | `{ bot_id }` | `{ conversation }`（邀请 = guest；主人不能移出 400 `cannot_remove_owner`；旧群 `409 group_closed`） |
| POST | `/api/bots/conversations/:id/read` · `/compact` | — | `{ ok }` · `{ digest }`（回合进行中 409） |
| GET / POST / PATCH / DELETE | `/api/bots/conversations/:id/notes[/:noteId]` | `{ title, body?, status?, pinned? }` | 共享笔记 |
| GET / POST | `/api/bots/conversations/:id/tasks` · `/api/bots/tasks/:runId/cancel` | — | 后台任务 |
| GET / POST | `/api/bots/requests` · `/api/bots/requests/:id` | `BotRequestDecision` | `{ request }`；冲突 409 `already_decided` / `deciding`；旧群的卡 409 `group_closed`（仍待处理的顺手撤成 `canceled`）；其他 409 带具体 code（`BotRequestErrorCode`：`page_gone` / `origin_mismatch` / `no_fields` / `failed` / `invalid` / `limit` / `computer_restarted` / `bot_gone`）且卡片保持待处理 |

对话没有可编辑的设置：原 `PATCH /api/bots/conversations/:id`（群标题 / 群规 / 负责人 / Bot 互聊开关）已删除。

名字校验：1–24 字，不含 `[ ] : ：` 与换行，非保留词、不等于成员昵称、在成员的 active Bot 中唯一 →
`400 { code: 'bot_name_invalid' | 'bot_name_taken' | 'bot_limit' }`。

**发消息**：`POST /api/chat` `{ session_id, messages:[{ role:'user', content, images? }], mentions? }`（文字或
图片至少一样；附件走 Chat 的 ```attachments 围栏）。`200` NDJSON（与 Chat 同传输、同重连）：每个 Bot
`bot-turn-start` → 常规事件 → `bot-turn-end`，卡片 `bot-request`，整条只有一个 `finish`。会话忙时
`202 { queued:true }`（回合之间送达）。旧群聊 `409 { code:'group_closed' }`（先于其他检查，忙时也不排队）；私聊主人已归档
`409 { code:'bot_archived' }`（两者即 `BotConversationReadOnlyCode`；`no_active_members` 不再返回，只留在旧群的
`unavailable` 事件里）。编辑 / 重新生成对 Bots 会话一律 409；停止走
`POST /api/chat/runs/:sessionId/stop`；打断（这一步做完再停，排队的消息接着处理）走
`POST /api/chat/runs/:sessionId/interrupt` → `{ ok, run_id }`（只限主人；非 Bots 会话 400
`not_supported`；没有在跑的 run 404），流里发一次 `{ type:'run-interrupting' }`，之后照常是下一条链的
`bot-turn-start`。

**卡片种类**：`instructions_update`（Bot 用 `self` 工具提议改自己的守则：payload `{ instructions, reason, current }`，接受可带编辑后的 `instructions`，接受 = 追加一版 + 事件 `instructions_updated`，7 天过期）、`approval`（`always` = 此站点以后自动代填）、`login`（安全登录，值服务端代填不落库；
两步登录会继续跟到密码页或再出一张卡）、`takeover`（`payload.implicit` = 成员在 Bot 干活时自己接管 /
Bot 等着用电脑，交还即唤醒它；`payload.kind:'captcha'` = 人机验证卡，由浏览器工具自己出，成员完成后
交还）、`bot_create`、`task_start`。登录 / 接管卡 60 分钟过期（`expired`）。

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
| PUT | `/api/bots/computer/settings` | `{ timezone: string \| null }`（IANA；null = 部署默认） | `ComputerStatusView`（下次启动生效；`lang` 来自成员 locale，`BOTS_COMPUTER_LANG` 覆盖） |
| POST | `/api/bots/computer/restore-window` | — | `{ ok }`（`gh-window restore`；停着时 `409 stopped`；每次交还后也会自动跑） |
| POST | `/api/bots/computer/terminal-token` | — | `{ token, expires_at }`（60 s、一次性，用途与观看票据互不通用） |
| WS | `/api/ws/computer-terminal?token=` | 二进制 = 键入；文本 `{"type":"resize","cols","rows"}` | 二进制终端输出；`gh-term` + tmux，`agent` uid、成员的终端不需要租约；每进程每成员 ≤4 个 |
| GET | `/api/bots/computer/files` | `?path=`（默认 `~/work`） | `ComputerFileList`（≤500 项，目录在前；路径须在 `/home/agent` 内，容器里 `realpath` 复核） |
| GET | `/api/bots/computer/files/download` | `?path=` | 文件流（≤1 GiB；`Content-Disposition: attachment`、`nosniff`、`no-store`） |
| POST | `/api/bots/computer/files/upload` | `?dir=&name=` + 原始字节（≤100 MiB） | `{ entry, path }`；同名不覆盖（`name (1).ext`）；`413 too_large` |
| GET | `/api/bots/computer/processes` | — | `{ processes: ComputerProcessView[] }`（不唤醒电脑） |
| GET | `/api/bots/computer/processes/:id/log` | `?lines=`（≤2000） | `ComputerProcessLog`（打码后） |
| POST | `/api/bots/computer/processes/:id/stop` | — | `{ id, stopped }` |

文件 / 进程另有 `not_found`（404）与 `too_large`（413）。终端关闭码：4001 票据无效或成员被撤权、4003 开关
关闭、4009 电脑不可用（`too_many` = 第 5 个终端）、4010 清除 / 关机、1008 协议错误、1011 shell 退出或电脑
停止。终端、作业和 Bot 的 shell 用同一套身份与 `BOTS_COMPUTER_PROXY`（`shell.ts` `agentEnv`）。

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
`~/work/inbox/`（或 `~/work` 内指定路径），≤20 MB，二进制安全。后台进程：`run_background {command, name?}`
· `processes` · `process_log {id, lines?}`（打码、从尾部截断、污染回合）· `stop_process {id}`；后台回合
只有 `status` / `read_file` / `processes` / `process_log`。

**浏览器工具新增**：`hover {ref}`、`drag {ref, to_ref}`、`upload {ref, path}`（~ 内的文件，≤20 MB；不是
file input 就点它并接住弹出的文件选择框）、`wait {text?, timeout_s?}`（≤30 s；后台回合也可用）。新错误码：
`human_check`、`not_a_file_input`、`file_unreadable`、`wait_timeout`；观测里 `blocked:'human_check'` 表示已
交给成员。

**相关面**：`GET /api/auth/me/memories` 每行带 `bot_id` + `bot_name`（null = 用户级）；浏览器截图工具的
结果是本会话的聊天文件（`/api/chat-files/<id>/content`，主人鉴权），不进公共上传区。与某个 Bot 的按会话聊天（聊天页的
新上下文）走 `GET /api/sessions?scope=mine&profile=bot:<id>`（主 Bot 用 `sprouty`），固定版本与旧 id 一并算上，口径见
[apps/api/src/AGENTS.md](../AGENTS.md)「会话列表的 profile 筛选」。

## 后端 API 规则

### 日志规范
- 所有后端日志使用 `utils/logger` 中的 `logger.info/warn/error`
- **禁止使用 `console.log/warn/error`**——统一用结构化 logger
- 日志格式：`[INFO/WARN/ERROR] 消息` + 可选 data 对象

### 路由规范
- 每个路由文件顶部添加中文注释块，列出所有端点：
  ```
  /**
   * XXX 路由 — /api/xxx
   *
   * GET  /api/xxx     — 获取XXX列表
   * POST /api/xxx     — 创建XXX
   */
  ```
- 路由文件放在 `routes/` 目录下，每个资源一个文件
- **路由必须链式定义**（2026-06 起，hc 契约的前提）：`const x = new Hono<AppEnv>().get(...).post(...)`，禁止 `x.get(...)` 语句式注册——语句式不积累类型，端点会从 `AppType` 契约里消失。`AppEnv` 来自 `src/app-env.ts`
- 工厂路由（`createXxxRoute()`）**禁止写显式 `: Hono` 返回类型注解**——会把链式 schema 抹平，hc 推导失效
- **响应对象里不许有 `any`**：handler 返回值若含 `any` 字段，整条路由的推导响应会塌成 `never`（hc 端点直接不可用）。raw SQL 结果先标注形状再 `c.json()`
- 全部路由经 `src/index.ts` 的 `mountRoutes()` 单链挂载（**注册顺序有安全语义，禁止重排**）；`export type AppType` 即对外契约，由 `@greenhouse/contract` 重导出给浏览器 Web typed client
- **WS / 定时器回调绝不能留未处理的 rejection**：`@hono/node-server` 不 await `onOpen` / `onMessage` / `onClose`，`setInterval(() => void x())` 也一样——一次 reject 就是 unhandled rejection，Node 直接退出整个 API（2026-10-08 一次 postgres `CONNECT_TIMEOUT` 就这样打挂了本地 API）。异步回调自己 try/catch + `logger.warn`。`/api/ws` 账号查询失败关 **1011**（客户端退避重连）；4001 / 4002 / 4003 只留给鉴权与终态。
- **长时流式响应必须同时有心跳和上游时限**：`routes/chat.ts` 每 `STREAM_KEEPALIVE_MS`（15s）写一条 `{"type":"ping"}`，并带 `X-Accel-Buffering: no`；`agent-core/chat-engine.ts` 的 `CHAT_STREAM_TIMEOUT` 则约束 LLM 总时长、单步时长和无 chunk 时长。两者解决不同问题：心跳防反代把健康的慢工具掐断；SDK timeout 防上游已经僵住却被心跳无限续命。`chunkMs` 也覆盖本地工具执行，必须高于生图实测的 30–100s。AI SDK timeout 发的是 `abort` part，不是普通 `error`，两者都必须转成前端错误并走中断落库。中断时剥掉未闭合的 chart/confirm/datatable fence，持久化安全的部分正文 + 明确重试提示，再结束 HTTP 响应；禁止让刷新抹掉整轮。心跳是纯填充，`handleStreamEvent` 里必须保持空 case——任何回调都会污染 transcript。
- **中断文案统一收敛，唯一例外是用量预算拒绝**（`chat/turn.ts` 的 `usageBudgetNotice`）：其余失败一律收成通用「请重试」——原始 provider 错误既不可行动又是泄露面。预算准入不同，三点缺一不可：文案是我们为用户写的、拒绝发生在任何 provider I/O **之前**（没计费也没有上游细节）、而「请重试」对它是**假话**（每次重试都在 ~1s 后被同样拒绝，用户会照做很多次）。识别要沿 `cause` 链走几层——AI SDK 会用 `RetryError` 之类把它包起来。同一句话必须同时进流事件与持久化的 assistant 消息，否则刷新后又变回「请重试」。见 [spec D1](../../../docs/specs/20260813-usage-budget-admission-truthfulness.md)。
- **Chat 生成与 HTTP 响应解耦（run 注册表）**：一轮生成 = 一个 `ChatRun`（`chat/runs.ts`，进程内 seq 事件缓冲 + 订阅者 + abort signal），agent loop 在 `chat/turn.ts` 的 `pumpChatTurn` 里 detached 跑，POST 响应只是 0 号订阅者——断连/刷新不影响生成，重连走 `GET /api/chat/runs/:sessionId/stream?after=seq`（回放标 `replayed:true` 再实时尾随），探测/列表/停止见 `routes/chat.ts` 头注释。**分层固定**：`routes/chat.ts` 只做协议适配（鉴权 → 工具装配 → 起 run → 订阅），泵循环与订阅层在 `chat/turn.ts`，终态落库在 `chat/persist.ts`；别把循环搬回路由。回放信封（`seq`/`replayed`）与 `ChatRunStatus` 定义在 `@greenhouse/types/api`，服务端盖章、浏览器读取，禁止任一端另建本地定义。硬约束：**同 session 一次一轮**（claim 在持久化 user 消息之前，重复 POST 409；claim 后的预检失败必须 release）；**先落库再 `finish(run)`**——订阅者以流关闭为"可安全重拉消息"的信号，颠倒顺序会让前端 reload 与 DB 写入竞态；心跳按连接写、不进缓冲；服务端 stop 与 SIGINT/SIGTERM（`registry.shutdown` 先于 db.close）都走 abort → 中断落库路径；生命周期经 WS `chat:run` 推给属主（只推 id/状态不推内容）。限流表里 `/api/chat/runs` 必须排在 `/api/chat` **之前**（`matchRateLimit` 首个前缀命中即生效），否则重连/探测会吃掉 LLM 消息配额。注册表是内存态（pm2 单进程），多实例部署前必须重新设计。
- **Chat 历史有发送前预算窗口，预算按当轮模型派生**：`windowMessagesByBudget`（`@greenhouse/agent-core` 的 `context-budget`，CJK≈1 字/token、其余≈4 字符/token）在模型解析后、发模型前把最老的整条消息裁出窗口，最新一条永远保留；只裁模型载荷，**不动 DB 转录**。预算 = `resolveHistoryBudget(当轮模型 id)` = models.yaml 逐模型声明的 `context_window` × `compaction_threshold`（阈值缺省 0.5，上限 0.9；窗口按 provider 链**最小值**声明），未声明窗口的模型回退 `HISTORY_TOKEN_BUDGET`=80k。当前：flash/pro 128k → 预算 64k（跟随 `LLM_MODEL`，按最保守值声明），deepseek-flash 1M → 500k。自动摘要/压缩尚未实现——这是防上游上下文超限的安全下限，不是记忆策略；`compaction_threshold` 同时预留为将来折叠式压缩的触发点，**滑窗一旦触发,每轮头部平移会让 provider 前缀缓存全失效**（DeepSeek 自动缓存实测命中 ~90%），所以真到常规触发时应改折叠而不是调大窗口。见 [spec](../../../docs/specs/20260806-model-context-window-and-compaction-config.md)。

### 会话列表的 scope 筛选（`GET /api/sessions?scope=`）

侧边栏「我的 / 分享给我 / Team」三档的后端。方案与决策（D1–D8）见 [spec](../../../docs/specs/20260806-session-list-scope-filter.md)。

- **不传 `scope` = 历史行为，一个字节都没变**（super 看全部、team 看自己 + 分享回填）。历史弹框仍这么用，所以别把默认改成 `mine` —— 那会让 View All 名不副实且波及面不可控。
- `scope=team` **对非 super 直接 403**，不是静默返回空数组：空列表会把调用方的 bug 藏起来。
- **`channel` / `exclude_channel`**：`channel=task` = 侧栏「定时任务」（只看 automation 运行会话，无 pin 回填）；`exclude_channel=task`（逗号列表，名称不合法 400）= 「我的」去掉 automation 运行，叠加在默认排除的 `workflow` 之上，pin 回填与分享回填同样排除。
- **`excludeUserId` 必须用 `IS DISTINCT FROM`**（`conversations.user_id` 可空：历史与引擎会话没有 owner）。写成 `<>` 的话三值逻辑会静默吞掉所有无主会话，「除我以外的全部」就变成「除我以外**有主**的全部」，且没有任何报错。
- **`owner_nickname` 按「owner ≠ 请求者」统一附带，不按 scope 特判**（`withOwnerNicknames`）：一条规则同时覆盖 Team tab、分享 tab、super 的无 scope 列表、team 用户的分享回填行。按 scope 特判的话历史弹框里 super 看别人的会话就没名字，得再开第二条通道。
- **分享列表查询只有一份**：`db.sessions.listSharedWith()`。`scope=shared` 用它，无 scope 的回填也用它（原先是拿到 id 列表后逐个 `getById` 的 N+1）。它是 EXISTS 半连接不是 join —— 同一会话可能同时有直接分享和 `__team__` 分享，join 会把它返回两次。
- **pin/分组回填只在 `mine` 与无 scope 下做**：归档整理是显式动作，优先级高于 scope；`shared`/`team` 是平铺列表，回填进去只会让人困惑。

### 个人资产的 scope 筛选

Automation、Tasks、Agents 的 `Mine / Shared / Team` 口径见 [personal asset scope spec](../../../docs/specs/20260812-personal-asset-scope-tabs.md)。共通约束：`Team` 只给 super，三档互斥，外部资产带 `owner_nickname`；管理员跨用户查看不是“共享”。Tasks 的 `GET /api/prompts?scope=` 在服务端筛选，`team` 对普通成员 403；不传 scope 仍保持 Chat 选择器所需的“自己的 + global”。Automation 当前没有分享模型，Web 的 Shared 是明确空态；不要把 super 的全量 `/api/tasks` 响应归类为 Shared。

### 鉴权模块 (`auth/`)
- 所有鉴权逻辑放在 `auth/` 目录（token、middleware、password）
- 内部 CLI/服务器自调用：必须传递真实且当前有效的 team/super access token；禁止合成 `internal` 用户或绕过数据库用户校验
- 禁止从已删除的 `auth.ts` 导入——始终使用 `auth/index.ts`
- **fail-closed 启动闸（`assertAuthEnv()`，main() 启动时调用）**：`TOKEN_SIGNING_KEY` 在所有环境（本地/dev/生产）一律必填、必须是 64 位 hex（32 bytes）且无 fallback，缺失或格式错误时服务拒绝启动。`authMiddleware` 永远要求实名内部账号的 Bearer token，不存在 dev/匿名 super 旁路；每次请求重新读取用户状态、当前角色与 `auth_version`，已删除、禁用、历史 `external` 或密码重置前签发的 token 立即失效。refresh token 同样记录签发版本并单次消费，密码重置在一个事务内递增版本并撤销 refresh。契约由 `tests/api/token.test.ts`、`auth/__tests__/internal-only.test.ts` 与 `routes/__tests__/auth-version.test.ts` 锁定。
- **受邀设密/安全重置不是登录旁路**：只有 super 可签发 `invite/reset` 链接；公共面精确限定为 `POST /api/auth/password-link/{inspect,complete}`，没有 GET 消费、公共注册或忘记密码。fragment token 只按 hash 查库，inspect 不消费；complete 在 DB 锁内单次消费后才签发正常 Access/Refresh 会话。公共端点必须保留 4KB body limit、IP + token-hash 双限流、统一无效错误与 `no-store`。邮件重置签发即进入 `reset_required` 并主动停 Chat/WS、Scheduler、Workflow；安全状态已提交后，运行时清理失败只能记录日志，不能恢复旧凭证。

### 安全 (`security/security.ts`)
- 用户输入在传给 LLM 前**必须**经过 `sanitizeForPrompt()` 处理
- 使用 `checkPromptInjection()` 检测和记录注入攻击
- 限流一律走 `checkRateLimit(key, windowMs, max)`——不要单独实现。计数在 `rate_limits`（固定窗口、按 epoch 对齐，桶 key = `<key>:<窗口起点 ms>`，一次原子 upsert-increment），所以重启不清零、多实例共享；限额与 `X-RateLimit-Limit/Remaining/Reset` 响应头不变。过期桶由 `index.ts` 的五分钟 upkeep 清扫。
- **限流故意 fail-open**：计数表调用失败时放行，并每分钟最多记一条 warn（带期间放行数）。限流是防滥用的刹车，不是鉴权：后面的路由照样查库鉴权，库挂了本就过不去；而计数表一次抖动若 fail-closed，就是对全员 429。别把它改成 fail-closed，也别在路由里再包一层 try/catch。
- 限流/审计来源 IP 必须走 `security/request-ip.ts`：默认使用 socket peer；只有 loopback 或 `TRUSTED_PROXY_IPS` 明确登记的反代才可提供 `X-Forwarded-For/X-Real-IP`，禁止直接信任请求头。
- 文件上传：通过 `validateMagicBytes()` 校验 MIME 类型
- Agent 工具下载公网图片必须走 `security/network.ts` 的 `fetchPublicImage()`：只准 public HTTPS，连接时 DNS 校验、每跳重定向复核、响应大小上限和图片魔数缺一不可；禁止对模型输入 URL 直接 `fetch()`。
- Agent 工具抓取网页（搜索结果正文提取等）同理走 `fetchPublicPage()`：http(s)、无凭证、拒 localhost 与非公网字面量，连接时 DNS 校验（防 rebinding 到 127.0.0.1 / 内网 / 云元数据）、手动跟随重定向且每跳复核、解码后流式截断。曾经的 `LocalFallbackExtractor` 直接 `fetch(url, { redirect: 'follow' })`，一个跳到内网的搜索结果就能把 API 主机上的本地服务读进对话。
- **要传 `dispatcher`（undici `Agent`/`ProxyAgent`）时，`fetch` 必须从同一个 `undici` 包导入**，不能用全局 `fetch`。Node 内置 fetch 自带钉死的 undici（`process.versions.undici`，Node 22 = 6.x），会用那份构建的 handler 接口校验 dispatcher，于是本仓依赖的 undici 8 dispatcher 一律被拒：`UND_ERR_INVALID_ARG: invalid onRequestStart method`，对外只表现为一句无信息量的 `TypeError: fetch failed`，且在联网前就失败。2026-07-27 生图全线挂掉就是这个原因（上游返回图片 URL，下载那步必挂）。单测若 mock `globalThis.fetch` 测不出来——要么 mock `undici` 的 `fetch`，要么 mock `fetchPublicImage` 这一层。

### Chat 的 Ambient Context 与 Client Actions
- `POST /api/chat` 的 user 消息可带 `client_turn_id`（8–64 位 `[A-Za-z0-9_-]`，仅会话模式）：同一会话已有该 id 的消息时不落库、不起 run，回 409 `{ error, code: 'duplicate_turn', message_id }`；写入走 `sessions.addUserTurn`（会话行锁 + `uq_messages_session_client_turn` 兜底，唯一冲突也映射成同一个 409）。不带 id 的行为不变。客户端靠它去重重发，别再按文本比对。
- `POST /api/chat` 可接收逐轮 `ambient_context`；它是浏览器当前页面的可选参考，不持久化到 Session，不代表用户意图，也不能授予 Profile、Tool、Platform、record 或 field 权限。
- `chat/ambient-context.ts` 是通用 envelope 的唯一校验/提示格式化入口：校验 `version/source/scope_id/label/route/hint`、限制长度并经 `sanitizeForPrompt()`；无效 Context 必须静默丢弃，让 Chat 正常继续。
- 固定提示必须明确 Context 可能无关或过期、不是用户请求/指令/授权；只有与当前用户消息自然相关时才使用，歧义时先询问。
- 浏览器 Client Actions 必须同时带 `client_action_scope_id`；有 Ambient Context 时两个 scope 必须一致，否则不装配 UI 工具。`local-tool-request` 回传同一 scope，由浏览器在当前页面实例中 fail closed。
- **请求体只有一份定义**：`@greenhouse/types/api` 的 `ChatRequestBody`（字段表 `CHAT_REQUEST_BODY_KEYS` 编译期穷举），路由和 web 共用。服务端不再读的字段必须从类型里删掉，让还在发的客户端编译失败——已移除的浏览器扩展曾在服务端改契约后继续发 `context_hint` / `omit_write_tools` 近两个月，页面上下文和浏览器工具全部静默消失。准入规则在 `chat/turn-environment.ts`（`admitTurnEnvironment`，`chat/turn-environment.test.ts` 钉住）；Envelope 各字段上限是共享的 `AMBIENT_CONTEXT_LIMITS`，客户端按它裁剪，本地只做同一份常量的兜底截断。结果回传路径是 `CLIENT_ACTION_RESULT_PATH`，`index.ts` 以 `CLIENT_ACTIONS_API_PREFIX` 挂载（`routes/__tests__/client-actions-route.test.ts` 钉住）。
- **浏览器扩展会话（`channel='browser'`，扩展已于 1.5 移除，存量会话仍在）的内联工具面 fail-closed**：`agent-runtime/tool-resolution.ts` 的 `filterBrowserSessionToolIds` 只放行 `surface.proxy:'read'` 的工具加 `ask_user` / `export_data`，业务写工具、`memory`、`feature_request`、起草类与会话编排类一律不在。理由是**输入不可信**：这些会话的历史里有网页选区/正文，web 续聊同样只读。**按服务端记录的会话 channel 判定，不接受客户端逐轮 flag**。与 `UNATTENDED_TOOL_DENYLIST`（没人能按确认）、`FEISHU_DENIED_TOOL_IDS`（交互形态承载不了）刻意分开。`POST /api/sessions` 忽略客户端传的 `channel`（一律服务端分配）；带 `channel` 的列表查询不做置顶回填（= 本人在该 channel 的会话）。
- **`routes/chat.ts` 不直接 import 工具目录（`tools/registry.ts`）**：目录会加载每个已启用的扩展，而 chat 路由测试 mock 的是 `agent-runtime/tool-resolution`、`@greenhouse/db` 只给了 `getDb`。私有 fork 带着自己的扩展跑上游测试时，直接 import 会让 `chat-*` 路由测试在模块加载阶段就失败（v1.3.1 的 fork 同步踩过：`registerExtensionServices` 不在 mock 里）。需要工具元数据的逻辑放进 `tool-resolution.ts`，路由只调函数。
- Client Actions 只处理当前浏览器的读取、导航、填充等 UI 动作；真实数据写入继续走既有服务端 mutation 工具、确认门与 Platform 权限链。

### Chat 上下文引擎（缓存前缀 + 滚动摘要）

v1 只接 DeepSeek 与 OpenAI 兼容服务，它们**自动**缓存 prompt 前缀，所以目标是前缀稳定，不加显式缓存断点。方案见 spec `20261023-v1-platform-hardening.md` D7。

- **系统 prompt 只放整段会话内稳定的东西**：profile prompt、用户 notes、记忆索引、工具引导、回复语言，最后是滚动摘要。`routes/chat.ts` 的 `buildSystemPromptWithUserNotes` 是唯一组装点；`chat-prompt-cache.test.ts` 钉住两轮不同页面上下文 / 图片下系统 prompt **逐字节相同**。往里加任何逐轮变化的内容都会让每轮缓存全失效。
- **逐轮内容走收尾块**（`chat/turn-context.ts`）：当前时间、Ambient Context、视觉模型的 Attached Images 说明、UI Actions 说明，拼在**最后一条 user 消息末尾**，只给模型、从不落库。放在末尾是承重的：下一轮这条消息不带收尾块，但共享前缀仍一直延伸到用户原文结尾。工具引导是否出现只看服务端工具，不看随页面变化的 Client Actions。
- **历史消息的渲染必须是转录的纯函数**：`injectTimeContext` 只用每条消息自己的 `created_at` 打时间戳（不再给最后一条打 `[Current Time]`，「现在」在收尾块里）；图片 ID 提示挂在每条带图的 user 消息上，而不是只挂最新一条。
- **Runtime trace 记录的是 provider 实际收到的输入**：`system_prompt` + `injectTimeContext(带收尾块的消息)`（与引擎内部同一函数、确定性）；trace input 另记 `digest`。
- **滚动摘要**（`chat/digest.ts`）：一轮成功落库后（`pumpChatTurn` 的 `onPersisted`），若 `digest_upto_seq` 之后的消息估算 token 超过 `resolveDigestTriggerTokens(model)`（= 历史预算的一半 = 上下文窗口的 25%，128k 模型即 32k），就把「最后两轮问答之前」的部分折进摘要：每趟最多 24k token、尽量停在 assistant 回复之后、不足 4k 不折（每次折叠都会让系统 prompt 失效一次缓存），一次最多 3 趟。走 `complete('team', { caller: 'digest' })`，记在触发这一轮的用户头上、同一套额度规则；任何失败只 `logger.warn`，绝不阻塞或拖慢这一轮。同进程同会话只跑一个折叠。
- **摘要格式**：Goals / Decisions / Facts / Open items / Artifacts 五个固定英文标题，条目用会话主要语言，上限 6000 字符，旧摘要一并折入。注入前 `sanitizeForPrompt`——它是模型写的、源自用户输入、每轮重放的文本，与记忆同一类持久注入通道。
- **`seq ≤ digest_upto_seq` 的消息不再进 prompt**，由系统 prompt 末尾的「Earlier in this conversation」段代替（只在折叠时变化）；原有的按预算丢最旧消息的窗口保留作兜底。
- **只前进、比较后写**：`db.sessions.advanceDigest` 锁会话行，要求 `digest_upto_seq` 仍是折叠开始时读到的值、新值严格更大、且最后一条被折叠的消息 id 与内容都没变；输了竞争直接放弃，不是错误。
- **改写即重置**：编辑 / 截断 / 原地改写 `seq ≤ digest_upto_seq` 的消息（`editUserMessageAndTruncate`、`deleteMessagesAfterSeq`、`updateMessageContent`、`replaceLatestAssistant`）在同一事务里清空摘要；下一轮回到纯窗口，轮后重新折叠。fork 只在复制范围覆盖已折叠部分时继承摘要。会话列表查询不带 `digest` 列。
- **找回细节**：`session_query` 的 `conversation_search`（默认当前会话）用 jieba 分词在消息正文里检索并返回 `seq` + 片段；摘要段在有该工具时提示模型去查而不是猜。消息表没有分词列（v1.4 不加迁移），所以是分词后的子串匹配（AND 优先、OR 补位、单字词不参与 OR），量大再加 `_tokens` 列 + GIN 索引。
- **飞书机器人同一口径**：主人发言时系统 prompt 带摘要、历史从 `digest_upto_seq` 之后开始，轮后折叠；别人在群里回复主人的链，既没有历史也没有摘要（摘要也是主人的历史）。

### 上传存储 (`storage/uploads.ts`)
- 聊天上传图片 / 生成图的统一存储层——**不要直接读写磁盘或 COS**，一律走 `putUpload(id, buffer, contentType)` / `getUpload(id)`。
- `putUpload/getUpload` 是统一安全边界：只接受服务端生成的平坦图片 ID，校验完整路径形态、大小与魔数；工具层不得自行拼接 `UPLOADS_DIR`。新对象使用 `timestamp + 完整 UUID`，读取端只为历史对象兼容旧 8-hex UUID 前缀。
- 后端自动选择：配了 `TENCENT_CLOUD_COS_*`（SecretId/Key/Bucket/Region）走腾讯云 COS，否则回退本地 `data/uploads`（仅单机/本地开发；多实例部署必须配 COS）。
- `getUpload` 在 COS 命中 404 时**回落本地磁盘**，兼容历史文件与仍写本地的路径。
- 子用户用 CAM 最小权限密钥（Put/Get/Delete，限定到 BUCKET/PREFIX）。没有 COS 直连自检脚本：`apps/api/package.json` 的 `cos:smoke` 指向的 `scripts/cos-smoke.mjs` 不存在，别引用它。
- key 前缀（`TENCENT_CLOUD_COS_PREFIX` / `_DRIVE_PREFIX`）走 `normalizeKeyPrefix()`：缺尾斜杠自动补，含非法字符（`=`、空白、`..` 段等）**启动即报错**。两个前缀都在**模块加载时**求值（`KEY_PREFIX` / `DRIVE_PREFIX` 常量），不要挪回 `getCosConfig()` 里——那样是懒求值，坏值只会在有人恰好打开一张图时炸成一个莫名的 500，而不是启动就报配置错误（2026-07-28 修正）。起因是 dev 的 `.env` 漏了换行、把下一行的 `TOKEN_SIGNING_KEY=<hex>` 粘进前缀值，聊天上传被写进 `uploads/TOKEN_SIGNING_KEY=<hex>/`、该值还进了启动日志，六周无人察觉（2026-07-28 修复）。生成图不受影响——它用硬编码的 `generate/` 前缀（见 `objectKey()`）。
- ⚠️ **改前缀会让既有对象全部失联**：引用只存 id，key 是 `前缀 + id` 现算的。上面那次修前缀就把 dev 的 62 个对象（含 11 张品牌配图，`brand/*` 文档内嵌的 `/api/upload/<id>`）留在了旧的畸形前缀下、全部 404，事后靠 `putObjectCopy` 逐个复制到 `uploads/<id>` 才修回。**清点引用别只查 `messages.content`**——还有 `messages.parts`（`images` / `pipeline`）、`kb_documents.content`/`content_json`、`sources.content`。
- 预签名下载（`presignGetUrl` → `/api/chat-files/:id/content`、`/api/drive/files/:id/content` 鉴权后 302 到 COS）**吃 CSP 的 `connect-src`**：前端 `downloadAuthenticatedFile()` 用 `fetch` 取字节，`fetch` 跟随重定向后**目标域要单独过 `connect-src`**，所以 `security/security.ts` 那条必须带 `https://*.myqcloud.com`。此前只有 `img-src`/`media-src`/`frame-src` 放行了它，于是图片预览一直正常、只有下载被 block（2026-07-30 修）。**本地 `pnpm dev` 复现不出来**——页面由 Vite 提供、根本不带 CSP 头，只有部署环境（api 直接 serve 打包产物）才有；回归护栏是 `security/headers.test.ts`。另一半前提在云上：COS 桶的 CORS 白名单必须含站点 origin（含端口）。
- `routes/upload.ts` 的 `GET /api/upload/:id` 是私有 bucket 的回源代理。浏览器 `<img>` 不能附加 Bearer header，因此该 GET 在中央 auth allowlist 中公开读取；对象 id 必须保持 `timestamp + 完整 UUID` 的不可枚举格式。`POST /api/upload` 仍要求内部账号，不得把公开读取扩展到上传、列表或删除。

### 云盘（`/api/drive` 的 kb 架 + `files_*` 工具，v1.5）

- 云盘页 `#/files` 就是知识库目录的文件面：drive scope `kb`，团队架（`visibility='team'`）+ 个人架（`private` + 本人）。没有新存储路径、没有新表。
- `PUT /api/drive/files/:id` 改名/移动：两端都鉴权，`sameDriveCabinet` 不许跨架；改名必须再过 `validateDriveUpload`（不然 `.txt` 能改成 `.html`）。`POST /files/init` 的 `folder_id` 也必须在同一个架里。
- `GET /api/drive/search?q=` 只搜知识库档案（团队 + 本人），每行再过一次 `resolveDriveAccess`。
- **drive 的写入记平台审计**（`drive/audit.ts`，`app_id='drive'`、entity `file|folder`）：drive 不是已注册的平台应用、不走 dispatch，路由和 `files_*` 工具各自在成功后记一行，操作记录据此显示「谁改了哪个文件」。审计写失败只 warn，不让已完成的写失败。

### 聊天附件（`/api/chat-files` + `read_attachment`）

- **一个上传口，任意文件类型**：`POST /api/chat-files/upload`（multipart，≤100MB/个、每用户 5GB 配额）写 `files` 行（`source='chat_upload'`；`db.chatFiles` 门面上仍叫 `source='user'`，工具产物是 `chat_output` / `'agent'`），下载走既有 `GET /api/chat-files/:id/content`（跟随会话读权限 + no-store + 预签名 302）。方案见 [附件与预设收敛 spec](../../../docs/specs/20260731-attachment-and-preset-convergence.md)。
- **图片是唯一的例外，公开读豁免绝不外扩**：`<img src>` 带不了 Bearer，所以图片继续走 `/api/upload` 的扁平不可枚举 id + `isPublicPath` 公开读；其余文件一律鉴权。这条边界由 `routes/__tests__/attachment-boundary.test.ts` 钉住——把 PDF/xlsx 放进公开读，等于给每份文件发一个永久免登录 URL。
- **写比读严**：会话被分享后接收方仍可读文件，但只有 owner 能往会话里传附件（上传路由校验 `session.user_id === user.id`）。
- **上传口挂在 `/upload` 而不是裸路径**：守卫是 `.use('/api/chat-files/*', requireInternal())`，而 Hono 的 `/*` **匹配不到裸路径本身**——挂在 `/` 上的写入口会绕过角色守卫，只剩全局 Bearer 兜底。
- **附件 fence 必须与正文分开 sanitize**（`chat/user-message.ts` 的 `sanitizeUserMessageForPrompt`，落库前唯一入口）。浏览器把 ```attachments fence 追加在用户正文**之后**，整串过一次 `sanitizeForPrompt()` 就会被它的 8000 字符截断吃掉——正文一长，fence 连同 file id 静默消失，模型拿不到附件、`read_attachment` 无从调用，且全程不报错。现在先 `splitAttachments()` 拆开：正文照旧截断（那道上限是真防线，不放宽），fence 解析后**按契约三字段重投影再序列化**（客户端塞的额外键、恶意文件名一律丢弃而不是就地清洗）。**别改 `sanitizeForPrompt` 本体**给它开「这段不截断」模式——它是全 API 所有 prompt 字符串的共同下限，为一个调用方开口子等于削弱其余全部。回归护栏 `__tests__/chat-user-message.test.ts`。
- **`read_attachment` 是懒的、会说不**：`is_global`、session-scoped（**会话边界就是鉴权**：file_id 由模型给出，跨会话的 id 必须查不到）。能读 text/CSV/JSON/xlsx/**.docx**/**有文字层的 PDF**，读不了图片/音视频/压缩包/>10MB——这时返回明确错误而不是猜，出口指回用户（见下「失败提示只指向真实存在的出口」）。附件因此是**能力**而不是**路由信号**：决定去哪执行的是「这个工具能不能干」，不是文件类型（spec D1）。
- **图片引用不是「不存在」，要么指路要么放行**（2026-08-13 修）：图片刻意没有 `files` 行（走公开读的 `/api/upload/:id`），于是任何只查会话文件的工具都把「会话里明摆着的那张图」答成 `No such attachment`——dev 上两个会话共 5 次。现在跨两个存储的解析只有一份实现 `files/conversation-files.ts`：先查会话的 `files` 行（`source` 为 `chat_upload` / `chat_output`），再按 `db.sessions.sessionReferencesImage()` 在**本会话转录**里认图（用户上传落 `messages.parts.images`、生成图落 assistant `parts.pipeline`），字节分别走 `getObjectAtKey(storage_key)` 与 `getUpload(id)`——**这两个函数的本地路径不同**（`data/uploads/<id>` vs drive key），别拿任一个通吃。会话边界仍是鉴权：id 由模型给出，跨会话的 id 必须解析不到。`email_mutation` 的 `attachment_ids` 因此同时收文件与图片，并接受 `/api/upload/<id>` 整串（`generate_image` 同时返回 `id` 与 `url`，模型两种都会传）；`read_attachment` 遇到本会话的图片改答「这是图片，用 `analyze_image`」。**不给图片补 `files` 行**：会话文件的 `storage_key` 有下载/删除等既有消费者，塞进一个它们读不了的 key 等于制造静默失效。
  - **`normalizeFileRef` 是「模型写的图片引用」的唯一归一入口**：`analyze_image` 也走它（2026-08-18 补）。此前它把 `/api/upload/<id>` 整串直接喂 `getUpload`，得到 `Invalid upload ID`——模型据此汇报「那张图不存在」，而那正是它上一步刚生成的海报。**新工具收图片引用时一律先过它**，别再判一次「像不像 URL」。
  - **`analyze_image` 也必须跨两个存储，归一化只解决了 URL 那一半**（2026-08-20 补）。「图片走 `/api/upload`」有个例外：v1.4 之前 composer 选了技能或 mission 时 `images` 被清空，**所有**选中文件（含图片）一律进会话文件（今天的 `files`，`source='chat_upload'`）（这些历史消息仍在），于是模型拿到的是个裸 UUID。它过不了 `isValidUploadId`，而 `getUpload` 对不合形状的 id 是**抛异常**，一路变成 `Failed to load image: Invalid upload ID`——对一个本会话真实拥有的文件说「无效」。现在顺序是 **先 `loadStoredImage`（`isValidUploadId` 守卫在前，绝不让非 upload id 碰到存储层）→ 未命中且有 sessionId 才 `resolveConversationFiles`**。**先查扁平存储这一步不能省**：本轮刚生成的图还没进转录，`sessionReferencesImage` 看不见它。解析出的**非图片**是独立结果（`not_an_image`）而不是 miss——两者要给相反的建议：miss 是「这个 id 谁都不认识」，非图片是「会话确实有这个文件，别再换 id 了」，错误里点名文件名与 content type 并指回 `read_attachment`（若它已拒过则叫模型照那条错误走，避免两个工具互相踢皮球）。起因是 dev 上一份扫描版 W-9：`read_attachment` 正确报「无文字层」，模型改用 `analyze_image` 传同一个 file_id，撞上这条死路。
- **字节→文本的单一实现是 `files/extract-text.ts`**（`read_attachment` 是它的薄壳）。它只产出诊断、不产出去向：`{ok:false, reason}` 有四种（`unsupported`/`encrypted`/`no_text_layer`/`extract_failed`），**「那该怎么办」由调用方按自己的面追加**——聊天附件与云盘（知识库目录）里的文件给用户的下一步不同，两句指引不一样，写进共享模块必然有一边是错的。**text 分支按 BOM 解码 UTF-16LE/BE（无 BOM 靠零字节占比嗅探），且输出永不含 NUL 字符**——一份 UTF-16 CSV 被按 UTF-8 读出的乱码曾以「成功」返回给模型，NUL 进了 `messages.pipeline` 后还会炸掉 friction 挖掘器的 `::jsonb` cast（2026-08-11 修）。
- ⚠️ **动态 `import()` 一个 CJS 包必须走 `default`，`vitest` 全绿不等于 Node 全绿**（2026-08-07 修）。`exceljs` 是 CJS，Node 真实 ESM 加载器静态探测不到它的具名导出，`Workbook` 只挂在 `default` 上；而 vitest 的 interop 会**合成**那个具名绑定。于是 `const { Workbook } = await import('exceljs')` 单测一路绿、线上每一个 .xlsx 附件都死在 `Workbook is not a constructor`——`read_attachment` 与 `crm_query.read_file` 两个面同时哑掉。现在统一走 `resolveWorkbookCtor()`（两种形状都认，都没有就显式抛错）。**这类 bug 只有真 Node 进程抓得到**：验证手段是 `node --input-type=module` 或 `tsx` 直接加载真实源文件，不是加一条单测。
- **失败提示只指向真实存在的出口**（根 AGENTS.md「能力声明必须真实」在错误文案上的同一条要求：**没有出口比假出口好**）。v1.4 删掉 Mission 沙箱后部署里没有比这里更能读文件的地方，所以 `fallbackHint(reason)` 一律把路指回用户：`no_text_layer`（扫描件）要一份**有文字层的文件**或把页面**当图片发**（`analyze_image` 与 vision 模型读得了图）；`encrypted` 要无密码副本；`unsupported`/`extract_failed` 与超大文件说明失败原因并请用户给能读的格式（如导出成 CSV）。起因是 dev friction 80：一份扫描版 W-9，模型照旧提示准备派 mission，接着又拿同一个 PDF id 去试 `analyze_image`（friction 56）。
- **服务端现在解析 PDF（`unpdf`），这推翻了 2026-08-02 的 spec D11**（见 [反转决策 D2](../../../docs/specs/20260804-crm-file-attach-and-pdf-reading.md)）。D11 自己写明的重开条件——「PDF 多到每份都进沙箱明显不划算」——在客户资料场景成立，用的也是它预写的首选库。**它当年的顾虑用显式失败分类回应，不是靠假装**：扫描件（无文字层）、加密、超时/损坏各有独立 reason 与错误句，绝不返回空字符串冒充读到了。**只提文字层，不渲染、不执行**：无 XFA、无嵌入 JS、不光栅化；pdf.js 6 已经彻底删掉 CVE-2024-4367 用的 eval 字体路径（构建里 `new Function` 为 0 处），所以恶意 PDF 的最坏结果就是一次失败解析或 10s 超时，两者都是普通返回值。**扫描件的视觉降级是 v2 方向，代码里刻意不留抽象**。

### 用户记忆与踩坑信号 (`plugins/memory/api/llm/memory.ts` + `plugins/feedback/api/frictions/` + `memory`/`log_friction` 工具)

两套刻意分开的东西，方案与决策（D1–D11）见 [spec](../../../docs/specs/20260804-memory-v2.md)：**记忆是 per-user 且会注入 prompt**，**friction 是团队级且永不注入**。

- **写入只有显式一条路**：`memory` 工具（remember/recall/update/forget）。v1 那个每日 03:00 抽取 cron 已删除——它把「记什么」交给事后批量 LLM，质量差且延迟一天。后台只剩养护：`upkeep-jobs.ts` 的周日 05:00 consolidation（合并重复/取代矛盾/降级过时，**从不新增记忆**）+ 每日 04:00 friction 挖掘。
- **召回是两层**：`resolveMemoryContext()` 是所有 prompt 组装点的唯一入口（chat 路由 / scheduler executor / 飞书机器人），注入的只有 `title` 一行 × 硬预算 2000 字符；正文由模型按需 `recall`。**不上 pgvector**（D3）——这个量级模型看索引推理比向量检索准，且零基建。**注入不算使用**：只有 recall/update 刷新 `last_used_at`，否则衰减状态机会永远认为每条都在被用。**不给跑在 `toolChoice:'none'` 上的调用注入**——给它一份写着「call memory(recall…)」的索引等于给一个按不动的按钮。
- **衰减是状态机不是分数**（D4）：90 天未用 → `dormant`（掉出索引、仍可搜、被 recall 自动转回 active），consolidation 取代的置 `superseded` 并留指针。**系统永不物理删**，唯一硬删是用户在设置页点删除。`confidence` 这个恒 0.8 的死字段已随 v1 一起删掉。
- **门控必须走 `userHasFeature`，不能用 `db.userFeatures.isEnabled`**。这是 v1 的死因：memory flag 现在 `defaultEnabled: true`，而 `isEnabled` 只查表——super 靠角色全开、团队靠默认值全开，两者表里都没有行，于是查表一律返回 false。功能上线至今 dev 零条记忆、设置页对 super 403，就是这么来的。回归护栏在 `routes/__tests__/memory-access.db.test.ts`。
- **注入前必须 `sanitizeForPrompt`，写入前必须过 `validateMemoryText`**：记忆是模型写的、用户可编辑的文本，且每轮对话开头重放——这是一条持久 prompt-injection 通道（v1 漏了 sanitize）。写侧的敏感信息正则是**拒收**（邮箱/手机/key/JWT/hex），不是靠 prompt 自觉。
- ⚠️ **日期不是电话号码，拒收前必须先把日期挖掉**（2026-08-13 修）。老的手机正则 `(?:\+?\d[\s-]?){7,}\d` 命中 `2026-08-11`——ISO 日期就是 8 位数字用分隔符连起来，与不带国家码的电话同形。而「这件事是哪天定的」是记忆最普通的内容，于是 dev 上一条纯工作决策被连拒 6 次（模型看不出是哪一段犯规，只能原样重试）。现在 `findSensitiveSpans()` 先算出日期跨度，任何与之重叠的匹配一律不算；电话另加 10–15 位数字的下限（`20260811` 这类紧凑日期与年份因此天然出局）。**校验与脱敏共用这一个函数**——`redactEvidence` 也据它按跨度替换，所以「拒收提到的那一段」与「证据里被打码的那一段」永远是同一段，且日期在 friction 证据里保持可读。
- **拒收要报出具体片段并指路**：错误里带 `"<犯规原文>"`（模型无法从 2000 字里猜是哪一段），联系方式类再追加一句「归业务记录：挂到对应的项目 / 知识文档 / Tables 记录下，记忆只留决策、用姓名指代」——信息本身值得留存，只是不该留在一段会被重放进每轮 prompt、没有归属也没有权限的文本里。密钥类不给这句：它哪儿都不该去。
- **限额常量保持静态，敏感信息规则共享安全叶子模块** `plugins/memory/api/llm/memory-limits.ts` 与 `plugins/feedback/api/frictions/friction-limits.ts`：工具描述在模块求值期插值这些常量，而 `tools/registry.ts` 导入全部工具模块——常量若依赖尚未完成初始化的 registry，一旦成环就是 TDZ，单测全绿但 API 起不来（automation 工具踩过一次）。
- **friction 双写单实现**：`frictions/friction-center.ts` 同时服务每日挖掘（扫 `messages.parts -> 'pipeline'`，纯 SQL + 归一化，**无 LLM 成本**）与 `log_friction` 工具（覆盖没报错但绕远路的软摩擦）。指纹 = `tool + kind + 归一化错误`，同一个坑只有一行、`occurrence_count` 就是复盘优先级。**计数刻意不精确**（D8）：25h 窗口有重叠，重启会重复计数——它是排序信号不是账本。证据是**脱敏不是拒收**（与记忆相反：friction 样本的诊断价值就在原文）。
- **`memory` 刻意没有 `surface`**：它读写混装、套不进 proxy 的 read/write 二分（标 read 就等于让无状态调用方绕过确认门写记忆），所以 chat / 定时任务拿得到，`/api/agent` 与 `/api/mcp` 拿不到。**`log_friction` 自 v1.5 起是写工具**（`proxy:'write'`、MCP 组 `feedback`）：成员的 Agent 也能报踩坑，MCP 上每次都是一条记名的 agent_write（成员 + 客户端），行本身仍是团队级、仍没有读动作。
- **friction 复盘的出口在 harness 层**：`Administration → Issues & requests → Frictions`（super only，`/api/admin/frictions`；v1.5 与功能需求合并成一页两个 tab，旧地址重定向）只是队列，修复动作是改工具 description、改实现补报错、改 prompt、沉淀 skill 或改代码。**刻意不做**「把踩坑经验自动注入所有人的 prompt」的共享记忆——那会让一条写坏的经验污染全员，而复盘一次就能修在真正的位置上。重复 ≥3 次的操作型摩擦优先考虑升格成 SkillHub 技能。
- **错误文案里插值的动态值一律加引号**（2026-08-07 定）。`normalizeErrorText` 把 `"..."` 与裸数字归一成占位符，靠这个把同一个坑聚到一行；不带引号的值逃逸归一化，于是 9 个重复联系人报错生成了 9 条 friction，一个问题被排成九个偶发噪声。写 `(ID: "${id}", Name: "${name}")`，不要写 `(ID: ${id}, Name: ${name})`。
- **错误文案应当指路，不只是判定**。同一批 dev 数据里，凡是错误句写清了下一步（「传 update_if_exists」「改用 search 找 id」「若是联系人 id 就带 type」）的，模型下一轮就自愈；只说「not found」的，模型倾向再猜一个 id。工具的错误分支是 prompt 的一部分，按 prompt 的标准写。
- **检索工具的「库是空的」必须与「这个词没命中」分开说**（2026-08-20 补）。`found: 0` 把两者压成同一个信号，而它们的下一步相反：没命中该换关键词，空库换到天亮也没用。检索工具因此要在 miss 分支（且**只在** miss 分支，命中时不为此付一次 `count()`）查一次总量，为 0 就返回 error 并明说这个面是空的、别再调。起因是某个语料库在 dev 一行都没有，模型换着词重试——5 天 28 次，单轮最多 8 次。**这也是「未配置一律显式报错」在检索面的形态**：空库不是一次检索结果，是这台部署上根本没有这项能力。顺带把一个只会被 `mineEmptySearches` 归档、且 `archived` 永不自动重开的内容缺口，转成看得见的 `tool_error` friction 行。

### Automation / 定时任务 (`scheduler/` + `/api/tasks` + `automation_*` 工具)

- 用户面叫 **Automation**，定义事实是 `automations` 表（服务名仍是 `db.scheduledTasks`；3.0 起送达设置合成一个 `notify` jsonb `{webhook, email, wecom, feishu}`，API / 工具优先收 `notify` 对象，HTTP 仍接受 1.x 的平铺 `notify_*` 字段，`notify` 优先；`unattended_tools` 是字符串数组），但每次 cron/manual occurrence 必须先持久化为 `kind='automation'` Runtime Run，再由通用 worker claim/lease/heartbeat 后调用 `executor.ts`（每次执行建 `channel='task'` 会话，复用 `runAgentInSession`）。`TaskScheduler` 的 croner 只负责产生触发，不再 fire-and-forget，也不以进程内 Set 当互斥事实。注意仓库里 "automation" 有两义，别混：这个（定时任务）和 Tables 的 `table_automation_rules`（记录事件触发的确定性规则）。
- **单一实现在 `scheduler/task-center.ts`**：cron/时区校验、每人 10 条配额、最小间隔 15 分钟（v1.4 起，`task-limits.MIN_INTERVAL_MINUTES`；Web 的 cron 输入框只做提示，事实校验在这里）、prompt 10–4000 字符、`max_steps` ≤20、hidden profile 门、`sanitizeForPrompt`、以及 scheduler 联动（`reloadTask`/`removeJob`/`runTaskManually`）全在这里，返回 `{ok,code,error}` 判别联合而非 throw。`routes/tasks.ts` 与 `tools/automation-{query,mutation}.ts` 都只是薄壳——**别在任一侧复制校验**，两份必然漂移。执行 admission/driver 则只有 `scheduler/runtime-driver.ts` 一份：保存完整 task/profile/prompt/time snapshot、确定性 session、Runtime Step。
- **执行历史读路径 = `listTaskRuns`（`GET /api/tasks/:id/runs`）**：以 `channel='task'` 会话为脊（Runtime 化之前的存量历史与入队失败记录都有会话）、按 `session_id` 连上 Runtime run 投影 status/error/时长/trigger；`run:null` 表示「Runtime 时代之前的历史运行」。DB 侧走 `db.runtime.listRunsForSource`（命中 `uq_runs_source` 前缀索引）。Web 的 Automations 行 History 弹框与执行中心详情消费它；`GET /api/tasks/:id` 的 `recent_runs` 继续服务 `automation_query.get`。见 [spec](../../../docs/specs/20260814-automation-run-history-and-failure-visibility.md)。
- **入队失败必须浮出，不许只留 stderr**（2026-08-14 修）：`runTask` 的 catch 走 `surfaceEnqueueFailure`——建失败会话（`⚠️ 任务执行失败` 幂等消息）+ `updateRunStatus('failed')` + `notifyTaskResult` 三通道送达。此前 profile 被删的任务每晚失败两天无人知晓：错误只进 error.log、任务行冻在最后一次真实运行、boot catch-up 的补跑失败也只是静默推进游标。
- **无人值守工具基线 = `scheduledToolBase(effectiveTools)`，不再与 YAML `tools:` 二次相交**（2026-08-14 修）：系统 profile 的 YAML 工具列表在任何运行时都不读取（chat、fork 同口径），automation 曾是唯一的例外——sprouty 系任务被饿到 3 个只读工具，custom 任务还被剥掉 `resolveEffectiveTools` 特意并入的 builtins。收窄语义不变：custom 的「profile 只能收窄」由 `resolveEffectiveTools` 承担，`filterUnattendedToolIds` 的 fail-closed 白名单（仅 replay-safe 读工具）原样压顶。
- **联网搜索自动放行**（2026-10）：`external_search` 声明 `unattendedReplaySafe`，不在勾选目录里——它不写任何东西，花费由 `max_steps` 与预算拒绝兜住。
- **额外工具由 owner 逐任务勾选（`automations.unattended_tools`，2026-08-24）**，方案与决策 D1–D12 见 [spec](../../../docs/specs/20260824-automation-optin-tools.md)。这不是把无人值守放开，是把「拒绝的三种理由」拆开：确认门依赖真人读卡（`email_mutation`）与自我增殖（`automation_mutation`）**一次性同意替代不了**，而「花钱」（生图/识图/联网搜索）与「可逆内部写」（Tables/知识库/项目/v1.7 起的 `report_render`：只新增文件，默认存 owner 个人架，写团队文件夹要 owner 本人有写权限）替代得了。定时周报的读半边 `report_templates` 是 replay-safe 读，自动放行、不进目录。
  - **勾选永不放大权限**：运行时集合 = `勾选 ∩ 目录 ∩ effectiveTools`，而 `effectiveTools` 在每次执行前由 `resolveEffectiveTools` 重算。flag 关掉、角色降级、工具授予（`user_grants` 的 tool 行）收回，下次运行自动少一个工具，没人需要回去改勾选。
  - **`filterUnattendedToolIds(ids, optIn?)` 的第二个参数必须是显式入参**：只有 scheduler executor 背后站着「配置那一次点了复选框的人」，写成默认值或塞进共享 context 就会静默漏进任何别的调用方。两段是并集，自动放行那段一个字符都不许动。
  - **`unattended_tools` 只能由 owner 写**：HTTP 控制台（`TaskActor.canGrantTools` 路由传 true），或真人在 Web / 手机聊天里（`channel='web'` 会话）调用 `automation_mutation`——`routes/chat.ts` 传 `humanChat`，`buildLazyServerTools` 据此给 `canGrantTools`。MCP、`/api/agent`、飞书/企微机器人、automation 运行（以及续聊的 task/browser 会话）一律拒绝。schema 只收目录里的 id；每次 create/update 的结果都带 `unattended_tools` 与 `run_tools`（`executor.resolveScheduledRunToolIds`，与真实运行同一套解析），模型只能承诺 `run_tools` 里有的工具。
  - **目录住 `@greenhouse/types/automation-tools`，不住 `defineTool` 的 `meta.surface`**：`tools/registry.ts → tools/automation-mutation.ts → scheduler/task-center.ts` 是既有 import 链，task-center 反向 import registry 就成环 = 那个「单测全绿、API 起不来」的 TDZ 陷阱。代价由 `__tests__/automation-opt-in-catalog.test.ts` 补：目录里每个 id 必须真实存在，且与自动放行集 / denylist / dispatch 集互不相交。
  - **写入必须进送达摘要**（`notifyTaskResult` 读 `db.runtime.listToolCalls(runId)` 取 `risk_level !== 'r0'`）。这是放弃逐次确认的对价：用户至少要在几分钟内知道写了什么。数据源用 Runtime ToolCall 证据而不是重解析 `messages.pipeline`——前者写在真实 execute 边界。查询失败只 warn、不加这一节，**绝不把一次成功的 run 变成失败**。payload 存结构化 `writes[]` 与原文 `summary`，渲染在 `formatWriteReceipt`（改样式不该变成数据迁移）。
- **触发幂等与恢复**：计划 occurrence 的身份只由 `taskId + scheduledFor` 决定，cron 与 boot catch-up 的投递路径不得进入 source id/input（否则一次崩溃会把同一时点重跑两次）；manual occurrence 使用独立 UUID。每个任务同时只允许一个 active Runtime Run，DB advisory lock 是事实源。启动时 `next_run_at` 已过期只补 24h 内最新一次，更早只标 `missed` 并推进游标。Automation `max_attempts=1`：agent 整轮可能已产生副作用，绝不自动重放。进程在 `running` 中途死掉（lease 过期）时，worker 以 `outcomeUnknownKinds:['automation']` 调 reaper，Run 收为 **`interrupted` / `runtime_outcome_unknown`**（不是 failed）；domain projector 把仍 `running` 的 ToolCall 收为 `uncertain`、Step 收为 interrupted、会话写「运行中断，结果未知」、`last_status='interrupted'`，并发**一条** `runtime_failed` 通知（dedupe 按 run+status），正文把 `uncertain` 的写入单列为「中断时正在进行的写入」。interrupted 是终态：不可 claim，同一 occurrence 的 boot catch-up 命中原 Run，执行中心也不开放 retry。`tests/api/automation-runtime-driver.db.test.ts` 钉住这条。执行中心只开放 Cancel（不开放 pause/retry）：queued 在命令 fence 后立即同步 Run/Step/session/task 终态，claimed/running 只持久 `desired_state=cancel`，由 driver heartbeat/poll abort 当前 LLM 后收口。
- **scope 决定谁能跨用户**：`TaskActor.scope`——HTTP 控制台传 `'any'`（super 可见/可管全部任务，任务 prompt 含敏感上下文，这是刻意的管理面），agent 工具构造时钉死 `'own'`，所以模型即使属于 super 也只能碰自己的。
- **hidden profile 在 create 和 update 两处都要拦**：只拦 create 的话，成员可以先用允许的 profile 建任务再切过去（`checkProfileAccess` 因此被两条路径共用）。
- **无人值守上下文禁用 `automation_mutation` 与 `email_mutation`**：`UNATTENDED_TOOL_DENYLIST`（`agent-runtime/tool-resolution.ts`）被定时执行和 headless 子会话共同消费。理由与草稿类工具（`tables_schema_plan` / `task_capture`）同款——没人能按确认；automation 还会自我增殖，email 的两阶段草稿确认在无人值守时也没有真实读者。custom profile 可以自己写 tools 数组，所以这不是理论风险。只读的 `automation_query`/`email_query` 不禁。**这条 denylist 压在 opt-in 之上**：上面那个逐任务勾选无论存了什么都够不到这两个（`skill_mutation` 与 dispatch 类同理，靠不进目录挡住）。
- 工具是 **lazy 但不 session-scoped**：任务归属是用户不是会话，stateless 的 proxy/MCP 面也必须够得着（对照 `skill_mutation`）。写工具在 `MUTATING_PROXY_ALLOWLIST`，每次调用需 `confirm:true`。
- **没有新内容时不通知（`automations.quiet_when_empty`，v1.4）**：开启后 `buildTaskPrompt` 在任务 prompt 末尾追加「没有新内容就只回 `NO_UPDATE`」；driver 用 `isNoUpdateAnswer`（trim 后严格等于 `NO_UPDATE`、任务开启了该项、且本次运行**至少调用过一次工具**——零工具调用的 `NO_UPDATE` 说明它什么都没查，按普通回答存储并送达）判定，Run 照常 `succeeded`、计入 run_count，output 写 `summary=NO_UPDATE_SUMMARY` + `no_update:true`；domain projector 见 `no_update` 就跳过 `notifyTaskResult`——站内、webhook、邮件、企微、飞书一律不发。历史（`listTaskRuns`）投影 `run.no_update`，Web 显示「无更新」。关闭时 `NO_UPDATE` 只是一条普通回答。HTTP、`automation_mutation` 都能写这一项（它不放大权限，只少发通知）。
- **结果送达 = per-task 企微 webhook（2026-08-04 补齐）**：`automations.notify.webhook` + `scheduler/notify.ts`，跑完（成功或失败）由 **scheduler** 推一条 markdown 摘要。**这是系统行为，刻意不是 Agent 工具**——给模型一把「POST 到这个 URL」的工具等于开一条它可以任意瞄准的外呼通道；模型只产内容，去哪由系统决定。URL 在写入时被钉死为两家群机器人端点——`https://qyapi.weixin.qq.com` 或 `https://open.feishu.cn/open-apis/bot/...`（`task-center.validateNotifyWebhook`），其余 host 一律 400；发送侧按 host 分派 payload 格式（`notifications/transports.notificationWebhookTransport`，住叶子模块是因为 notify → task-center → scheduler/index → notify 成环）。送达失败只 `logger.warn`，绝不把一次成功的 run 变成失败。**仍缺**：WS `task:run` 推送与站内未读（通用收件箱是平台级基建，另行立项）。

### Wecom plugin

Implementation and domain rules live in [plugins/wecom/AGENTS.md](../../../plugins/wecom/AGENTS.md).
The host consumes communication registries; it must not import this plugin.

### Feishu plugin

Implementation and domain rules live in [plugins/feishu/AGENTS.md](../../../plugins/feishu/AGENTS.md).
The host consumes communication registries; it must not import this plugin.

### Tasks（`prompts` 表 + `/api/prompts` + `task_capture`）

用户面叫 **Tasks**，底层是 `prompts` 表（service 仍是 `db.userPrompts`）与 `/api/prompts` 路径——一个没有变量、没有工具的任务与原来的快捷指令逐字段相同，改路径只会让所有既有客户端一起返工。方案与决策（D1–D7）见 [spec](../../../docs/specs/20260808-tasks-from-sessions.md)。

- **`task_capture` 只起草，不写库**（与 `tables_schema_plan` 同形，也一并进 `DISPATCH_TOOL_IDS`）。真正落库的是卡片上用户按的 Create → `POST /api/prompts`，用**用户自己的 Bearer**，模型的工具表里没有它。这道门是功能本身而不是仪式：用户要固化的是「刚才这套确实跑通了的流程」，模型自作主张存下的就是一套没人核对过、却会被 `/` 调用几个月的流程。
- **聊天卡片固化是 exactly-once，旧 API 保持兼容**：卡片随 POST 成对传 `artifact_action_id + artifact_session_id`，服务端先在 `card_action_receipts` 原子 claim，再创建 Task；`prompts.artifact_action_id` 唯一键补偿「业务行已写、回执未写」窗口，刷新与重复请求返回同一 Task。两字段只传一个是 400；旧的 capture 调用两者都不传仍按原语义创建，不强迫非聊天客户端伪造 message id。
- **`expected_tools` 由服务端从会话真实调用记录派生，不收模型自报**（`toolsUsedIn` 扫 `messages.parts.pipeline`）。它回答的是「这个任务够得着什么」，不是「这个用户能跑什么」——**不做权限判定**，运行时仍由既有 per-user 工具解析层管辖。加第二道闸只会在「作者有、运行者没有」时误伤，而那种情况下模型本就会如实报告缺工具。
- **变量必须与正文里的 `{{占位符}}` 对得上**（`validateVariables`，create 与 update 两处）。声明了却没有占位符的变量会渲染出一个「填了也不影响任何东西」的输入框，而用户从界面上看不出来，所以是 400 拒绝而不是静默丢弃。update 时按**本次请求要保存的正文**校验（没传 content 才回落到库里那份），否则「同时重命名占位符和变量」这个最自然的编辑永远过不了。
- **未填的占位符原样进消息**，不补空字符串：空白会静默改变任务的语义，而一个可见的 `{{region}}` 是 `RICH_OUTPUT_GUIDE` 明确要求模型先用 `ask_user` 问清楚的东西。
- 变量填写的主路径是 composer 里的内联表单（确定性、不耗模型轮次），`ask_user` 只兜底旁路进入的情况（spec D3）。

### Email plugin

Implementation and domain rules live in [plugins/email/AGENTS.md](../../../plugins/email/AGENTS.md).
The host consumes communication registries; it must not import this plugin.

### 定时任务的邮件送达（`notify_email`）

`scheduler/notify.ts` 从单通道变双通道，两条都保持「**送达是系统行为，不是 Agent 工具**」（leads-pool D10）：

- `notify_webhook` → 企微或飞书群机器人，URL 写入时被钉死为 `qyapi.weixin.qq.com` / `open.feishu.cn/open-apis/bot/...` 两家；
- `notify_email` → **布尔，不是地址**。收件人由 task owner 反查得到，所以这条通道**根本没有可供任何人瞄准的参数**——这正是它能免确认的原因。发件走共享邮箱的 `sendFromSharedMailbox()`，绕过 resolveMailbox 的 super-only 门（那道门是给模型面的，这条路径上没有模型）。
- 共享邮箱未配置 / owner 无邮箱 → 只 `logger.warn` 并跳过，**绝不把一次成功的 run 变成失败**。

**送达正文必须经 `notifications/render.ts`，不能直接转发 `summary`**（2026-08-17 起，方案与决策 D1–D10 见 [spec](../../../docs/specs/20260817-notification-delivery-rendering.md)）。`summary` 是 assistant 的终答，写给**聊天渲染器**：Markdown + `RICH_OUTPUT_GUIDE` 主动要求产出的富块围栏。懂那些围栏的渲染器只活在浏览器里，邮件里没有浏览器。

- **两步单向管线**：`flattenRichOutput()`（围栏 → 普通 Markdown，复用浏览器同一份 `parseSegments`）→ `renderNotificationEmail()`（Markdown → HTML 文档）。**HTML 由文本那份产出**，所以 multipart 的两部分无从漂移。三个通道（邮件 / 企微 / 站内）都用第一步的输出。
- **截断在扁平化之后**：卡片与收件箱行仍 600 字符，邮件 20000。此前 600 的卡片上限直接作用在原文上，一个 datatable 围栏常被拦腰砍断。
- **`marked` 原样透传 raw HTML**，而 summary 是模型写的——`renderer.html` 那一处 escape 是承重的，旧实现的「整段 escape」顺带在做这件事。`href`/`src` 同理只放行 `http(s)`/`mailto`，站内相对路径按 `PUBLIC_BASE_URL` 补全，`#/chat/...` 这类退化成纯文本（点不动的链接比没有链接更糟）。
- ⚠️ **`marked` 的渲染器覆写必须写成普通对象**：`Marked.use()` 用 `Object.keys` 收方法，只看得见自有属性，`Renderer` 子类的原型方法**全部静默失效**（实现时踩到，三条覆写一条都没生效）。
- payload 里的 `summary` 仍存**原文**：payload 是事实，渲染是表现，存渲染结果等于把改样式变成数据迁移。

### 手机推送（`notifications/push/` + `/api/auth/me/push-devices`）

- **每条站内通知都可以推到手机**：生产者写完 `db.notifications.createWithStatus()` 后**必须**调 `queueMobilePush(db, notification)`（`push/queue.ts`；Runtime projector 与 `scheduler/notify.ts` 已接）。新增通知生产者漏调 = 它的事实永远到不了手机。重放也要调：投递行按「事实 × 手机」唯一，崩溃后重试会自愈。
- 类别由 kind 决定（`pushCategoryOf`，`@greenhouse/types/push`）：`runtime_attention` / `budget_attention` → `needs_you`（审批类 time-sensitive），`runtime_completed` / `runtime_failed` → `done`，其余（含以后新增的 kind）→ `other`。每台手机按类别有开关，只能收窄。
- **默认不带内容**：标题是产品名，正文只说「哪类事」；手机打开「显示预览」才显示通知 title，通知 body（自动化摘要、报错）永远不出服务器。`data` 只有 id（`PushData`：`s` 站点 ref、`u` 账号、`k` 类别、`nid`、`url=/notification?id=`），App 原样 vendor 这份契约。
- worker 在同一张 `notification_deliveries` 队列里认领 `mobile_push`（只在 `MOBILE_PUSH_ENABLED` 开时认领），**发送前复核**（已读、设备停用/换号/改密/90 天未见、类别关掉、超 24h、审批已处理）→ `suppressed`；`DeviceNotRegistered` → 停用设备 + `failed`；网络 / 429 / 5xx → 退避重试；请求被拒 / `MessageTooBig` → dead letter（error 日志）。
- 设备路由只给内部账号、只看自己的设备，token 只进不出。`POST /:id/test` 直发一条测试推送（每台 10 秒一次）。
- `/api/bootstrap` 的 `mobile_api` 是 App 依赖的接口级别（`MOBILE_API_LEVEL`，现为 3：项目、表格、我的 Agent、助手对话）：App 开始调用一个新接口时同步加一，旧服务器会被 App 提示升级。

### SkillHub plugin

Implementation and domain rules live in [plugins/skills/AGENTS.md](../../../plugins/skills/AGENTS.md).
Saved prompts and task_capture stay core. Skill tools, storage, scanning, pack sync and skill MCP prompts belong to the plugin.

### 报告模板与渲染（`reports/` + `/api/report-templates` + `report_*` 工具，v1.7）

- 模板 = 团队要求的报告 / 演示格式：有序章节（key、标题、撰写说明、必填、内容类型 markdown/bullets/table/figures）+ 封面字段（title/subtitle/author/date/period，可设必填）+ 允许的格式（report：pdf/docx；presentation：pptx/pdf，第一个是默认）。定义的校验只有一份 `checkReportTemplateDefinition`（`@greenhouse/types/reports`，网页编辑器与服务端共用限值）。表 `report_templates`（迁移 0013）。
- 权限照技能中心发布口径，唯一实现在 `reports/templates.ts`：任何内部成员可发布团队模板或存个人草稿；团队模板作者或 super 可改删；草稿只有作者看得见（super 也看不见）；内置模板 `owner_user_id=NULL`，只有 super 能改，且不能改成草稿；**只有作者本人能把团队模板改成草稿**（super 改别人的会被 403 拦在写入前——否则改完连 super 自己也看不见，表现为先成功再 404）。删除是软删。
- 内置两套（周报 / 项目汇报）只在**从未有过模板**时由 `seedDefaultReportTemplates` 写入（advisory 锁 + 计数含已删行），删掉的不会在下次启动回来。
- 内容契约 `reports/content.ts` 的 `checkReportContent`：必填章节必须在且非空、未知章节 key 与未知封面字段拒绝、按内容类型校形状与大小，**一次列出全部问题**（path + problem + 一句改法）。`report_render` 被拒时把问题逐条写进 `error` 文本——MCP 上被拒的写入只把这一句字符串交给 Agent，结构化 `issues` 只在 Chat / Agent API 可见。`report_templates.validate` 是不落盘、不留痕的预检。
- 渲染纯 JS、不起浏览器：PDF 用 pdfmake（报告 A4、演示 16:9 每页一张）、Word 用 `docx`、PPT 用 `pptxgenjs`；演示的切页（`reports/slides.ts`）PPT 与 PDF 共用，**按渲染高度测量而不是数行数**：用内嵌字体的真实字宽与行高（`font.ts` 读 hhea/hmtx）在 `DECK` 的尺寸下折行，表格按列宽 × 折行行数算行高、表头每页重复，单行高过一页的行再切成几段；PDF 是两者里更紧的版式（PPT 正文框更宽、行距更小），所以计划按 PDF 量，`render.test.ts` 把 PDF 页数钉在计划上。Markdown 经 marked lexer 转成共享块模型，只保留 http(s)/mailto 链接，图片只留 alt 文字。**pdfmake 的网络与本地文件读取都按策略关死**（字体走它的内存文件系统、logo 直接给字节）——内容永远不会被当成资源去取。
- 中文：PDF 内嵌 Noto Sans SC（OFL）子集 `plugins/reports/assets/fonts/`（GB2312 + 拉丁 + 常用符号，两档字重各 ~2.4 MB，`scripts/build-report-fonts.sh` 重建），pdfkit 每份文档再子集化，PDF 通常几十 KB；子集外的字（emoji、生僻字）显示为空白，结果里给 `warnings` 点名。Word/PPT 不嵌字体，写 `Microsoft YaHei`，缺字体时由查看器替换。
- 品牌取 Branding Studio：产品名、logo、`theme_tokens.brand`（缺省 V1 绿 `#2E8B3D`）。logo 能嵌就嵌：PDF 收 PNG/JPEG/SVG，Word 与 PPT 只收 PNG/JPEG（pptxgenjs 在服务端生成不了 SVG 预览图），嵌不了就换成产品名并给警告。
- 存档：默认存成员个人架，可指定团队架或有写权限的文件夹，经 `uploadCabinetFile`（drive 审计照记、5 MB 上限）；返回 `file_id`、Files 深链与 5 分钟下载链接。本地渲染，**不计价**。Chat 同一实现（`buildLazyServerTools` 构造，非会话绑定）。
- 模板的建 / 改 / 删记平台审计（`reports/audit.ts`，成功后记、失败只 warn）：自己的模板记成本人改动（`app_id='reports'`，`createReportTemplate` 等，SkillHub 模块）；super 改删别人的或内置模板记成管理员改动（`app_id='platform'`，`updateMemberReportTemplate` / `deleteMemberReportTemplate`，detail 写「owned by …」或 built-in）。summary 只存名称、可见范围和作者，不存章节。已删模板按审计里的名字命名：团队模板谁都可以，草稿只有作者本人——super 也看不到草稿名，与读权限一致。
- 网页：SkillHub › 报告模板（`#/skillhub?tab=reports`），预览 = `POST /api/report-templates/preview` 用示例内容渲染 PDF（已保存的按 id，编辑中的按表单定义），不保存。

### Agent 输出兜底
- **工具参数 JSON 兜底（`experimental_repairToolCall`）**：模型在长参数上会写坏 JSON（未转义的引号、正文里的真换行、尾逗号、被截断），SDK 解析失败就把整次调用丢掉。2026-08-06 dev 上一次真实事故：三次连续的长参数草稿调用（长中文 brief，工具已于 v1.4 删除）全挂在 `Expected ',' or '}' after property value`，模型随即放弃编排改回手工做——**用户点名要的功能就这么没了**。现在 `chat-engine` 挂 `createToolCallRepair()`，调 `agent-core/repair-tool-json.ts` 的**本地确定性**修复（不再问一次模型：故障是机械的，多一轮往返既慢又可能再失败，且确定性修复才测得住）。**工具名错不修**（猜是哪个工具是更坏的赌），修复会 `logger.warn` 留痕——频繁触发说明某个工具 schema 太大或描述太糊，那该进 friction 队列而不是被静默吸收。
  - **修复器是两趟，loose 先跑、strict 兜底，且 strict 的产物必须解析得了才采用**（2026-08-18 加）。引号规则「`"` 后面跟 `,` 即字符串结束」在值里含未转义引号、其后正好是 `", ` 时会在句子中间收尾，逗号后那截散文于是落在「必须是 key」的位置——**报错 `Expected double-quoted property name` 是修复器造出来的，不是模型写的**（dev friction 59：一次 4 条的 `tables_mutation` 批量因此连挂两次，用户改成逐条发）。strict pass 要求逗号后**真的开始一个 JSON 值**（`"`/`{`/`[`/`-`/数字/`true`/`false`/`null`）才收尾。这个顺序是承重的：它只能把 `null`（整次调用被丢弃）变成一次救回的调用，**不可能**把本来修得好的变成修不好。
  - ⚠️ **排查时注意 pm2 日志按轮转时刻命名**：`error__2026-08-15_00-00-00.log` 装的是 **08-14** 的记录。friction 59 曾被判为「没有原始 payload 无法定位」，而那两条点名 `tables_mutation` 的 warn 当时就在盘上，只是找错了文件。
- **终答兜底（final-answer guarantee，DeepSeek 专属、可一处移除）**：RAG 查询里模型偶尔会反复调工具直到耗尽 `max_steps` 却一句答案都不吐（或在被强制 `toolChoice:'none'` 的最后一步漏出 DSML 工具调用），导致流式 `delta.content` 与非流式 `message.content` 全空。**这是 DeepSeek 的 DSML 泄漏 bug 引发的，别的模型没有**，所以整套补丁集中在内核、对外只留一行接缝：
  - host 侧**唯一改动**＝把 `for await (… of streamResult.fullStream)` 换成 `for await (… of withFinalAnswerGuarantee(streamResult, { profile, systemPrompt, baseMessages }))`（`@greenhouse/agent-core`）。`finish` 重排、补答、collectors 累计都在 wrapper 内完成，host 的 switch / 落库逻辑零改动。
  - wrapper 内部按 `resolvesToDeepSeek` 门控（非 DeepSeek 直接透传），「跑了工具但无文字」时补一轮**无工具**生成：把已抓到的工具结果**拍平成纯文本摘要**喂回去（不重放结构化 tool-call 历史，否则又诱导模型继续调工具/漏 DSML），失败重试至多 3 次；补答以普通 `text-delta` 形式插在 `finish` 之前。
  - 每次补答都是独立 provider 调用：wrapper 把每个尝试的 `totalUsage` 累加到主流结果，host 最终通过 `buildEngineResult` 统一结算；Chat 的预算预留也必须包含最多 3 次补答及 SDK retry，不能只按主循环估算。
  - 配套：DSML 拦截器在 `toolChoice:'none'` 的步骤**只剥离不回收** DSML（回收会把 finishReason 改写成 tool-calls，反而搞砸"最后一步必须出文字"这个保险）。
  - **移除**（DeepSeek 修了 DSML 解析后）：删 `dsml-interceptor.ts` + chat-engine 的 final-answer 段，把各 host 那行 `withFinalAnswerGuarantee(...)` 改回 `streamResult.fullStream` 即可，无其他连带。

### 模型目录（`config/models.yaml`）
- **模型目录是配置不是数据**：`apps/api/src/config/models.yaml` 声明模型与有序 provider 链，密钥只写 env 变量名；`config/models.ts` 在 `main()` 里解析并注入 agent-core 的 registry，**所有 Agent 运行面共用同一份**。曾经的 `llm_upstreams`/`llm_gateway_models` 两张表与库内 AES 加密的厂商 key 已删除（migration 0036）——改模型请改配置文件后重新部署。目录的消费段是 `chat:`（`selectable`，给聊天选择器；v1.4 删除 LLM 中转后，旧配置里的 `relay:` 段被忽略）；**采样参数也归目录**（每个模型的 `options`，由 `resolveModelConfig()` 与 profile 显式值合并，profile 优先），profile YAML 不再写 `options`。
- **模型是每轮的选择**（2026-08-01，推翻 presets-unification 的「一个 Agent = 一个模型」）：`POST /api/chat` 的可选 `model` 经 `isChatModelAllowed()` 按 `chat.selectable` + 可达 provider 校验后作 `modelOverride` 下发，并落库进 `messages.model`；**不在其中的值不报错，回落 Agent 默认模型**（2026-09 起，原为 400）——典型发送方是浏览器 localStorage 里记着一个已下线/已撤 key 的模型，而选择器不再列它、只剩一个模型时甚至不渲染，400 等于把用户锁死。默认模型本来就允许，所以回落不放宽任何权限。custom Agent 钉的模型不可达时回落 base preset 的模型；Web 端也不再发送 `models` 列表之外的记忆值。`GET /api/profiles` 同时返回 `models: listChatModels()`（过掉没有可达 provider 的模型）。**落库的是 registry id 不是上游模型名**——`modelConfig.model` 是 provider 链里第一个的名字、fallback 时并不改变，记它等于指认一个没跑过的 provider；`createChatStreamAsync` 因此返回 `modelConfig.id ?? modelConfig.model`。四个只差一行 `model.id` 的预设与 `extends` 机制已随之删除，见 [附件与预设收敛 spec](../../../docs/specs/20260731-attachment-and-preset-convergence.md) M3。
- **Kimi / MiniMax provider 已移除（2026-09）**：目录只剩 `flash` / `pro`（跟随 `LLM_*`）与原生 `deepseek-flash`（DeepSeek V4.1 Flash，`DEEPSEEK_API_KEY`），provider 适配器只剩 `deepseek` / `openai` / `openai-compatible`，`kimi-k3` / `minimax-m3` / `deepseek-pro` 及其采样剥离、`reasoning_effort`、`reasoning_split` 分支随之删除。历史数据里的这些 id（`messages.model`、`agent_runs.model`、custom Agent 的 `model_id`）原样保留，读路径按上一条的回落规则处理，不需要数据迁移。
- **模型目录的 `vision: true` 是「图片直传」的唯一开关**（部署可经 `vision_env` 覆盖；默认模型 `flash` 声明 `vision: true` + `vision_env: LLM_VISION`，因为它是什么模型由 `LLM_MODEL` 决定——文本模型的部署设 `LLM_VISION=false`，也可在 Runtime Config 的 `llm.vision` 改；无法识别的值保留声明值而不抛错，免得一次后台误填拖垮目录重载与下次启动）：chat 路由对声明了 vision 的当轮模型（`modelSupportsVision`）把 user 消息的 `images` 元数据经 `chat/vision.ts` 解析成 AI SDK image parts 直接进载荷（窗口内全部 user 轮，8 张 / 单图 10MB / 总 24MB 上限，新消息优先），**跳过 ID 提示**；超额/加载失败的图回落 ID 提示走 `analyze_image`，绝不静默丢。未声明 vision 的模型一切照旧（ID 提示 + `analyze_image`）。headless 路径（定时任务/proxy/MCP）刻意不做直传——消息本就不带 `images` 元数据。**直传轮必须同时注入「图已可见」的 system prompt 段**（chat 路由 `visionInlinedImages > 0` 分支）——`analyze_image` 的 description 命令模型「附图必调」，没有这段时模型会编造占位 URL（实测 `https://placeholder.local/…`）去满足工具、烧一步换必然失败。

### Agent 工具代理 (`/api/agent/*`)
- 稳定的云端能力层，供内部 CLI 按结构化工具访问服务端数据，路由在 `routes/agent-tools.ts`：
  - `GET /api/agent/runtime-manifest?profile_id=&workspace_id=` — 返回该用户/profile 可用的工具清单（含 `mutating` 标记与 input JSON Schema）
  - `POST /api/agent/tools/:toolId/call` — 执行单个工具
- 认证：登录用户 access token（`Authorization: Bearer`），经 `agentBearerAuthMiddleware` + per-user 限流。
- 工具集 = `resolveEffectiveTools(user, profile)` ∩ 代理白名单——代理只能**收窄**用户权限，永不放大。
- **内置 Agent 工具（`builtin: true` → `BUILTIN_AGENT_TOOL_IDS`，2026-08-13）**：自建 Agent 的 `tools` 数组是**交集过滤器**，作者没想到的能力就是没有——于是一个只勾了 email 的自建 Agent 被要求「每天 8 点查收件箱」时只能如实说做不到（dev friction 51）。10 个工具因此无条件并进过滤器：`ask_user`/`read_attachment`/`compute`/`memory`/`log_friction`/`automation_query`/`automation_mutation`/`export_data`/`task_capture`/`analyze_image`。
  - ⚠️ **必须并进 `profileTools`（过滤集），不是并进 `effectiveTools`（结果）**。写反了就是真正的放大：`memory` flag 关掉的用户会凭空拿到 memory，super-only 工具也会漏给 team。`resolveEffectiveTools` 那句「profile 只能收窄、永不放大」全靠与 `activeTools` 的交集，护栏是 `agent-runtime/__tests__/builtin-tools.db.test.ts`（拿真实 team allow-set + 关掉的 flag 验，super 用户验不出这个区别）。
  - **准入标准**：没有独立的权限/费用/外呼语义。领域数据（知识库/项目/Tables）、付费 provider、外发通道（email）、编排（call_llm）一律保持可选——「这个 Agent 能看到什么、能做什么」是作者的设计决策。写工具只有两个：`log_friction`（只往团队复盘队列记一条）与 `automation_mutation`：owner-scoped + 每人 10 条 + **已在 `UNATTENDED_TOOL_DENYLIST`**，所以定时任务不能靠它自我增殖。集合由 `tools/__tests__/builtin-tools.test.ts` 钉死。
  - **前端整组隐藏**（`profile-editor.tsx` 的 `pickableTools`）：既然勾不勾都一样，就不该渲染成一个答案不影响结果的问题；说明文字改为「基础能力始终包含」，以免那份清单被读成 Agent 能力的全集。
- ⚠️ **「这个用户能用哪些工具」只有 `resolveUserTools` 一个口径**（2026-08-13 修）：`routes/profiles.ts` 的 create / update / fork 三处曾各自重算 `global ∪ assigned`，漏掉 **feature flag 拥有的工具**（memory / Tables / 知识库 / 项目，见 `FEATURE_OWNED_TOOL_IDS`）。而工具选择器 `GET /api/tools` 用的是 `resolveUserTools`——于是普通成员在编辑器里看得到 memory，勾上保存必然 403，super 因提前 return 而永远撞不到。**同一个问题有两种拼写就是多了一种。**
- ⚠️ **fork 系统 Agent 要按「它真正跑起来是什么」播种**（2026-08-13 修）：系统 profile 的 YAML `tools:` 列表**运行时从不读取**（系统 profile 用的是用户完整 allow-set），但 fork 路径恰好读了它，于是 fork 出来的 Sprouty 严格弱于本体（没有 email/知识库/附件/记忆…）且界面上毫无提示。现在 fork 系统 profile 播的是该用户的 allow-set，fork 自建 Agent 仍播源 Agent 的声明集。
- **system prompt 永不动态罗列工具集**：工具定义（名称/描述/schema）已经由 `tools[]` 原生下发给模型；代码侧把"用户的工具名单"注入 prompt 必然与实际注册集漂移。`resolveEffectiveTools` 只返回收窄后的 `effectiveTools`，全量 allow-set 不出该模块。例外：profile YAML 的 system_prompt **可以**为工具写使用策略（如"先 search 再 get"），但只能引用该 profile 保证存在的工具——custom profile 引用自己 `tools:` 声明的；internal profile 只能引用 `is_global: true` 的（internal 实际工具集 = 用户 allow-set，点名非全局工具会对未分配用户产生虚假能力描述）。
- 代理集合由每个工具的 `meta.surface` 声明并在 `tools/registry.ts` 派生，`agent-runtime/tool-proxy.ts` 只消费这些集合：
  - `READONLY_PROXY_ALLOWLIST` — 只读工具（如 `project_query`、`session_query`、`knowledge_query`、`tables_query`）
  - `MUTATING_PROXY_ALLOWLIST` — 写工具（如 `project_mutation`、`knowledge_mutation`、`tables_mutation`）
- **写工具默认 DENY**：必须同时在写白名单内、调用方写权限包含它、且每次调用带 `confirm:true`，否则 400。每次调用写入 agent audit。
- **工具元数据 = 各工具文件内 co-located**：每个工具在自己的 `.ts` 里用 `defineTool({ meta, kind, create? })` 声明 metadata（`meta.description` 直接喂给 `tool({ description })`，无需再回 registry 取）。`tools/registry.ts` 是显式 catalog：导入各模块后由 `TOOL_MODULES` 派生 `TOOL_DEFINITIONS`、内部默认 id、proxy/MCP surface、lazy id、`STATIC_TOOL_MODULES` 与 `getAllToolIds()`，没有平行手维护清单。`kind`：`static`（带 `create(db)`，进共享 registry）/ `lazy`（core 工具无 create，按请求在 `buildLazyServerTools` 按 id 装配；扩展工具带 `createLazy(ctx)` 走通用路径）/ `special`（在路由里就地构造，metadata 进 registry 的 `SPECIAL_METAS`——**当前无人使用**）。
- 新增工具：① 在该工具文件 `export const xxxTool = defineTool({ meta, kind, create? })`（static 带 `create(db)`，lazy 不带），需要 Agent proxy/MCP 时同时声明 `meta.surface`；② 在 `tools/registry.ts` 的 `CORE_TOOL_MODULES` 加 import + 数组项（`TOOL_MODULES` 是 core + 已启用扩展工具的派生值，不在那里加）；③ core 的 lazy 工具在 `agent-runtime/tool-resolution.ts` 的 `buildLazyServerTools` 按 id 加构造分支（会话绑定的放进 `if (sessionId)` 块）——通用的 `createLazy` 路径只遍历扩展工具，core 工具写了 `createLazy` 会进目录却永远不被构造。所有集合自动派生，禁止再维护独立 allowlist；`tools/__tests__/surface-derivation.test.ts` 钉住 core 工具每个派生集合的精确成员，改暴露面要连测试一起改。

### Knowledge plugin

Knowledge routes, ACL, FTS, exports, presence and live updates belong to [plugins/knowledge](../../../plugins/knowledge/AGENTS.md). Core consumes registries only.

### 全局聚合搜索（`GET /api/search`）

⌘P palette 的后端：跨本人会话标题 / 本人定时任务 / 项目 / 知识库，按种类分组返回。会话 lane 按 `user_id` 过滤、只排除已退役的 `workflow` 转录与 eval（定时任务产生的 `task` 会话、飞书、手机会话都要搜得到），命中带 `updatedAt` 由客户端本地化，`subtitle` 不再塞原始 ISO。`automation` lane 只搜本人 automations（名称 + prompt，每人 ≤10 条，内存过滤），命中带 `automationId` / `enabled`，super 也只搜自己的（跨用户是管理面，不是搜索）。实体部分方案见 [spec](../../../docs/specs/20260804-entity-references-and-peek.md) D14–D18。

- **每域一条独立 lane，各自 dispatch、各自 try/catch**。任何一域不可用（未开通、无权限、报错）只让那一组为空——一扇门关着不是一次故障。
- **不做跨域相关性排序**：项目/会话全是 ILIKE 无 relevance，知识库是 `ts_rank`(<1)，不可比；混排会让回退通道把真命中挤掉（知识库内部早踩过）。
- **守卫写在路由文件内 `.use('*', requireInternal())`**，不是挂载点的 `.use('/api/search/*')`——`/*` 匹配不到裸路径本身，那样只剩全局 Bearer 兜底。

### 对象链接解析（`POST /api/refs/resolve`）

正文里的站内链接（网页地址或 App 深链）在客户端画成对象胶囊，标题从这里批量取回（`routes/refs.ts`）。
- 认哪些 URL 只看 `@greenhouse/types/object-refs` 的 `parseObjectUrl`（网页、手机、服务端共用一份）；不认的 URL 直接不返回。绝对地址只认本站 origin（请求 origin / `Origin` / `PUBLIC_BASE_URL` / `WEB_BASE_URL`）。
- 每一项用该对象自己读接口的那套鉴权：文档 `resolveKbAccess`、文件/文件夹 `resolveDriveAccess`（kb scope）、项目 dispatch `getProject`、任务 `taskReadAuthorizer` + `projects.execution.read`、记录 `tables` 开关 + dispatch `getRecord`（标题取主字段，值被遮蔽时退回 `#id`）、对话 `canAccessSession`。别在这里另写一套判定。
- 文档两种链接都认：`#/knowledge/doc/<id>-…`（按 id）和按 slug 的：不以 id 开头的 `#/knowledge/doc/<slug>`（模型常这样写）、地址栏上的 `#/knowledge/internal/<space>/<slug>`、`personal/<slug>`、`shared/<slug>`、`folder/<id>/<slug>`（按 slug，查法同 `GET /api/knowledge/docs/:slug`）。按 slug 的只在读得到时把 `id` 换成文档真 id，读不到时 `id` 原样是链接里的 slug。
- **读不到和不存在必须长得一样**：都返回 `title: null`，不报错、不区分，免得成为存在性探针。任务链接里的 project 与任务实际所属不符也按读不到处理。
- 每次最多 50 条（`MAX_RESOLVE_URLS`），同一对象只查一次。项目、记录走 dispatch，和搜索一样会留读审计。

### 成员名字（`POST /api/people/resolve`）

插件记录的 `user` 字段存成员 id，客户端画成名字，从这里批量取回（`routes/people.ts`）。
- 只给内部成员（super / team），和成员选择器里看得到同事的人是同一批。
- 只回 `{ id, name }`（昵称）；不回邮箱、角色、状态。查不到的 id 直接不返回。
- 每次最多 200 个（`MAX_RESOLVE_PEOPLE`）。

### 工具返回值里的站内深链（`url`）

返回可点开的记录时，结果行带一个 `url` 字段，模型在正文里把它写成 Markdown 链接，用户点击就地浮出详情。方案见 [spec](../../../docs/specs/20260804-entity-references-and-peek.md)。

- **深链格式的唯一真源是 `@greenhouse/types/entity-links` 的 `entityUrl()`**，构造与解析共用一张表（浏览器侧靠 `parseEntityUrl` 认出这些链接）。**别再手写 `#/knowledge/doc/${id}-${slug}` 这种模板**——`knowledge-mutation.ts` 手抄过一份，两边已经开始漂移，这次一并收敛了。
- **引用指令写在工具 description，措辞取自零 import 叶子模块 `tools/cite-url.ts` 的 `CITE_URL_INSTRUCTION`**（今天 7 个工具在用）。写在 description 而不是 profile prompt，是因为它随 function definition 下发、自动覆盖 chat / proxy / MCP 三个面；抽成常量是因为六份同义句必然漂移。**「verbatim，不许自己拼」是这句话的重点**——伪造的链接和真链接长得一模一样，直到有人点开。
- **加这句话要付描述预算**（`__tests__/description-budget.test.ts`）：这次的 ~600 字符是靠删工具里 zod schema 已经 `.describe()` 过的筛选/排序字段清单付的，ceiling 没动。下次同理——先删重复，别先抬预算。

### Tables plugin

Tables routes, schema plans, CLI restoration, tools and authorization live in [plugins/tables/AGENTS.md](../../../plugins/tables/AGENTS.md). Core consumes registries only.

### Platform Kernel v2
- `platform/` 是内部应用的统一运行时：应用以确定性 Manifest v2 声明 module/entity/field/action/navigation，运行时代码只放在 registration/adapter，不写入 Manifest。`bootstrap.ts` 负责激活已注册 manifest、建立受保护的 `super/team` baseline roles，并只同步 active 内部用户绑定；历史 `external` 用户不再建立 Platform role。成员没有任何角色绑定时，判定按 `users.role` 落到同名系统角色（`db.platform` 的 snapshot），所以手工复制账号行后不必等重启或重跑 bootstrap 也不会 403；护栏 `tests/db/platform-service.db.test.ts`。3.0 不存应用 release，也没有组织表：`orgId` 固定传 `PLATFORM_ORG_ID`（`'default'`）。
- `runtime.dispatch()` 是受保护 action 的唯一入口，固定顺序为 capability → record/field policy → handler → platform audit。HTTP、Chat Tool、Agent Proxy 与 MCP 只能做协议适配，不得各自复制一套权限判断。
- 已接入 `projects`、`knowledge`、`tables`。各应用的 `access.ts` 把 Entity Policy 转成业务查询的 SQL scope，并对读取/导出结果执行字段投影；未授权的记录按 404 处理，避免 IDOR 存在性泄露。
- **响应里的计算字段必须写进 Manifest**：投影只保留 Manifest 声明过的列，未声明的键（含 `owner_name`/`user_name` 这类服务端拼的展示字段）会被静默丢掉。加字段要同时 bump 对应 manifest 的 `version` 并更新 `platform/__tests__/manifest-hash.test.ts` 的 hash（3.0 不再在启动时比对 release，这个测试是唯一护栏）。投影丢字段静态检查测不出，只有起服务才暴露。
- 权限管理 API 位于 `/api/admin/platform`（super-only），支持 catalog、角色（能力、成员、Entity Policy）、最终权限预览和审计。判定是角色 allow > 默认 deny，**没有个人级能力 / 实体策略例外**（3.0 删除）：要收窄某个成员就换一个更窄的角色。策略写入时必须与当前 Manifest 的 access scopes/fields 交叉校验。
- 新应用先运行 `pnpm cli platform create-app <id> --title "..." --dry-run` 评审边界；生成器只创建 fail-closed Manifest/registration/test/README，不会自动接入 bootstrap 或生产 runtime。
- 新应用必须有 Manifest、registration、SQL scope/record/field adapter、HTTP/Tool/MCP 适配和 parity/security matrix；不要直接在 transport 层放行。无专用 Web UI 的应用可以保持 Agent/MCP-only。
- **管理员改配置必须留平台审计**（v1.4）：`PUT /api/admin/settings` 有实际改动时记 `updateWorkspaceSettings`（`capability='platform.settings.manage'`，summary 只有 `set` / `cleared` / `secret_keys` 三个**键名**列表）；按用户开关功能（`PUT /api/admin/users/:id/features`、`PUT /api/admin/features`）经 `recordAccountSecurityAudit` 记 `setUserFeature`（feature、enabled、`config_keys`）。**永远只记键名不记值**——这些设置里有 LLM / 媒体 / 搜索的密钥。新增管理员写配置的端点照此办理。护栏 `routes/__tests__/admin-config-audit.db.test.ts`。

### 会话编排工具（`call_llm`）与共享 headless runner
- 子会话（`spawn_session` + Subagent driver）已于 1.5 移除；历史 `channel='subagent'` 会话与 `kind='subagent'` Run 只读保留。`call_llm` 并行发起一次性 LLM 调用，**lazy 且 session-scoped**——只在 `buildLazyServerTools` 收到 `sessionId` 时装配，因此**不在无状态的 proxy/MCP 面暴露**。`is_global:true`：对内部用户默认开启（无需 assign），但因 session-scoped 仅在带 sessionId 的 chat 面生效。
- **共享 runner**：`agent-runtime/run-agent.ts` 的 `runAgentInSession()` 是"在某 session 里跑一轮 agent 到结束并落库 assistant 消息 + pipeline + 引用"的唯一实现，`scheduler/executor.ts`（定时任务）与飞书机器人都复用它。LLM 调用走可注入的 `generate` seam（默认 `generateText`，测试可 stub，无需真模型/真 key）；`db` 也可注入（默认 `getDb()`）。
- **headless 记账契约**：`runAgentInSession` 的 `usageContext`（profileId/userId/caller）**必填**——每轮结束写一条 `usage_events`（`kind='model'`，registry 模型 id，含 cached/reasoning token），归属 owner 并计入其 USD 预算；caller 标签固定为 `scheduled-task` / `feishu-bot`（历史行还有已退役的 `workflow` / `workflow-review` / `spawn_session`）。记账失败只 warn 不失败运行，契约由 `agent-runtime/__tests__/run-agent.test.ts` 钉住。`defaultGenerate` 记 `totalUsage`（多步合计，v6 的 `result.usage` 只算最后一步）并带 `CHAT_STREAM_TIMEOUT`——定时任务因此与 chat 同享时间上限。
- **定时任务不持有永久权限**：Scheduler 在启动、reload、自动/手动执行以及真正调用模型前都重新读取 owner；只有数据库中当前为 `active team|super` 的用户可运行。Executor 必须复用 `resolveEffectiveTools` + `buildLazyServerTools`，任务 Profile 只能收窄 owner 当前工具权限，不能放大；禁用/降级账号后旧 cron 立即 fail closed。
- **`call_llm`**：无 session、无工具、一次性。完整 input/output 写 `usage_events`（`kind='audit'`，经 `db.llmCalls`，按调用方 session_id 关联，不计花费），**不回灌上下文**；可选 `model` 覆盖（走便宜模型）；模型在一个 step 内多次调用即并行扇出；2min 超时 + parent-abort。

### 统一 Runtime 读模型（`runtime/` + `/api/runtime`）

- **部署级 kill switches 与用户权限分离**：`trusted-execution/kill-switches.ts` 是唯一解析入口，所有开关默认启用，非空非法值 fail-closed 并由 `/health.trusted_execution.invalid_env` 只报告变量名。`RUNTIME_CHAT_ADAPTER_ENABLED` 只跳过新 Chat Runtime trace，ChatRun、transcript 与 provider 调用照常工作；`RUNTIME_WORKER_ENABLED` 是 lease/outbox 与所有 durable driver 总闸，`RUNTIME_AUTOMATION_DRIVER_ENABLED` 可再独立停止 Automation 认领（`RUNTIME_SUBAGENT_DRIVER_ENABLED` 随子会话于 1.5 删除）；`RUNTIME_NOTIFICATION_PROJECTOR_ENABLED` 同时停止站内通知投影与可重试的外部通知 delivery worker；兼容环境变量 `TASK_CENTER_ENABLED` 让 `/api/runtime` 读面稳定 503；`RUNTIME_APPROVAL_INBOX_ENABLED` 独立关闭 Interrupt 列表/决议但保留其它执行中心读面（自定义 Agent 的生命周期治理 worker 与 `AGENT_GOVERNANCE_ENABLED` 随 v1.4 删除）。任何一个关闭都不得改 `user_grants`，也不得停止 Chat；新增 convergence 服务必须登记独立开关与健康事实。
- `/api/runtime/runs`、`/interrupts`、`/summary` 是 Runtime 读面的单一 API（v1.5 起网页列表改由 `/api/activity` 承担，运行详情仍读 `/api/runtime/runs/:id`），但 Runtime 是读模型而不是授权凭证：Chat 与历史 Eval / Workflow 仅 super，历史 Mission / Subagent 与 Automation 按 owner；**退役种类**（`eval` / `mission` / `workflow`，v1.4，连同 Mission/Workflow 的 read-model 镜像与 reconciler；`subagent`，1.5）只读、不提供任何命令（遗留的活动 Run 已由 3.x 启动时一次性收为 `canceled` / `runtime_kind_retired`）；列表、详情、events、interrupts、summary 与每次 command 都按来源域 fail-closed 过滤，不能因历史 Runtime owner 行保留已撤销权限。jsonb 列原样组成完整 `RuntimePayload`，不截断消息、工具参数、事件或决定；`run_events` 按保留期（已结算 Run 30 天）清理，详情里更早的事件可能已不在。
- ordinary Chat 是 trace-only Runtime producer：`routes/chat.ts` 必须为每个 authenticated provider turn（包括 stateless）在 title/main provider I/O 前创建 `kind=chat/source_kind=chat_turn` Run + `chat_turn` Step，并把 Runtime run id 传给 provider-attempt budget；`chat/turn.ts` 先持久化 transcript（有 session 时），再按成功/用户 stop/流中断收口 `succeeded/canceled/interrupted`。Runtime 永久保存 exact transcript、完整 provider envelope、answer/reasoning/pipeline 和未摘要 raw tool input/output；worker 永不 claim Chat。启动必须调用 `reconcileInterruptedChatRuntimeRuns()` 把遗留 active Chat trace 标 `interrupted`，不 replay。稳定 source 优先用持久 user message id，regeneration/continuation 才附 transport UUID；stateless 以 ChatRun UUID 唯一标识；已终态 source 禁止复用。普通用户仍看不到 Chat Runtime，super 可从运营 trace 查看。
- **Runtime ToolCall 必须在真实 execute 边界落证据**：Chat、Automation 统一用 `runtime/tool-evidence.ts` 克隆 per-turn 工具表并包装 `execute`，禁止再从 `fullStream`/整轮 `steps` 事后补写。wrapper 必须 await `db.runtime.beginToolCallWithAuthority()` 后才进入原工具，并在完整 output/error 终态写成功后才把结果交给模型；before 写失败或已 abort 时原工具调用次数必须为 0。risk 从 `defineTool` 共置的 `runtime_risk`（未显式声明时按 proxy surface 的 read/write 姿态）推导，input/output/error 永久完整保存。Automation 必须传 workerId + leaseMs，由 DB 同事务锁 Run/Step 并重验 desired state、owner、双 lease；Chat 只能走明确的 unleased `chat_turn` projection。`running` 仅表示已 admission，worker 在 begin commit→execute 或 execute→terminal write 窗口消失都收为 `uncertain`，绝不自动重试；取消无法撤销已开始的外部副作用。
- 统一命令只委派现有领域 driver 真正支持的动作：Automation cancel；**Interrupt 决议端点已删除**（它只有 Mission approval 与 Workflow gate 两个驱动），Runtime Interrupt 仍是内核原语，历史 Interrupt 在执行中心只读展示；来源不支持的动作返回冲突，绝不能只改 Runtime 做出“已暂停/已重试”的假象。Run command 必须经 `db.runtime.executeRunDomainCommand()`：事务锁定 Runtime Run，在锁内重新鉴权并完成领域 side effect，再 CAS 推进 desired state + Event/Outbox；`may_drive=false` 只允许确认 crash-window 中来源已到目标，禁止发起新副作用，从而保证同版本 pause/cancel 不会双执行。
- `runtime/worker.ts` 负责 stale lease/Interrupt 过期和 `runtime.events` Outbox 的 claim/lease/ack/retry/dead-letter；投递成功才 ack，并发出只含 id/status 的 `runtime:invalidate` WS。可执行 driver 必须显式注册才 claim。driver 持有自己的 lease/heartbeat 并 detached 运行，长任务不能阻塞 outbox 与 stale maintenance pass。通知投影通过 `onEvent` observer 注入，失败重试 Outbox，不能反向改业务 Run 终态。

### 操作记录（`activity/activity-log.ts` + `/api/activity`，v1.5）

- 执行中心改成「操作记录」：一条按时间倒序的改动流，来源四种——成员在应用里（`audit_events`，`actor_type='human'`，只取各已注册应用 manifest 里 `kind:'command'` 的动作 + drive 改动 + 报告模板改动（v1.7，`app_id='reports'`，归 SkillHub 模块）+ 成员自己连接/断开 Agent）、成员的 Agent（`agent_write` run，带客户端名）、定时任务（`automation` run）、管理员（工作区设置 / 用户访问 / MCP 机器客户端，动作 id 白名单在 `ADMIN_ACTIONS`）。读操作也会记审计，**绝不能**当作改动显示。
- 可见性在服务端：成员只看自己（`user_id` 参数被忽略）；super 看全员、可按人筛；管理员改动只给 super。对象名只在**查看者**读得到时给出（知识库走 `resolveKbAccess`，项目按公开/成员，档案按团队架或本人）；super 看不到别人私有文档的标题。管理员设置改动只显示**键名**。
- 性能：每个来源各查 `limit+1` 行、按 `(created_at, '<前缀>:<id>' COLLATE "C")` 归并成一个游标；时间窗必填（默认 30 天，最长 366 天），SQL 里有下界，所以不会无界扫表。人员筛选在 human 行上只用 `actor_id`（有 `(actor_id, created_at)` 索引）。`runs` 没有 `(kind, created_at)` 索引，super 不按人筛时靠时间窗兜底。
- 措辞（v1.5 polish）：每条都是「动词 + 对象种类 + 对象名」，首页团队动态与操作记录对同一改动说同一句话（网页 `ActivityRow` 共用）。Agent 写入按工具动作推出动词与对象（`describeToolWrite`：`knowledge.update_doc` → 更新了文档，`folders.create` → 创建了文件夹，`log_friction` 的 `action` 是问题种类、不是动词），**对象种类不用模块名**。新建的对象按写入结果里的 id 现查、按查看者读权限命名；查不到（已删）时只对发起写入的本人（项目/技能/需求另加 super）用写入自带的标题。动词或对象说不清的动作（连接/断开 Agent、邀请、重置密码…）在网页 `activity.action.<actionId>` 里给整句。
- 审计提示：handler 成功结果可带 `audit: { recordId?, summary? }`（`PlatformAuditHint`），内核把它并进成功审计并从返回值里剥掉——用于「新建时请求还不知道 id」和「删除后还要能叫出名字」（Projects 的建/删项目与任务记 `title`）。只放标题这类本来就给读者看的事实，绝不放内容或密钥；显示时仍按查看者规则把关。知识库 HTTP 新建从 201 响应里取 id；编辑心跳（`editing-presence`）审计带 `activity:false`，不进操作记录；评论记 `change:'comment'`。
- 导出 `GET /api/activity/export` 与列表同一筛选、同一顺序，最多 5000 行，CSV 单元格防公式注入。
- 网页：`#/activity`（成员）与 Administration › Activity log（super）是同一个页面；运行详情沿用 `#/activity/<kind>/<id>`。
- **铃铛「团队动态」`GET /api/activity/recent`**（`activity/recent-changes.ts`）是另一件事：近 14 天**全团队**的改动，每页 ≤ 50，`before` 传回上一页的 `next_before`（不透明 `(at, id)` 游标；旧客户端的纯 ISO 时间仍接受，表示严格更早）。所有条目按 `(at, id)` 倒序排成一条序列，各 lane 在 SQL 里按同一顺序分页（聚合、合并在分页前做），被权限滤掉的行不算数，继续往下读直到够一页或读完（每页每 lane 至多 5×100 行，读不完时 `next_before` 停在已读到的位置），所以短页不会吞掉更早的条目。只含查看者读得到的对象。数据源各用本域自己的记录：知识库 `kb_versions`（逐篇过 `resolveKbAccess`，窗口内同一人同一篇只取最新一次保存）、项目动态 `audit_events`（`app_id='projects'`；只取 `listProjects` dispatch 给查看者列出的项目，实体策略因此生效）、表格 `table_records`（只取 `listBases` 列出的 Base 下的表，按「表 × 人」在整个窗口内聚合计数、再按最新时间分页，**从不读记录值**）、云盘新文件（团队架 + 本人）。每条 lane 各自 try/catch，一扇门关着不等于整个 feed 故障。
  - 「经由哪个 Agent」靠对时间：同一成员、同一模块、落在某条成功的 `agent_write` run 的 `[created_at, settled_at]` 之内就标上客户端名；**不留余量**——Agent 刚写完、本人紧接着手改的那一条必须仍算本人。
  - 应用内助手（Chat）的写入不在操作记录里单列：它们的平台审计 `actor_type='agent'` 且没有客户端 id，与 MCP 写入分不开；MCP 写入以 agent_write run 为准。

### MCP 服务端 (`/api/mcp`)
- 把上面的 Agent 工具代理用 **MCP 协议**包一层，让任意 MCP 客户端（Claude / Cursor / 外部 agent）按标准协议访问内部资源。路由在 `routes/mcp.ts`，**薄适配器**——不自定义资源访问：`tools/list` ← `buildProxyManifest`，`tools/call` ← `executeProxyTool`（confirm 门 / 输入校验 / 权限交集全复用 `tool-proxy.ts`）。
- 依赖 `@modelcontextprotocol/sdk`；传输用 **WebStandard Streamable HTTP**（无状态：每请求新建一个声明 `tools` 能力的 `Server`，直接吃 `c.req.raw` 还回 `Response`，无需 `fetch-to-node`）。`enableJsonResponse:true`。
- 认证 **OAuth-only**：交互式走 Authorization Code + PKCE S256，自动化走 `client_credentials`（super 在 admin 面板创建机器客户端：`client_secret_post` + 绑定最小权限内部用户 + `allowed_scopes` 上限；只发 1 小时 access token、不发 refresh）。`agent-runtime/mcp-auth.ts` 的 `mcpCredentialMiddleware` 每请求校验 token hash、resource audience、scope、grant/client/user 状态并构造 `AgentIdentity`；非 `lpoa_at_` Bearer 一律 401 + RFC 9728 challenge。旧 `lpai_sk` A2A Key 通道已删除（migration 0030 同步禁用存量行；`api_clients` 随 v1.4 删除 LLM 中转一并退役，表暂留见 db AGENTS「退役表」）。
- OAuth discovery：`/.well-known/oauth-protected-resource/api/mcp` + `/.well-known/oauth-authorization-server`；协议端点 `/oauth/{authorize,register,token,revoke}`；用户 consent/grants API `/api/oauth/*`。公开客户端只支持 `token_endpoint_auth_method=none`，PKCE 强制 S256，redirect URI 精确匹配，token 只存 SHA-256 hash。
- **scope 是两个正交维度：动作 × 资源组**（2026-08-16，见 [spec](../../../docs/specs/20260816-mcp-surface-and-scope-granularity.md)）。动作 scope（`mcp:read`/`mcp:write`）说"能做什么动词"，资源组 scope（`mcp:knowledge`/`mcp:projects`/…，每个 MCP 资源组一个）说"能碰哪些数据"，可达工具 = 组内工具 ∩ 动作档，再 ∩ 绑定用户自己的权限。组的真源是各工具 `meta.surface.mcp` 里的组名（union 类型，**新工具上 MCP 必须回答属于哪组**，忘了是编译错误），`MCP_TOOL_IDS_BY_GROUP` 与 scope 列表都由它派生。
  - ⚠️ **`normalizeOAuthScopes`（请求侧）与 `parseStoredOAuthScopes`（存储侧）刻意不对称，方向写反就是静默提权**：前者对"没提资源组"的请求展开成全部组（客户端不知道我们怎么分组，多数只会照搬 `scopes_supported` 或干脆不传，不展开等于打断所有现有客户端）；后者**永远不展开**——存的是什么就是什么。在存储侧加一行展开，等于把每个存量 grant 提权成全权限。存量行由迁移链 显式回填，所以代码里**没有**、也不该有"无组视为全部"的兼容分支。回归护栏在 `platform/__tests__/oauth.test.ts`。
  - **空资源组不是合法状态**：consent 页全不勾时禁用按钮，approve 端点 400 拒绝。这不是体验优化——是让"没有资源组"永远不出现在存储里，从而杜绝将来有人把它读成"全部"。
  - **`AgentIdentity.allowedTools` 同理**：`undefined` = 不收窄（CLI/沙箱按用户全权），`[]` = 零个可读工具。`resolveProxyToolIds` 曾把空数组当"不收窄"，而 MCP 现在正是从资源组派生这个列表——两者合流就是把最窄的授权变成无限制。
- OAuth scope 只收窄、不放大平台权限：`mcp:read` 才可访问，`mcp:write` 只决定是否暴露写工具；401/403 challenge 的 `WWW-Authenticate: scope=` **必须广播全量 `OAUTH_SUPPORTED_SCOPES`**——MCP 客户端按 SEP-835 优先采用它（高于 metadata 的 `scopes_supported`），只写 `mcp:read` 会把所有被发现的客户端钉死成只读 grant，用户在 consent 页连选都选不到（2026-07-27 修）；真正的授权决定权在 consent 页，写入会留痕（见下）。每个 action 仍走绑定用户的 Platform capability + record/field ACL。MCP 与 refresh 每次都把 token/code scopes 和当前 grant scopes 取交集校验；grant scopes 变化会事务性撤销旧 token/未用 code，grant/client/user 撤销在下一请求生效。
- **安全边界 = key 绑的那个内部用户**：代理只能收窄其权限（`resolveEffectiveTools ∩ 代理白名单 ∩ MCP 阶段集`）。给每个外部集成绑**最小权限专设用户**，别绑 super / 个人账号。
- **写入留痕（v1.4，`agent-access/`）**：外部 Agent 以连接它的成员身份工作，成员有权限做的写入**立即执行**，Greenhouse 里不排队、不审批；确认交给坐在 Agent 旁边的人（客户端自己的确认 + 我们给的提示）。别加回网页审批队列、常驻授权或过渡开关：那会让人在 Agent 和 Greenhouse 两头操作。
  - 每次 MCP 写入都是一条 Runtime run（`kind='agent_write'`、`source_kind='proxy_call'`，owner=凭证绑定的成员），完整 input/output 经 `runtime/tool-evidence.ts` 永久落库；成员在 Settings › Agent 接入 › 写入记录（`GET /api/agent-access/writes`）和执行中心看到它。
  - 风险分级 `agent-access/risk.ts` 只用于记录和删除预览：删除类动作（`delete/remove/purge/destroy/drop`）r3，个人知识库建文档 r1，其余 r2；`runtime_risk` 是下限，扩展工具自动适用。
  - **删除两步确认（软提示，不是锁）**：r3 写入不带 `confirm:true` 时返回 `{"status":"needs_confirmation", preview…}` 普通结果，不建 run、不执行；Agent 给用户看过、再带 `confirm:true` 调一次才执行（basis=`confirmed`）。`confirm` 只出现在能删除的写工具的 schema 里，其他写工具收到会被剥掉并忽略。
  - **MCP 标注**：每个工具带 `annotations`（读 `readOnlyHint:true`；写 `readOnlyHint:false`，除非每个 action 都只是新增，否则 `destructiveHint:true`——MCP 里 false 表示「只做新增」，编辑、归档都不算），写工具描述末尾和 `SERVER_INSTRUCTIONS` 都提示「改别人在用的数据前先跟用户确认」，让客户端自己决定何时问人。
  - 写入结果：成功返回工具输出 + 末行 `Recorded in Greenhouse as write <id>.`；工具拒绝记为 failed（`isError`）；执行了但结果没能落库记为 `outcome_unknown`（不是错误、不要盲目重试），启动时仍在运行的 agent_write 一律收为 `interrupted / agent_write_outcome_unknown`，**绝不重放**。
  - 通知：agent_write 成功不通知，失败 / 结果未知才通知（链到写入记录）。
  - `/api/agent`（CLI，用成员本人的登录令牌）不走这条路径，保留原来的 `confirm:true`。
- **有界回复（v1.4，`agent-runtime/tool-output-store.ts`）**：`tools/call` 的回复文本（读工具、已执行的写入）超过 12,000 字符时不原样返回：全文存为私有对象，回复改为两块——先是句柄 `{truncated:true, output_id, total_chars, next_offset, expires_at}`，再是 ≤8,000 字符的预览（截在换行 / `},` / 逗号处）。协议层工具 `tool_output_read`（`output_id`、`offset`、`limit` ≤12,000）按区间续读。长度按 JS 字符串单位计，区间不劈开代理对。
  - **存储不建表**：对象放在既有存储驱动的 `drive/mcp-output/<sha256(成员+客户端)>/<output_id>.json`。读取时用**调用方**的成员与 OAuth 客户端重算 key，别的成员或同一成员的另一个客户端只会拿到「not found or expired」——鉴权就是 key 本身，没有行可查也没有存在性可泄露。`chat_files` 不能用：每行必须挂在一个聊天会话上，而 MCP 调用没有会话。
  - `output_id` 自带创建时间：读取时先按它判 24 小时过期（不等清扫），清扫（`index.ts` 的五分钟 upkeep）只靠列举前缀删过期对象；前缀下形状不对的 key 一律不碰。单份存储上限 4,000,000 字符（超出时句柄带 `stored_chars`）。存储写失败不让调用失败（写入可能已执行）：照样返回句柄（`output_id:null`）+ 预览。
  - 只在 MCP 面；`/api/agent`（CLI）不截断。
- **暴露范围**：`MCP_EXPOSED_TOOL_IDS`（由各工具 `meta.surface` 派生，见 `tools/registry.ts`）= knowledge + files + project + tables + chat + skills + automation（只读）+ feedback + 付费服务（`services`，见下）+ 云电脑（`computer`）+ 报告（`reports`，v1.7）。工具须同时有 proxy 读/写 tier。
  - 付费服务（v1.6，资源组 `mcp:services`，存量 grant 重新授权才获得）：`web_search`（读，只搜不抓正文）、`read_url`（读，一个公开网页的正文）、`analyze_image`（读，`image_id` = 上传 id / 公开 https URL，或 `file_id` = 云盘文件，按 drive 读权限）、`generate_image`（**写**：图存进成员云盘的个人架，返回 `file_id` + 5 分钟下载链接；留痕、只新增，`destructiveHint:false`）。实现与 Chat 共用一份：搜索 / 读网页走 `external-search/index.ts` 的 `searchWeb` / `readPageMetered`，外部面的工具在 `agent-runtime/service-tools.ts` 里建（MCP 与 `/api/agent` 都叠在 `buildLazyServerTools` 之上，`generate_image` 在这里换成存云盘的版本），Chat 仍是 `external_search` + 内联生图。每次调用都按 MCP 的计价 scope 记到成员、client `mcp`、OAuth client id。
  - `read_url` 的 SSRF：先 `assertSafePublicPageUrl`（不预留、不抓），本机兜底抓取再走 `fetchPublicPage`（逐跳校验 + 连接时 DNS 校验）。
  - MCP 标注读 `meta.surface`：`openWorld:true` 的工具（三个联网服务、云电脑）报 `openWorldHint:true`；`additiveOnly:true` 的写工具（`generate_image`，没有 action 动词可判）报 `destructiveHint:false`。
  - **`image` 资源组退役**（`RETIRED_MCP_RESOURCE_GROUP_IDS`）：仍是合法 scope（存量 grant 照常解析），consent 页与机器客户端表单不再提供；存的 `mcp:image` 经 `LEGACY_MCP_GROUP_TOOLS` 只够得着 `generate_image`，不多不少——它现在是写，所以还得有 `mcp:write`。
  - **2026-08-16 摘掉三个**：`email_query` / `email_mutation` / `automation_mutation`（proxy tier 原样保留，CLI 照常用）。理由不是"风险大"这种泛泛判断，而是**它们的安全模型在 MCP 上不成立**：`email_mutation` 的全部安全性来自"用户读了那张草稿卡"——draft 把 token 交给模型、send 发服务端存的草稿，中间那道人读的门是承重的；MCP 上 `user_confirmed` 与合成的 `confirm` 都由调用方模型自填，两段确认坍缩成一段。同一条理由早已把它写进 `UNATTENDED_TOOL_DENYLIST`，而 **client_credentials 机器客户端就是无人值守**。email 又是全部写工具里唯一外发、不可逆、发出去收不回的通道。`email_query` 一并摘掉：私人收件箱全文不该交给第三方客户端。`automation_mutation` 是自我增殖（"能建定时任务的定时任务"），当前有三层兜底所以不算在救火，但重开无人值守写权限前先关掉这条侧门。**别用"加 approval lease"复活它们**——那套形状服务的是长任务里等人拍板，MCP 是同步请求-响应，调用方会阻塞等人点按钮。
  - chat：只读 `session_query`（已在只读白名单；`session_history` 2026-08-07 并入其 search/messages，旧名经 `normalizeLegacyToolCall` 别名兼容）；MCP 不提供直接驱动聊天的端点。
  - skills：技能中心 `skill_query`(读：find/get/download/check_updates)/`skill_mutation`(写：publish/update_meta/archive/unarchive/delete)——owner/super 校验在 `plugins/skills/api/skills/center.ts`，与 `/api/skills` 路由共用同一实现；外部 agent 可经 MCP 发布/同步团队技能。
  - feedback（v1.5，独立资源组 `mcp:feedback`，存量 grant 不自动获得）：问题与需求——`feature_request`（写：submit；super 另有 list/update，MCP 上同样记名）、`log_friction`（写）、`feedback_query`（读：本人提交的需求及管理员回复，super 可 `everyone`）。friction 仍然没有读动作。
  - files（v1.5，独立资源组 `mcp:files`，存量 grant 不自动获得）：云盘 `files_query`（读：files.list/search/get/read/download_url）/`files_mutation`（写：folders.create/update/delete、files.upload/update/delete）。覆盖当前档案柜（Knowledge 启用时为其 legacy `kb` scope，禁用时为核心 `drive` scope：团队架 + 本人个人架），实现只有一份 `drive/kb-cabinet.ts`，每个节点都过 `resolveDriveAccess`，移动不跨架；上传 ≤5MB（`drive/cabinet-limits.ts`）、改名同样过上传黑名单；下载链接只在配了对象存储时给（5 分钟预签名），本地存储明确报错并指向 files.read。删除类动作自动走预览 → confirm:true。
  - reports（v1.7，独立资源组 `mcp:reports`，存量 grant 不自动获得）：`report_templates`（读：list/get/validate，`unattendedReplaySafe`）/`report_render`（写，`additiveOnly` → `destructiveHint:false`，无 confirm 往返）。详见「报告模板与渲染」。
- 审计：每次 `tools/call` 经 `recordMcpAudit` 写 `request_log`（`channel='a2a'` 枚举沿用、`app_id`=OAuth client id、绑定 `user_id`）；平台侧 actor `authMethod` 区分 `oauth`（人授权）/`oauth-client`（机器凭证）。
- 机器客户端管理：`/api/admin/platform/oauth/machine-clients`（仅 super，routes/platform-admin.ts）：create（返回一次性 `lpoa_cs_` secret）/rotate-secret/disable（级联撤 grant+token，re-enable 自动恢复机器 grant）/delete/per-client audit；创建即校验被绑用户 active/内部并 upsert 机器 grant。DCR (`/oauth/register`) 保持 public-only，机器客户端不可自助注册。
- 性能：用户的 effective 工具集（`user_grants` 的 feature / tool 行）**每请求重新解析**（两次轻量 DB 读），60s 的 `CONTEXT_TTL_MS` 缓存只免注册表构建——cache key 含 effectiveTools 签名，任何权限变化即 miss；Platform 工具可见性与 OAuth token/grant/client/user 状态同样不缓存。**撤权（含 flag 关闭与工具收回）一律下一请求生效**。flag→工具的门控只在 `resolveUserTools` 一处（由 `FEATURE_POINTS` 派生），本路由不再二次门控——曾经手写的第二份 CRM/Tables 工具表与 feature-points 漂移过，跨渠道口径由 `tests/api/channel-tool-parity.db.test.ts` 钉住。
- 管理 UI：Settings › Administration › MCP Access（`apps/web/src/pages/administration/mcp-keys.tsx`，super-only）：建/轮换/禁用/删 key、复制客户端配置（折叠的 "How to connect"）、per-key Activity（读 `/:id/audit` 看最近调用）。
- 纯逻辑（`toMcpInputSchema` 的 schema 归一化 + confirm 注入、协议往返）已单测：`routes/__tests__/mcp.test.ts`（用 SDK `InMemoryTransport`+`Client`，不连 DB）。
- **团队上下文（v1.7，`hub-context/`）**：服务器声明 `tools` + `resources` + `prompts` 三种能力，内容一律按本次 grant 可达的工具集（`ctx.toolIds` = scope ∩ 成员权限）裁剪，见下方「团队上下文与数据目录」。
  - resources：`greenhouse://context/overview`（任何 grant 都有）、`/conventions`、`/glossary` 的 Markdown 来自工作区设置；插件文档源按可达工具集裁剪，Knowledge 的选定文档及文档资源要能到 `knowledge_query`（v1.7 前 resources 只看平台权限、不看资源组，已收紧）。
  - prompts：`skill-<name>`（技能中心里本人能下载的技能，隔离规则即 `downloadSkill` 的 `skillUsableBy`）与 `prompt-<id>`（本人的 + 共享给团队的 Tasks），都要能到 `skill_query`。
  - 协议层工具 `team_context` / `data_catalog`（与 `tool_output_read` 同层，不进 registry）：每个 grant 都列出、只读，回复同样经 `boundReplyText`，按 `mcp` 计 `tool_call`。`SERVER_INSTRUCTIONS` 要求新任务先调 `team_context`。
  - 「成员能到哪些 MCP 工具」的平台过滤在 `agent-runtime/mcp-tool-visibility.ts`（`filterMcpToolIdsByPlatform`、`memberMcpToolIds`），`routes/mcp.ts` 只是转出；别在别处再写一份能力→工具表。

### Connectors (`connectors/` + `/api/connectors` + `/api/admin/connectors` + `mcp_call`)

- Greenhouse as an MCP client: one `mcp_call` tool (list / describe / call) reaches every connector; never one model tool per remote tool.
- Routes live at `/api/connectors` and `/api/admin/connectors`; never mount anything under `/api/mcp…` (the MCP server owns that prefix).
- The OAuth callback `/api/connectors/oauth/callback` is in `PUBLIC_PATHS`; it trusts only the stored state row, never the query.
- Remote servers only (Streamable HTTP / SSE); never spawn a local process. Every connect goes through `connectors/network.ts` (public addresses only unless `private_network`; loopback only in dev/test).
- Secrets are write-only: `shared_secret` / member keys / OAuth tokens are sealed, never returned, never logged; errors pass `redactSecrets`.
- Changing a connector's url or auth wipes every member credential in the same transaction (`manage.ts`).
- The directory (`directory.ts`) is an in-memory snapshot reloaded after every write; `connectorDirectoryVersion()` is part of the `/api/mcp` context cache key.
- Tool switches: read-only on by default, everything else off; destructive tools always take mcp_call's preview → `confirm` round trip.
- Automations never run destructive tools; `/api/agent` and browser-extension sessions never get `mcp_call`; Feishu bot denies it.
- On `/api/mcp` (group `connectors`): writes need `mcp:write`; a connector with a team credential (or none) also needs `allow_external_writes`.
- Every call writes an `audit_events` row (app `connectors`) without arguments or content; every write also records a `connector_write` run, shown in the Activity log under module `connectors`.
- Agents' `connectors` field holds connector ids (null = all); `connectorsForUser` applies it.
- Tests use the local fixture server (`connectors/__tests__/fixture-server.ts`); never a real third-party endpoint.

### Team context and data catalog

- Core context is Markdown in `team_context.{overview,conventions,glossary}_markdown` (type text); timezone stays core. Optional document sources register through teamContextSources and preserve legacy selections.
- MCP templates/resources come from active mcpResources providers. The host gates by reachable tools; each provider rechecks capabilities and record ACL. Existing protocol names stay with their owner.
- PUT /api/admin/team-context accepts independent Markdown/timezone and legacy document selections; omitted fields are preserved. All writes use the existing settings validation/audit path. Timezone changes call active workspaceTimeZoneChanged hooks.
- The existing data catalog consumes active catalogSources and reachable tool metadata only. Core knows no application id.
- File cabinet operations stay core. An active driveScopes contribution may select its legacy cabinet; otherwise use core scope drive. Scope placement and occupied-folder checks come from their owner.

### Retro plugin

Monthly reviews and their schedule belong to [plugins/retro](../../../plugins/retro/AGENTS.md). Core exposes only aggregate usage and timezone hooks.

### 模块用量计数（`usage/counters.ts` + `/api/usage` + `module_usage_daily`）

- 只计数：每日 `(day, kind, key, client)` 合计，不记用户、参数或内容。v1.4 起计数，用来判断冻结模块的去留（1.5 据此移除了桌面端；历史计数里的 `desktop` 等 client 仍可读）。
- **计数永不失败、永不拖慢**：一律走 `countUsage()`（不 await，写失败只 `logger.warn`，`getDb()` 同步抛错也吞掉）。新计数点别直接 `await db.usageCounters.increment()`。
- 工具调用只在真实执行边界计一次：`countToolCalls(tools, client)` 克隆 per-turn 工具表包 `execute`（不改共享 registry）；MCP / Agent API 在 `executeProxyTool({ usageClient })` 里所有检查通过后按规范 id 计（旧别名记成 `knowledge_query` 等，被拒的调用不计）。
- client：Chat 按会话 channel（`feishu`；`browser` 只出现在 1.5 前的历史会话里），否则看 `X-Greenhouse-Client` 头（`mobile`），否则 `web_chat`；`runAgentInSession` 的 `toolCallClient` **必填**（`automation` / `feishu`；历史计数里还有已退役的 `subagent`），与 `usageContext` 同理，免得新 headless 调用方悄悄漏计；Agent API 默认 `agent_api`，移动端带头时记成 `mobile`。桌面壳记 `desktop`；历史 `browser` 计数仍可读。
- Chat 的计数包在 Runtime 证据包装**里面**（只有真正进入工具才计），并且只包目录工具：Client Action 的名字由浏览器声明，**绝不能**成为计数 key。
- `X-Greenhouse-Client` 只是标签，永远不是鉴权输入（CORS 已放行该头）。
- `POST /api/usage/page-open {module}`（内部用户，限流 240/分）：module 必须是 `PAGE_MODULE_IDS` 或当前启用扩展的 `ext.<id>`（`isPageModuleId`），否则 400；client 取头（`mobile` / `desktop`），缺省 `web`；写失败仍回 202。
- 读侧 `GET /api/admin/usage/modules?days=7|30|90`（super）：工具调用与页面打开（按 key × client）+ `usage_events`（`kind='model'`）按模型的缓存命中率 `sum(cached_tokens)/sum(input_tokens)`；其它天数 400。

### 生图 (`generate_image` 工具)
- `tools/generate-image.ts` 的 `generate_image`（surface `proxy:'write' + mcp:'services'`，`is_global`）是唯一生图入口：gpt-image-2。Chat 里落 `storage/uploads.ts`（COS/本地），经公开的 `GET /api/upload/:id` 内联渲染（`presentation:'artifact'`）。**外部面（/api/mcp、/api/agent）上是写**（v1.6）：`saveTo:'files'`，图作为新文件存进成员云盘的个人架（`uploadCabinetFile`，审计照记），结果给 `file_id` 和 5 分钟预签名链接（本地存储没有链接）；MCP 上走 `governProxyWrite` 留痕，`/api/agent` 要 `confirm:true`。付费调用和其它服务同在 `mcp:services` 组，用户可以只给读、拒绝付费以外的东西。
- 生图走统一计价（见「服务与计价」）：`image_generation` 服务，provider `media`；按 services.yaml 的尺寸价（`low` 档）预留，provider 报了 token 用量且声明了 `token_price` 就按 token 结算；不带 size 的 edit 保持原图比例、事前不知道尺寸，按最贵尺寸预留与结算。事实写 `usage_events`（`kind='service'`，tokens 进 `detail`），不写 `kind='model'` 行。旧的 `USAGE_BUDGET_*_IMAGE_USD_MICROS` 已不读。
- **单模型、单渠道、单质量档**（2026-07-27 起）：`IMAGE_MODEL`（默认 gpt-image-2）经媒体端点，**固定 `low`，schema 里没有 `quality` 参数**。medium/high 分别是 low 的 ~8x/~33x 成本，而模型判断不了这钱该不该花；要更精细先加大 `size`。zod 会 strip 未知字段，所以老调用方继续传 `quality` 不报错、静默降到 low。GLM 兜底与 `GLM_IMAGE_*`/`GPT_IMAGE_*` env 已一并移除。
- 上游 env 为 `MEDIA_API_KEY`/`MEDIA_BASE_URL`（见 `llm/media-provider.ts`，未配置时回落 `LLM_API_KEY`/`LLM_BASE_URL`，识图与生图共用一个 OpenAI 兼容端点）。**生图可以单独搬到 `IMAGE_BASE_URL`/`IMAGE_API_KEY`**（`getImageProviderConfig`）：默认模型原生识图之后，常见部署是「识图留在 LLM 端点、生图走图像供应商」（如 DeepSeek + 302.ai 的 gpt-image-2）。这一对**必须成对配置**——设了 `IMAGE_BASE_URL` 没设 key 直接报错，只设 key 不设 URL 则忽略；key 永远只发往它自己的那个 URL，绝不把 LLM/media 的 key 带去别家。响应可能**同时带 `b64_json` 和 `url`**，`persistImage` 优先取 base64：既少一跳，也不依赖上游托管 URL 从服务器可达。
- 审计走统一的 `mcp:tools/call`（`recordMcpAudit`，`meta.tool` 记工具名、**不含 prompt**）；旧的 `/api/images` REST 中转与其 `image.generate` 专项（含完整 prompt）审计已于 2026-07-23 移除。low 档实测 20–30s，超时上限 180s——同步 MCP 调用会挂住整个请求，反代读超时要盖过上游耗时。
- **`size` 只有三个合法值**（`1024x1024` / `1024x1536` / `1536x1024`）：其余取值上游**既不报错也不修正**，会返回一个谁也没要的分辨率。实测 low 档传 `1080x1080` 拿回 `1254x1254`／863KB，同画面 `1024x1024` 只有 121KB——白白 7 倍体积，还掉出 `COST_USD_BY_SIZE` 导致成本显示为空。`resolveSize()` 按长宽比 log 距离归一到这三个之一（`auto`/缺省→默认横图），归一时结果里回传 `requested_size`。**别放宽 zod 的 regex 就当支持了**；旧技能原来推荐的 `1152x1536`/`1536x864`/`864x1536` 全是不存在的尺寸，已在 skill 0.5.0 修正。
- **要求「用真 logo」时必须传 `images`，不能靠 prompt 描述**（2026-07-28）：`action:'generate'` 也吃 `images` 了，带参考图就自动改走 `/images/edits`——那是 gpt-image-2 唯一能吃参考图的端点，`/images/generations` 会把它们静默丢掉。该端点**独立于参考图尺寸地遵守 `size`**（实测 4218×1723 的 logo 进、1024×1024 海报出），所以 `size` 必须一路透传，否则合成图会继承素材的比例。起因：让 Agent 按品牌规范出海报，它读了 `brand/foundations/logo` 却在 prompt 里描述「三叶嫩芽 mark」让模型重画，而那篇文档明写 logo **永远不重绘**——它当时没有别的选择，参考图只能通过 `action:'edit'` 传、而 edit 的描述写的是「用户上传的图」。品牌素材就在知识库里（`brand/foundations/logo` 等文档内嵌 `/api/upload/<id>`），工具描述现在直接指路。

### 服务与计价（`usage/metering.ts` + `config/services.yaml` + `/api/admin/metering`，v1.6）

- **一条计价路径**：每个花团队钱的外部调用都过 `usage/metering.ts`——模型（chat、自动化、飞书机器人、标题、摘要、记忆整理、`call_llm`、知识库 AI、`analyze_image`）经 `reserveUserTokenBudget` 进来（token 账户并行保留一版），生图 / 搜索 / 读网页直接用 `reserveSpend` / `meterServiceCall`。新的付费调用必须走这里，别自己记账。
- **三级 USD 预留**：provider I/O 前对 member（`user`）+ `service` + `organization` 三个当月 `usd_micros` 账户原子预留（一个 group，幂等键 `<token key>:usd`）；成功按实际价结算；只有确认 I/O 尚未开始的失败才 release，I/O 可能已开始的一律留给 TTL sweeper 按预估计费。USD 是主限额。
- **价目**：默认价在 models.yaml `price`（每百万 token 美元：input / output / cached_input）与 services.yaml（服务与 provider 是封闭清单，拼错启动即报错）；super 在「服务与计价」页定的价存 `prices`，按模型或「服务 × provider」整条覆盖文件价（按 token 计的模型 / 识图填 input+output(+cached)，按次 / 张 / 分钟的服务填 `unit_price`，生图的覆盖价是不分尺寸的单张价）。代码里不猜厂商价格。覆盖在进程内缓存，`syncPriceOverrides()` 在每个计价入口刷新（写入后立即刷新，其他进程 30 秒内跟上）。**按结算时的价计**：调用中途改价，按新价结算；每条事实的 `price_applied` 记下结算用的价（来源 + 费率），之后再改价不会改写历史。缓存命中按 `cached_input` 计（缺省同 input），输出含 reasoning。**未定价 = 成本未知**：照常记事实、`cost_usd_micros` 为 NULL、不预留、按 0 计，管理页标「未定价」，绝不因缺价拒绝；但账户已用完时零成本调用一样被拒。`price: 0` 是「免费」，和未定价不是一回事。
- **限额解析**：`budgets` 的 `kind='limit'` 行（管理页写）→ env（`USAGE_BUDGET_MEMBER/ORG/SERVICE_MONTHLY_USD_MICROS`）→ 内置默认（成员 $50、团队 $2,000）。服务没有自己的行也没有 env 时跟随团队解析后的限额（行 / env / 默认），此时服务账户不单独发告警，拒绝文案说团队额度。默认值只是起点，每个部署上线前由管理员复核。每次调用都把当前限额写进当月账户（`update_existing_limit`），改额度下一次调用即生效。
- **组织付费的调用**（没有成员，目前只有每月复盘的建议）：`createOrganizationAttemptBudgetHook`（`llm/usage-budget.ts`）→ `reserveSpend({ organizationOnly: true, client: 'system' })`，只记服务与组织账户；别用它绕开成员预算。
- **归属**：`runWithMeteringScope({ userId, client, oauthClientId, sessionId })` 在入口设一次——Chat（`bindMeteringScope` 包工具 + hook 显式 `client` + 标题 / 摘要包在 scope 里）、`runAgentInSession`（client 由 `toolCallClient` 派生）、MCP `tools/call`（`client:'mcp'` + OAuth client id）、Agent API（`executeProxyTool({ metering })`）。只建一次的共享工具（web search）只能从 scope 知道是谁在花钱；新入口漏设 scope 会记成「无成员」并 warn。client 词表在 `@greenhouse/types/metering`（`METERING_CLIENTS`），由 tool-call client 映射（`web_chat`→`web`）。
- **超额契约**（`usage/budget-errors.ts`）：拒绝发生在 I/O 之前，`UsageBudgetAdmissionError(429, 'usage_budget_exceeded', refusal={unit:'usd_micros', level, service?})`，`message` 是中英双语、Agent 可读的「本月…额度已用完…联系管理员」。MCP 原样作为 tool error（`isError:true`）返回；工具（生图 / 识图 / call_llm）遇到它必须重新抛出而不是吞成 `{error}`；读网页被拒只在搜索结果里加 `notice`；Chat 的模型调用被拒用 `localizedBudgetNotice` 单语显示；自动化记成失败原因（`budgetRefusalReason`）；Agent API 回 429。
- **告警**：结算或拒绝后检查涉及的 USD 账户，越过 80% / 100% 发 `budget_attention` 通知（成员账户发给本人，服务 / 团队账户发给所有在职 super），按「账户（含周期）× 阈值」去重，只发最高到达档；写完调 `queueMobilePush()` 并推 WS。限额为 0 是主动封禁，不发告警。告警失败只 warn。
- **审计**：改预算、改价都写 platform 审计（`updateBudgetLimit` / `removeBudgetLimit` / `updateServicePrice` / `removeServicePrice`，`summary.detail` 是一行可读描述），在操作记录里显示为管理员改动（`activity/activity-log.ts` 的 `ADMIN_ACTIONS.settings`）。
- **读侧**：`GET /api/admin/metering/overview?month=`（super）与 `GET /api/usage/spend`（只看自己）由 `usage/report.ts` 组装，花费读 `usage_events`（`kind` 为 `model` / `service`，不含 `audit`）的单月区间（按 `created_at` 索引），预算余额读账户；「按预估计费」是 TTL 过期预留的金额，只在账户里、不在逐次事实里。
- **已知行为（有意为之）**：
  - sweeper 把过期预留按预估转成已花时不发告警，下一次结算或拒绝会补上阈值通知；这部分金额不进逐次事实，只在页面「按预估计费」里出现。
  - 搜索请求发出后失败（含所有 provider 都报错），预留不释放，5 分钟后按预估计费——遵守「结果未知按预估」，不赌 provider 不收失败请求的钱。
  - 进入计价时 scope 里没有成员的调用，只记到服务与团队账户并 warn；已知入口都会设成员。
- **蓝绿并存**：旧代码在新库上照跑（列全可空）；旧的生图代码仍按 `$20` 把成员 USD 账户限额改回去，切流期间会和新代码来回改，切完即止。

### 模型网关（`routes/gateway.ts` + `gateway/`，v1.6，D4）

- 成员自己的 Agent 用团队模型额度，两个线协议、一套 Key / 计价 / 规则（共用部分在 `gateway/proxy.ts`）：
  - OpenAI：`GET /api/gateway/openai/v1/models`、`POST …/chat/completions`（流式与非流式，tools / response_format 原样透传）。
  - Anthropic（Claude Code 的 `ANTHROPIC_BASE_URL=<origin>/api/gateway/anthropic`）：`GET /v1/models`、`GET /v1/models/:id`、`POST /v1/messages`（流式与非流式，`?beta=true` 照转）、`POST /v1/messages/count_tokens`（本地估算 `{input_tokens}`，不调上游、不计价）。
  - 没有 Responses / embeddings / images，别在文案里说有。当前 Codex（codex-cli 已删 `wire_api = "chat"`，只走 Responses）接不上，接入指南不给它配置。
- 鉴权：ghgw Key，`Authorization: Bearer` 或 `x-api-key` 都收（Claude Code 的 ANTHROPIC_AUTH_TOKEN / ANTHROPIC_API_KEY）；库里只有 SHA-256 + 12 字符前缀。`/api/gateway/` 在 `isPublicPath` 里（带尾斜杠，别的路由不许叫 `/api/gateway…`）；CORS 在 `security.ts` 对它关闭；请求体上限 4 MB；限流走 `checkRateLimit`：每 IP 600/分，每 Key `GATEWAY_RATE_LIMIT_PER_MINUTE`（默认 300，Claude Code 一轮就有很多次调用）。上游有两只钟（`UpstreamLifetime`，每条路径结束都要 `done()`）：整次调用（等响应头 + 读 body）`GATEWAY_UPSTREAM_TIMEOUT_MS`（默认 10 分钟），流里两个 chunk 之间 `GATEWAY_UPSTREAM_IDLE_TIMEOUT_MS`（默认 2 分钟）；超时中止上游、预留按结果未知留着，还没开始流就回 504 `upstream_timeout`，流已开始就写一个线协议格式的错误事件再结束。流被上游打断（读出错，或没有 `[DONE]` / `message_stop` 就结束——无终止符时以「有 finish_reason + 末尾 usage」/「收到最终 message_delta」为完成）同样补一个 `upstream_interrupted` 错误事件（OpenAI 是 `data: {"error":…}`，Anthropic 是 `event: error`）；上游自己已经发过 error 事件就不再补。结算规则不变。
- 工作区开关 `gateway.enabled`（`boolean` 型 workspace setting，按「库里的覆盖 → env `GATEWAY_ENABLED` → def `defaultValue`（缺省 false）」解析；`getWorkspaceFlagState` 给出 effective / override / fallback / source，设置视图的 `flag` 带 effective + fallback，管理界面一律显示生效值而不是「有没有存 true」，所有布尔开关通用）：关着时所有网关端点 403 `gateway_disabled`，成员也建不了 Key（撤销照常）。
- 模型解析：只认目录 id（`getModelRegistry()`，没有别名）；Key 的 `allowed_models` 不含则 403；目录里没有 404；这条线协议上没有可用上游则 503。OpenAI 线 = 第一个配了 key 的 `openai` / `deepseek` / `openai-compatible` provider；Anthropic 线 = 第一个配了 key 且在 models.yaml 声明了 `anthropic_base_url`（或 `anthropic_base_url_env`，不含 `/v1`）的 provider，同一把凭证、同一个 model 名，上游 key 以 `x-api-key` 发出。不跨 provider 回退。转发只带上游 key、content-type / accept，以及（Anthropic 线）客户端的 `anthropic-version` / `anthropic-beta`——其余请求头（含 ghgw Key）一概不带。
- 计价走 `reserveUserTokenBudget`（caller / profile `gateway`，client `gateway`，service `llm`，幂等键 `gateway:<keyId>:<uuid>`，预留 metadata 带 `gateway_key_id` 与 `wire`），事实行 `usage_events.gateway_key_id` 记 Key（每把 Key 的本月花费从这里汇总）。预留 = 输入估算（×1.25，内联图片 / 文档按块 1500）+ 输出（OpenAI：请求的 max_tokens / max_completion_tokens，否则目录 max_tokens，否则 16k，× n；Anthropic：必填的 max_tokens；都不超过 context window）。结算：OpenAI 非流式读 `usage`，流式强制 `stream_options.include_usage` 从末尾 usage chunk 结算（客户端没要就去掉只含 usage 的 chunk）；Anthropic 读 `message_start` 的 usage + `message_delta` 的最终 usage（收到 `message_delta` 才算有结果），input = input_tokens + cache read + cache creation，cache read 按 `cached_input` 价、cache creation 按 input 价。上游 4xx 与连不上（ECONNREFUSED / ENOTFOUND）= 明确没花钱 → `releaseAfterProviderRefusal`；客户端断开（中止上游）、5xx、成功却没 usage = 结果未知 → 预留留给 sweeper 按预估计费。
- 错误用各自线协议的形状：OpenAI `{error:{message,type,code,param}}`，Anthropic `{type:'error', error:{type,message}}`。超额 429，message 是 `budget-errors.ts` 的中英双语原文（OpenAI `type:'insufficient_quota'`、`code:'usage_budget_exceeded'`；Anthropic `rate_limit_error`——Claude Code 会按 429 重试几次再把原文显示出来）。上游错误文本（含流内 error 事件）经 `sanitizeUpstreamText` 才给成员；上游 401/403 不透传原文，只说「凭证被拒，找管理员」。
- Key 管理：成员 `GET /api/agent-access/gateway`（含两个 base URL、每个模型在哪条线可用、每把 Key 本月花费）、`POST /gateway/keys`（密钥只在 201 响应里出现一次；每人最多 20 把可用的）、`DELETE /gateway/keys/:id`；super `GET / DELETE /api/admin/metering/gateway-keys`。审计：`createGatewayKey` / `revokeGatewayKey`（操作记录里本人的 mcp 改动）、`revokeMemberGatewayKey`（管理员改动），summary 只有名称、前缀、模型、过期时间，不含密钥。
- 外部 Agent 以成员身份调用，没有审批关卡（产品规则）；用量出现在「服务与计价」与「设置 › 用量」的 client `gateway` 下。
- **待办：Codex 需要的 `/responses`（OpenAI Responses API）转换**，设计要点：
  - 端点 `POST /api/gateway/openai/v1/responses`，把 Responses 请求翻成 Chat Completions 发给现有上游：`instructions` → system，`input` 的 message / `function_call` / `function_call_output` 项 → messages 与 tool_calls / tool 消息；`tools` 里只有 `function` 能翻，`custom`（Codex 的 freeform apply_patch）、`web_search`、`local_shell` 等内置工具要么拒绝要么在网关侧另做，必须先列清 Codex 实际发的工具。
  - 流式要把 Chat chunk 重新组装成 Responses 事件序列（`response.created` → `response.output_item.added` → `response.output_text.delta` / `response.function_call_arguments.delta` → `…done` → `response.completed` 带 usage），`item_id` / `output_index` / `sequence_number` 自己编号；reasoning 项（DeepSeek `reasoning_content`）可映射为 `reasoning` 输出项或丢弃。
  - Codex 默认 `store:false` + 每轮回传完整 input（含 `encrypted_content` 的 reasoning 项）；网关不存状态，`previous_response_id` 一律 400。
  - 计价照本节规则（Responses 的 usage 由 Chat usage 换算），用真实 codex-cli 跑端到端再写进接入指南。

### 云电脑（`computer/` + `computer_*` 工具 + `/api/computer`，v1.6）

- 成员自己的托管沙箱（E2B），**工作区开关 `computer.enabled` 默认关**：关着时任何路径都不调驱动的 `create`（`ensureComputer` 第一步就拒），MCP 上 `computer_*` 不出现在 tools/list，调了也只回「云电脑未开启，请管理员在服务与计价里开启」（`externalToolUnavailableMessage`，在留痕之前）；每分钟的清扫把还在跑的停掉。开关是 `boolean` 型 workspace setting（与 `gateway.enabled` 同一套：覆盖 → env `COMPUTER_ENABLED` → `defaultValue:false`，经 `isComputerEnabled()` = `getWorkspaceFlag` 每次现读，管理页显示 `computerSwitchState()` 的生效值与来源）；E2B key / template / domain、同时运行上限 `computer.max_running`（默认 5）是字符串设置（env 回落 `E2B_*` / `COMPUTER_MAX_RUNNING`），运行时读 `process.env`。
- 每个成员最多一台：首次用时建（`computer_exec`、`computer_transfer` 拷入），用完 15 分钟空闲即停、可手动停；停了就是 kill，**里面的文件一并没了**，要留的先存进云盘。读（`computer_files`、存出到云盘）从不建机。整个工作区同时运行台数超限时明确拒绝。状态在 `member_computers`（迁移 0012），每次转换 compare-and-set。
- 计价（`computer` / `e2b` / 分钟）：按 15 分钟一块预留 USD；跨块时清扫先预留下一块（被拒即停机）、再整块结算上一块；停机按实际分钟（向上取整）结算当前块。行上只存当前块的预留键，任何进程都能用 `restoreSpendLease` 结算。多进程并发：每块的预留键固定为「电脑 + 块起点」（`blockBudgetKey`），同一块只有一次准入判定，已存在的预留按原账户、原周期、原预估恢复（崩在预留与安装之间、跨月或改价后重试都不会撞 idempotency 冲突）；滚块是对当前键的 compare-and-set，抢输的一方只在电脑从未到达那一块时（`block_started_at` 仍更早，停机不会清它）才释放预留，`lost` 电脑最后一块已入账的预留一律留给 TTL；停机按调用方看到的事实做条件认领——预算拒绝只在它评估的那一块仍是当前块时才停，空闲停机只在 `last_used_at` 仍早于空闲截止点时才停，拿着过期快照的一方什么也不停。新电脑和每次心跳都把 provider 的 kill 截止时间推到「本次操作 + 空闲窗口」之后。结果未知照规则走：create 可能已到 provider、或 kill 没得到确认（行记 `lost`），预留都留给 TTL 清扫按预估计费；provider 明确拒绝的 create 才释放。
- MCP：独立资源组 `mcp:computer`（不并进 `services`：能跑任意代码、能上网，和付费查询不是一种授权）。`computer_exec`（写，命令 ≤10 分钟，输出各截 200KB，长回复走 `tool_output_read`）、`computer_files`（读：list / read ≤1MB）、`computer_transfer`（写：云盘 → 电脑 ≤25MB；电脑 → 云盘 ≤5MB，默认个人架）、`computer_stop`（写）。写走 `governProxyWrite` 留痕，`openWorldHint:true`。
- 后续（不在 1.6）：停机 = kill 是有意的简化；要让文件跨停机保留，改成 pause/resume（E2B 支持，v2 的 adapter 已经写过：停 = pause、用 = connect 唤醒、计费只算运行分钟，另需处理暂停沙箱的存储成本与清理）。在那之前，工具描述和设置页都写明停机即删文件、先用 `computer_transfer` 存进云盘。
- 仅外部面（`surface.externalOnly`）：`web_search`、`read_url`、`computer_*` 只在 `/api/mcp` 和 `/api/agent` 上建；`GET /api/tools`、权限弹框的基础工具、Agent 编辑器的工具校验、按人分配工具都用 `getInAppToolIds` / `getInAppToolMetas` 把它们滤掉，应用里不出现「Chat 用不了的工具」。
- 驱动：`computer/e2b/` 从 v2 的 `packages/providers/src/sandbox/e2b` 搬了控制面（create / connect / timeout / kill，纯 HTTP）和 envd 进程 API；文件改走 envd 的 `/files` HTTP 接口（v2 走自己的 bridge，stock 模板没有）。没搬：桌面 / 浏览器 / VNC / DevTools bridge、pause/resume、备份、自定义模板、每 Agent 一台、出网 nft 规则（stock 模板里成员本来就能 sudo，沙箱里不放任何 Greenhouse 密钥）。沙箱建时关公网入站、在 provider 边缘拒私网段。测试一律用 `setComputerDriverForTests` 的假驱动，不连 E2B。
- 网页：设置 › 云电脑（成员：状态、本月分钟、开 / 停）；服务与计价的 `computer` 行显示开关 / 已配置 / 每分钟价，并列出正在运行的电脑（管理员可停，审计 `stopMemberComputer`）。

### 数据保留（`upkeep/retention.ts`）

- 每日清理高增长表：规则只在 `packages/db/src/services/retention.ts`（`db.retention.run()`），这里只管调度与记账。窗口见 [db-schema.md](../../../packages/db/src/db-schema.md)「保留期」。
- `scheduleRetention()` 在启动 10 分钟后首跑、之后每天一次；审计里 20 小时内已有一次就跳过，所以蓝绿双槽或多副本每天只清一次，重启也不重跑。
- 每次运行写一条 `audit_events`（`app_id='platform'`、`action_id='retentionCleanup'`、actor `retention` / `system`），summary 是各表删除行数；永不抛错。
- 过期 rate-limit 桶、登录 state、MCP 输出仍由 `index.ts` 的五分钟 upkeep 清扫，不挪进这里。

### 成员偏好与 Agent 头像（`/api/me/preferences`、`/api/agent-access/connections`）

- `GET / PATCH /api/me/preferences` 读写 `users.preferences`（`fontScale` 0.9 / 1 / 1.1 / 1.2 / 1.35，zod 校验，未知键 400），跟账号走不跟设备；写入经 `db.users.mutatePreferences()` 的行锁。`surface.workbench` 是 3.0 起被忽略的废弃字段（4.0 删）。
- 成员可给每个已连接的 Agent 选植物头像 `{plant, tint}`（`@greenhouse/types/agent-avatar`）：存 `oauth_grants.avatar`，`GET /api/agent-access/connections` 返回，`PATCH /api/agent-access/connections/:clientId` 设置，null 恢复客户端默认。

### Agent Profiles
- Profile YAML 文件放在 `profiles/` 目录
- 架构、工具矩阵、设计决策详见 [agent-profiles.md](./profiles/agent-profiles.md)
- Profile 变更时同步更新该文档

### Plugin host
- New modules are workspace packages under `plugins/<id>`; API production imports use `@greenhouse/api/extension-kit` (snapshot-locked).
- `extensions/index.ts` combines generated packages with the SDK 1 in-tree overlay list; every existing active registry still uses `EXTENSIONS`. Never import plugin code from core.
- `/api/admin/plugins` is super-only and read-only. CLI list/status share its operator model; hook failures still abort startup, and boot facts are process-local.
- Plugin drop is disabled-only + `--yes`, handled by the DB migration lane under its lock; never CASCADE into another plugin or core.

### Official plugin ownership (4.0, wave 2a)

Memory and Feedback are default-on packages; Reports and Computer are compiled but default-off.
Their schemas, DB services, routes, tools, jobs, classic web panels, translations and seeds live
under `plugins/<id>/`. Core must consume their contributions, never import their source or add
module-specific cases. The generic seams are `promptContext`, `toolAvailability`, `billableServices`,
`settingValidators`, `activity`, `summarySources`, `seeds`, and `retention`; web adds `tabs` and `slots`.
`services` remains the DB factory; `billableServices` is the price catalog contribution.
Tools may declare `meta.builtin`; this widens only the profile filter, never member permissions.
External-only plugin tools are constructed only by the external service-tool builder.

`conversations.sharing` defaults to true in greenhouse.config.ts. False disables share mutations and
session-share routes, returns empty `/api/shares` lists, hides classic sharing controls and removes
access granted by stored shares. Existing share rows are preserved.

### Communication plugins (4.0, wave 2b)

- Email, WeCom and Feishu are compiled packages, disabled by default. Env variables alone never activate them; boot logs one info hint per disabled configured package.
- `notificationTransports`, `notificationKinds`, `identityProviders` and `channels` aggregate through `fromExtensions`. Core retains the durable inbox/worker, push, login states, provider connections, account eligibility and binding uniqueness policy.
- Notification kinds and delivery channels are validated at the DB service boundary against the active registries; reads preserve historical kinds even when their plugin is off. Downstream kinds use `ext:<id>:<kind>`.
- `GET /api/auth/providers` is public, read-only discovery (`id/title/icon/login`), without minting OAuth state. Provider callbacks authenticate with single-use state; start/binding routes retain their internal-user guards.
- Kits expose `channelAgentRuntime()` and `runAgentTurn()`. These load the catalog after extension activation; never eagerly import the tool registry from a plugin or a kit export. Sequential loading avoids circular async evaluation.
- `surface.unattendedDenied` makes a plugin tool unavailable to every unattended path, before replay-safe/opt-in tool grants. It does not change its interactive proxy/MCP surface.

### Agent context and data-plugin hooks (4.0, wave 2c)

- `agentContext` is appended through the stable prompt-context assembly after profile/user context, before the rolling digest. Only actual reachable plugin tools admit it; each fragment is capped at 2000 chars. Never put time/page/turn-dependent text there.
- Its resources are listed/read through MCP and included in team_context, with the same per-request reach gate. Prompts use ext-<id>-<name>; explicitly declared legacy prefixes preserve existing protocol names. Dynamic catalogues return the same typed prompt entries and recheck download access on render.
- Saved prompt persistence, rendering and My prompts remain core. Chat grants reach them independently; SkillHub contributes compatibility access for existing skills grants via the core saved-prompt facade.
- Projects contributes platform registration, feature point, MCP group, legacy entity kind, search, objectRefs and recentChanges. Its policy and title rules are documented in [plugins/projects/AGENTS.md](../../../plugins/projects/AGENTS.md). No core import of its service/schema is permitted.
- Plugin-owned route limits register through rateLimits; core keeps admission counting and prefix matching. Their defaults/internal overrides retain the previous security meaning.


### SDK 2 data/runtime host

- SDK 2 writes intersect the declaration and the member's kernel field policy. IDs and created/updated/deleted timestamps (including mapped columns), internal/confidential/restricted fields and `writable: false` are never client input, including for super. Owner/member fields require explicit `writable: true`, a field write grant and the action capability. Validate before stamping the effective owner on create; reject all unknown/forbidden keys with 400 and field names. REST, mutation tools, direct runtime dispatch and station `writable` metadata share these rules even when stored policies predate them.
- `extensions/data-sources.ts` expands `dataSources` into existing registries;
  `data-runtime.ts` is the common generated REST/tool/search/export/peek executor.
  Table scopes apply before paging/counts; field projection and action authorization
  apply on every transport. `audit: writes` skips successful reads only.
- Custom commands use kit `recordWrite`; notification facts use kit `notify`.
  Producers emit lifecycle observations only after committed writes. The five-event
  bus runs handlers asynchronously with isolated 5s deadlines; no request awaits them.
  Runtime terminal observations come from the committed outbox and are at-least-once.
- Run `onInstall` through `extensionMigrations.installOnce` after the migration lane
  and before boot hooks. Marker writes are locked; failed/crashed hooks must be safe
  to retry. Static plugin UI has its own same-origin frame CSP; its API stays guarded.
- `station-manifest.ts` cuts pages/nav/entity fields/actions to the member and keeps
  the 3.x response fields. Pure `surfaces` metadata belongs to each plugin manifest;
  core must never add cases for official plugin ids.

### Embed authentication and hosting (4.0, wave 4)

- `POST /api/ext-ui/token` requires a current internal session and a member-visible plugin. A separate signing purpose binds credentials to member, auth_version and plugin for ten minutes. Recheck account and plugin access on every call. Only `/api/ext/<id>/*` and basic `GET /api/me` (id/name/role) are admitted; the host's session renews them. Scope enforcement precedes public bypass and SPA hosting. Plugin route guards still apply.
- Public plugin UIs mount before ordinary auth and SPA fallback; disabled plugins/missing files return 404. Assembly resolves manifest `ui: './ui'` inside its package, preferring `ui/dist` when built. HTML and mutable files revalidate; fingerprints are immutable. SDK 1 `ui: {dir}` remains compatible.
- Plugin CSP permits frame ancestors `'self' tauri://localhost`. Omit X-Frame-Options there because SAMEORIGIN blocks the installed shell; other responses retain DENY. CORS includes only the exact desktop origin by default plus existing env additions.
- `X-Greenhouse-Client: desktop` labels usage counters and USD metering like mobile. It never changes authentication, permissions or the stored conversation channel.

# Feishu official plugin

Disabled by default; enable `feishu` in `extensions.enabled` or `GREENHOUSE_EXTENSIONS` and restart. Preserve existing env names, URLs, tool ids and stored preference keys. Production imports use only extension kits, shared types and declared dependencies.

### 飞书（`api/` + `/api/feishu` + `notify_feishu` + 扫码登录）

形状与企微一节完全同构（群机器人 `plugins/feishu/api/webhook.ts` 的 `sendFeishuMarkdown` 无状态发群，`api/client.ts` 有状态发 DM；未配置整块隐藏；绑定存 `provider_connections(provider='feishu')`、`access_token_enc` NULL；一个飞书身份一个账号；DM 收件人只从绑定派生）。方案与决策（D1–D10）见 [spec](../../docs/specs/20260824-feishu-oauth-and-push.md)。企微没有而飞书有的三件事：

- **绑定走 OAuth 而非邮箱匹配**（Greenhouse 邮箱与飞书邮箱不一致），存的是 `open_id`；user access token 换完 user_info 即弃，任何飞书凭证都不落库。
- **绑定与登录共用一个 callback**（`/api/feishu/oauth/callback`），按 state 里的 `intent` 分流——飞书后台每条重定向 URL 都要登记，单 callback 少登记一条。bind state 绑死 userId；login state 不绑，命中绑定后发 **60s 单次消费的兑换码**回 `#/login?feishu_code=...`，前端 `POST /oauth/exchange`（公开 + IP 限流）换正常会话——**复用 `routes/auth.ts` 导出的 `issueUserSession`**，不长第二条签发路径；长期凭证永不进 URL。未绑定 → `not_bound` 引导先密码登录再绑定；**不自动建号**。
- **手机 App 登录**：`start-login?app_redirect=` 只接受 `APP_LOGIN_REDIRECT`（`greenhouse://auth/feishu`，与 apps/mobile app.json 的 scheme 对应，**逐字精确匹配**，其他一律 400，且在发 state 之前拒绝）；state 里记 `app: true`，callback 的兑换码与失败原因都回到这个地址，网页登录不受影响。OAuth 的 redirect_uri 仍是登记过的网页 callback。改地址要同时改 App（`src/login/feishu.ts`，有测试对照）。
- **三条公开路径**（`isPublicPath`）：`/oauth/callback`（浏览器重定向，state 是凭证）、`/oauth/start-login` 与 `/oauth/exchange`（登录页没有 Bearer 可带）。`/oauth/start` 与 `/binding` 仍要 Bearer，守卫写在路由文件内。护栏 `api/__tests__/oauth.test.ts` 直接断言五个路径的 `isPublicPath` 取值。
- **state 与兑换码在 `login_states`**：只存 SHA-256，`consume` 是单条条件 UPDATE（并发只有一个赢家），TTL 不变（state 10 分钟、兑换码 60 秒），过期行由五分钟 upkeep 清扫；重启不丢、多实例共享。回调里查 state 失败（库不可用）照样 302 回设置页（`reason=server_error`），不吐 JSON。tenant token 缓存仍在进程内存，多实例部署需换共享存储。DM 需应用开通「机器人」能力且收件人在应用可见范围内（`230002 user not visible to app` 就是范围没放开）。

### 飞书机器人对话（`api/bot/` + 长连接）

在飞书里 @机器人或私聊 = 用自己那个 Greenhouse Agent；跟着某条消息「回复」= 延续那次对话。**默认关闭**（`FEISHU_BOT_ENABLED=1` 才连）。方案与决策（D1–D10）见 [spec](../../docs/specs/20260825-feishu-bot-conversation.md)。

- **走长连接，不走 webhook**：`WSClient` 是我们主动连出去的，不需要给飞书开任何公网入站端点。飞书机房能否 POST 到 `:18888` 始终是未知数（OAuth 回调走通只证明**浏览器**能访问），长连接把它整个绕开，且**事件与卡片回调都收得到**。代价是**进程内单连接**——多实例部署前必须重新设计（同一 app 多条长连接会重复投递事件，与 `chat-runs` 内存注册表同款已知限制）。⚠️ 后台「事件配置」与「回调配置」是**两套独立订阅方式**，都要各自选长连接；只配一半时点卡片按钮报「目标回调服务当前未在线」。
- **会话键是一条回退链** `thread_id ?? root_id ?? message_id`（`bot/conversation-key.ts`，零 import 叶子模块）。一条链覆盖三种形态：话题群天然每话题一个会话、普通回复链按 root 聚合、首次发言用自己的 id 当未来的根。**别改用 `parent_id`**——实测它指向「被直接回复的那一条」，链上每条各不相同；而 `root_id` 恒定，正因如此用户回复链上**任意一条**旧消息都续得上，不必去找最后一条。
- **身份只认绑定表，不猜也不建号**：`open_id` → `provider_connections(provider='feishu')` → 用**这个人自己的权限**跑（`resolveEffectiveTools` 原样复用）。每条消息都重读账号，绑定后被禁用/降级立刻失效。未绑定回一张引导卡而不是沉默。
- **飞书面不是无人值守**（对面有真人在等），所以**不套** `UNATTENDED_TOOL_DENYLIST`；但另有一份 `FEISHU_DENIED_TOOL_IDS` 挡掉编排类工具（schema-plan/task-capture/call_llm）——它们的确认门是 Web 专属富卡片，IM 里没有确认按钮那道天然减速带，一句话就能起一个几十分钟、烧模型额度的任务。**两份 denylist 刻意分开**：那份禁的是「没人能按确认」，这份禁的是「这个交互形态承载不了」。
- **群里的回答带权限页脚**（「以 X 的权限查询，内容对本群可见」）。群可见性风险是已确认接受的设计，但要让它在每次发生时可见，而不是写在某个没人读的文档里。刻意不做「群里换一套更窄的权限」——那是第二套权限口径，且用户无法预知自己在群里能问什么。
- **`ask_user` 的问题必须从 `toolEvidence` 里捞出来渲染进正文**（`bot/ask-user.ts`）：它的 `presentation: 'artifact'` 让问题不进 assistant 正文，而飞书面只取 `result.text`——不渲染的话用户只看到一句引导语，**被问了什么完全不可见**（比「要回 Web 才能答」更糟）。刻意**不做卡片按钮**：IM 里打字回答本就最自然，正文渲染 + 既有的「回复」延续机制已经让「不离开飞书」成立，零新状态。⚠️ **截断只作用于正文、提问永远保留**——反过来会让长回答把结尾的问题整段吃掉，与附件 fence 被 `sanitizeForPrompt` 吃掉是同一个形状。
- **消息先认领再处理**（`feishu_receipts` 主键，保留 7 天）：飞书会重投，而处理一条消息 = 跑一轮 agent = 花钱且会回消息。
- **回答必须走 `replyCardMarkdown`（reply）而不是新发一条**：只有 reply 才让用户后续的「回复」保持在同一条链上、`root_id` 稳定；新发一条会开新链，用户每回复一次就换一个会话。
- 执行复用 `runAgentInSession`（与定时任务同一个 runner），`usageContext.caller='feishu-bot'` 归属发消息的用户、计入其月度配额。`channel='feishu'` 的会话**照常出现在会话列表里**——它是用户亲自参与的真实对话，与 workflow 那种引擎产物不同。
- 回复即延续要带上文：`priorMessages` 用 chat 同一套投影与 token 预算，滚动摘要也与 chat 同口径（见「Chat 上下文引擎」）。**只给会话主人回放**——群里别的绑定成员回复同一条链也落进这个会话，而主人可能在 Web 上接着聊过，那些轮次没发到群里，不能经别人的提问带进群；摘要同理只给主人。护栏 `api/__tests__/bot-history.db.test.ts`。
- 长连接连不上只 `logger.warn`，**绝不拖垮主 API**。


DB tables and services belong to this package; access them through `services(db)`, never DatabaseProvider fields. The adoption migration copies immutable baseline DDL with guarded creation/constraints. Disabled data stays intact.

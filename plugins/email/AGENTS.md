# Email official plugin

Disabled by default; enable `email` in `extensions.enabled` or `GREENHOUSE_EXTENSIONS` and restart. Preserve existing env names, URLs, tool ids and stored preference keys. Production imports use only extension kits, shared types and declared dependencies.

### Email（`api/` + `/api/email` + `email_query`/`email_mutation`）

个人邮箱绑定 + 共享 Greenhouse 邮箱 + automation 邮件送达，方案与决策（D1–D8）见 [spec](../../docs/specs/20260805-email-revival.md)。2026-07-22 在内部单一服务面收敛（`61efc4ab`）中整体删除，2026-08-05 按「底座找回 + 面层重写」找回。

- **只有一个 provider：通用 IMAP/SMTP**（`api/imap-smtp-client.ts`，imapflow 读 + nodemailer 发）。OAuth 一律不复活：服务器在国内，Gmail 的 OAuth 与 IMAP 端点同样要走代理、OAuth 无连通性优势，而它的 restricted scope 在 Testing 模式下 refresh token 7 天过期，app password 一次配置长期有效（D1）。Outlook 历史上从未真正跑通，不找回。
- ⚠️ **读信是全新实现，不是找回的**：本仓与 OSS fork 的所有历史版本里 `listMessages()` 都是「打个 warn 然后 return []」的 stub，IMAP 账号实际只能发不能读。**这里读失败一律 throw**——静默空数组会让 Agent 把「读不了」如实汇报成「收件箱是空的」，是最坏的失败形态。
- ⚠️ **文件夹名必须按 SPECIAL-USE 解析，不能字面 open**（2026-08-13 修）：IMAP 的文件夹路径是每台服务器自己的（`Sent` / `Sent Messages` / `&XfJT0ZAB-`），而模型只会说 `Sent`，于是 `getMailboxLock('Sent')` 在多数邮箱上直接失败、且只报一句 `Command failed`。`resolveFolderPath()` 的顺序是 精确路径 → SPECIAL-USE 角色（`FOLDER_ROLE_ALIASES` 含中英别名）→ 同名 → 都不中就报错**并列出该邮箱真实有哪些文件夹**（让服务器回一句 `Command failed` 是最没用的失败）。`listMessages`/`getMessage` 两处都必须走它。
- ⚠️ **`describeImapError` 要包在 `withImap` 的 catch 上，不是逐调用点**（2026-08-13 修）：imapflow 的所有命令失败都只说 `Command failed`，真实原因在 `err.responseText`。原先只有 connect 那一处包了，于是 list/search/fetch 的失败一路裸奔到 friction 队列。包在共用出口上，才不会有哪条 IMAP 路径因为漏写而丢掉原因。
- ⚠️ **ImapFlow 实例必须在 connect 前挂 'error' 监听**（2026-08-12 修）：`connect()` reject 不保证 socket 已拆——半开 socket 的 `socketTimeout` 稍后触发 `emitError`，此时没有 pending handler 就走 `emit('error')`，无监听器 = uncaught exception，**整个 API 进程被打死**。dev 上每次绑定失败都在 400 响应发出 ~15s 后崩一次进程（pm2 静默重启，所有用户的在飞 run 一起陪葬）。修法在 `imap-smtp-client.ts`：`guardImapClientErrors()` construct 后立刻挂、connect 失败即 `close()`；回归护栏在 `imap-smtp-egress.test.ts`。另外 imapflow 的命令失败一律只说 `Command failed`，服务器真实拒绝原因在 `err.responseText`——错误信息必须经 `describeImapError()` 透出，否则「密码错」和「协议错」对用户长得一模一样。
- **两种邮箱是刻意不同的东西**：personal = `email_accounts` 一行、属于某个用户、可发给任何人；shared = `SHARED_MAILBOX_ADDRESS`，**全部从 env 读、不在表里**（运维所有物，不随任何用户删除而消失；塞进 per-user 表要么伪造 owner 要么 user_id 可空，后者正是 `knowledge_base.user_id` 事故的形状）。聊天面 shared 仅 super 可解析，且收件人白名单 = 发起人自己的账号邮箱 + 共享邮箱所在域（`SHARED_MAILBOX_ALLOWED_DOMAIN`，默认取地址的域名）。
- **`mailbox` 参数收账号 id、`shared`，也收地址**（2026-08-18 补）：`list_accounts` 一行里同时给出 `mailbox` 与 `email_address`，模型两种都会传，而地址此前过不了数字解析、回的还是一句 `mailbox is required` —— 对一次**带着 mailbox** 的调用说「你没传」，模型只能原样重试。`resolveMailbox` 把地址**归一回账号 id** 再走原路径：所有权、禁用、共享邮箱 super-only 三道门一个不少（按地址点名共享邮箱同样受 super 门约束）。归一化不是顺手：draft token 存的 ref 会被 send 路径重新 `parseMailboxRef`，**只有 `shared` 与账号 id 往返得了**，所以 draft 存的是 `resolved.mailbox.ref` 而不是模型写的那一串。文案分两句由 `mailboxRefError()` 统一给：真没传才说 required，传了不认识就引用原值并指回 `list_accounts`。
- **发信只有一条路**：`api/service.ts` 的 `sendMail()`，顺序固定 归属 → 收件人策略 → 日限 → 附件预算 → 发送 → 审计。**收件人策略抽成 `checkRecipientPolicy()` 被 draft 与 send 共用**——draft 侧跑它是为了不给用户看一张按下去必被拒的卡，send 侧那次才是边界；分成两份就等于卡片能承诺发送路径不允许的事（浏览器验收时抓到的：原本只在 send 校验）。
- **`send` 发的是服务端存的 draft，不是 send 调用的入参**——这是把外呼通道交给模型的全部安全性来源：注入能让它起草坏东西，但改不了「用户读到的卡片」与「真正发出的信」之间的收件人。**token 无效即拒绝，没有 fallback**：旧模块的 `findLatestDraft` 会在 token 对不上时发出「该用户最近一条草稿」，等于把这个性质原样交还回去。
- **读回的内容全量过 `sanitizeEmailForLLM`**（剥 HTML / 角色前缀 / 工具标记 / 零宽字符，正文截 4000）。**清洗顺序有意义**：零宽字符必须**先**删再跑角色正则——`sys<ZWSP>tem:` 会绕过正则，事后再删 ZWSP 就等于把一个干净的 `system:` 前缀交给模型（旧模块的顺序是反的，回归测试钉在 `api/__tests__/security.test.ts`）。
- **出网**：直连时先 DNS 解析 → `isPublicNetworkAddress()` 判定 → **用解析出的那个 IP 连接**、TLS 仍用原主机名做 SNI，解析与连接同一个答案才关得住 rebinding 窗口（旧模块是可绕过的正则黑名单）。`use_proxy` 走 `MAIL_EGRESS_PROXY`（socks5/http），未配置即明确报错，不静默回退直连。**2026-08-12 起绑定表单不再有代理开关**（预设表的 `needs_proxy` 已删，个人邮箱一律直连尝试）；`use_proxy` 列、API 字段与代理通路保留——共享邮箱 `SHARED_MAILBOX_USE_PROXY` 仍消费，也是将来「特定 URL 出口代理」的挂点。
- **限额常量住零 import 叶子模块** `api/limits.ts`（工具描述在模块求值期插值它们——与 automation 同款 TDZ 陷阱）。共享邮箱 80 封/天是**低于飞书服务端硬限制**（100/天/发件人）留的余量：我方先拒才有可读错误，被服务商拒会连带打掉 automation 送达。
- **`email_mutation` 在 `UNATTENDED_TOOL_DENYLIST` 里**：它的安全性全部建立在有人读那张卡并同意，无人值守时没有卡也没有读者，两步确认会退化成一步发送。automation 要送邮件走下面的系统通道。
- **Gating**: the plugin owns the `email` feature flag and feature point (default enabled for internal members when the plugin is active). Routes require internal identity and this flag; tools belong to the same point. Ownership, shared-mailbox super-only access and draft confirmation remain unchanged.

DB tables and services belong to this package; access them through `services(db)`, never DatabaseProvider fields. The adoption migration copies immutable baseline DDL with guarded creation/constraints. Disabled data stays intact.

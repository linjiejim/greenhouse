# Wecom official plugin

Disabled by default; enable `wecom` in `extensions.enabled` or `GREENHOUSE_EXTENSIONS` and restart. Preserve existing env names, URLs, tool ids and stored preference keys. Production imports use only extension kits, shared types and declared dependencies.

### 企业微信（`api/` + `/api/wecom` + `notify_wecom`）

**群机器人与自建应用是两件事，刻意并存**：`plugins/wecom/api/webhook.ts` 的 `sendWeComMarkdown` 是无状态 POST 到群 webhook，发到**聊天室**、点不了名；`plugins/wecom/api/client.ts` 是自建应用（corp app），才能按 `touser` 发给**某个人**。方案与决策（D1–D8）见 [spec](../../docs/specs/20260808-wecom-login-and-push.md)。

- **corp app 客户端住 `plugins/wecom/api/`，不进 `@greenhouse/utils`**：它有状态（access token 缓存 + 提前 5 分钟刷新 + 42001/40014 强制重取一次），而 utils 的调性是无状态纯函数。企微对 `gettoken` 有频控，缓存不是优化而是必需。
- **未配置就什么都不显示**：`GET /api/wecom/binding` 的 `available` 由三个 env 是否齐全决定，前端据此**整块不渲染**绑定卡；`/oauth/start` 未配置返回 503。一个必然失败的按钮就是一次假的能力声明。
- **两条腿鉴权刻意不同**：`/oauth/start` 必须带 Bearer——「是谁在绑定」只有这一跳知道，所以它返回 `{authorize_url}` 由浏览器自己跳，**不能写成整页 302**（那样发不出 header，必然 401）；`/oauth/callback` 是企微重定向浏览器过来的、没有 header，凭证就是 `state`（服务端生成、单次消费、10 分钟、绑死 userId），因此进 `isPublicPath` 且**永不调 `getAuthUser`**。落库前重读账号仍是 active 内部用户。护栏 `api/__tests__/oauth.test.ts` 直接断言 `isPublicPath` 三个路径的取值。
- **一个企微身份只能绑一个账号**（`findByProviderUserId` 查重）：否则两个人都能绑同一位同事，然后都收到他的通知。
- **个人推送的收件人只从绑定派生**：`notify.wecom` 是**布尔**，与 `notify.email` 同构——通道里没有任何可供瞄准的收件人字段，这正是它能免确认的原因。知识库 @提及是在群通道之外**叠加**一条个人消息，两条腿各自独立（群未配置不影响 DM，未绑定的收件人只是收不到）。
- **绑定存 `provider_connections(provider='wecom')`，且 `access_token_enc` 为 NULL**：企微应用 token 是 corp 全局的、由 client 缓存，per-user 行没有凭证可存；该列可空，不塞空串。
- 已知限制：企微 markdown **应用消息只在企业微信客户端内可见**（微信侧不显示）；应用 token 缓存在进程内存，多实例部署需换共享存储；绑定 `state` 已在 `login_states`（见下方飞书一节）。


Bindings and login states remain in the core generic tables; this plugin owns no tables. WeCom supports binding only, as in 3.0; do not advertise login.

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
| 鉴权 | Web、移动端、扩展用 Bearer 访问令牌加刷新令牌；`/api/mcp` 用 OAuth 2.1；电脑画面和终端用一次性 ticket；文件内容用按成员签发的短期签名 URL，因为 `<img>` 和下载链接带不了请求头 |
| 实时 | 只有一个 WebSocket `/api/ws`，事件为 `{ type, data }`，类型定义在 contract 里。消息增量、运行进度、需要你、通知、在线状态都走它；发送消息仍用 `POST` |
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
| `/api/me/connections[/:id]` | 连接：MCP 连接器账号、飞书 / 企微、邮箱 |
| `/api/me/vault[/:id]` · `/api/me/vault/log` | 密码库及其访问日志 |
| `/api/me/grants[/:id]` · `/api/me/tokens[/:id]` | 外部访问：OAuth 授权、个人访问令牌 |
| `/api/me/notification-settings` · `/api/me/push-devices` | 通知送达设置、推送设备 |

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
| `GET /api/requests?state=pending` · `POST /api/requests/:id/{approve,reject,answer,handback}` | 需要你：批准、拒绝、回答、交还 |

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
| `/api/knowledge/docs[/:id]` 及 `/versions` · `/comments` · `/share` · `/backlinks` · `/presence` · `/export` | 文档 |
| `/api/knowledge/folders[/:id]` · `GET /api/knowledge/search` | 文件夹（文档与文件同树）、检索 |
| `/api/tables/bases[/:id]/…` | 表格：数据表、字段、视图、记录、表单、自动化、评论、回收站、审计（沿用 #64 的结构） |
| `/api/apps[/:id]/…` · `POST /api/forms/:id` | 应用、表单提交 |
| `/api/skills[/:id]` · `…/versions` · `…/scan` · `…/download` | 技能 |
| `GET /api/notifications` · `POST …/read` | 通知 |
| `GET /api/search?q=&kinds=` | `⌘K` 全局搜索 |
| `GET /api/members?q=` · `GET /api/groups` | 成员与分组选择器（只读） |

### 2.5 管理（仅管理员）

| 路径 | 用途 |
| --- | --- |
| `/api/admin/members[/:id]` | 邀请、角色、停用、重置链接、模块权限、预算 |
| `/api/admin/groups[/:id]` | 分组 |
| `/api/admin/providers[/:id][/test\|/copy]` · `PUT /api/admin/provider-bindings/:capability` | 服务：实例、测试连接、复制环境变量实例；能力的顺序、默认项与策略 |
| `/api/admin/channels` | 渠道：SMTP、飞书、企微、推送 |
| `/api/admin/computers[/:id]` | 电脑列表与容量 |
| `GET /api/admin/usage?period=&group_by=member\|agent\|provider\|capability` | 工作区用量 |
| `GET` / `PUT /api/admin/budgets` · `DELETE …/:id` | 预算：组织、服务实例、成员三级，token 或美元，按月；`PUT` 建立或替换一个范围与单位的预算；列表带本月已用 |
| `/api/admin/connectors[/:id]` | 安装连接器（目录、Registry、URL） |
| `/api/admin/clients[/:id]` | 外部访问客户端（交互与机器） |
| `GET /api/admin/public-agents` · `POST …/:id/pause` · `…/resume` | 公开 Agent：主人、受众人数、本月用量；暂停与恢复 |
| `/api/admin/branding` | 名称、Logo、主色 |

### 2.6 对外与其他

| 路径 | 用途 |
| --- | --- |
| `/api/mcp` · `/oauth/*` · `/.well-known/*` | MCP 服务器与 OAuth 2.1，是唯一对外接口 |
| `/api/connectors/oauth/callback` | 连接器 OAuth 回调（公开） |
| `/api/ws` · `/api/ws/computer?ticket=` · `/api/ws/computer-terminal?ticket=` | 实时通道、电脑画面（RFB，`view` ticket 的输入由服务端丢弃）、终端（二进制按键与输出，`resize` 文本消息） |
| `/api/ext/<id>/*` | 扩展 |
| `GET /health` | 健康检查：各能力是否可用（不含机密）；数据库不可用时返回 503 |

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
| 技能 | `skill_query`、`skill_mutation`（含「存为技能」） |
| 多媒体（来自 Provider） | `web_search`、`web_fetch`、`generate_image`、`generate_video`、`speak`（TTS 生成音频）、`transcribe`（STT）、`analyze_image` |
| 其他 | `compute`（isolated-vm）、`read_attachment`、`export_data`、`memory`、`mcp_call`、`email_query`、`email_mutation` |
| 只在 Agent 内使用 | `browser`、`computer`、`request_takeover`、`vault` |
| 删除 | `workbench_*`、`project_*`、`mission_dispatch`、`workflow_plan`、`spawn_session`、`call_llm`、`task_capture`、`eval_*`、`manage_eval_dataset`、`query_eval_runs`、`feature_request`、`log_friction`、`automation_*`（改为 `schedule_*`）、`external_search`（改为 `web_search`）、`session_query`（改为 `conversation_query`） |

工具出现的条件：成员的模块权限允许，并且依赖的 Provider 可用。例如没有图像服务时就没有 `generate_image`，不会出现「未配置」的错误工具。

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
    connections/ admin/ mcp/ channels/
```

每个模块都附测试：service 单元测试、路由 API 测试、关键流程端到端测试。删除模块时，按 [功能清单](features.md) 的维护规则同步清理。

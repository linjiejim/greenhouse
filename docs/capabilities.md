# Greenhouse 4.0 能力范围

本文按当前 4.0.0-rc.1 代码描述能力。英文入口见 [README](../README.md)，结构与请求流程见
[架构说明](architecture.md)，从 3.x 升级见[升级到 4.0](upgrading-to-4.0.md)。

## 定位与默认配置

Greenhouse 是团队自托管的 Agent 中台：核心管身份、权限、运行、审计与预算，官方插件提供常用业务
模块，自有插件补团队的数据与流程。成员的外部 Agent 与客户端里的 Sprouty 共用工具层；所有成员
使用同一个通用客户端（Web、iOS、Android，另有 macOS 桌面壳）。

| 归属 | 能力 |
|---|---|
| 核心 | 账号、角色与实体/字段策略，对话与自定义 Agent，保存的提示词，模型目录/网关/计价预算，工具与 Runs，MCP 服务端与连接器，自动化，文件，通知/推送，运行时配置/品牌，插件宿主，Admin 与 CLI |
| 默认开启的插件 | Knowledge、Tables、Skills、Feedback、Memory |
| 编入但默认关闭的插件 | Projects、Reports、Email、Feishu、WeCom、Computer、Retro；另有关闭的 Example 参考包 |

Retro 依赖 Knowledge。`greenhouse.config.ts.plugins` 决定编入包，`extensions.enabled` /
`GREENHOUSE_EXTENSIONS` 决定启用。新增编译包要重建，启停要重启；只配凭证不会自动启用。
关闭后数据保留，相关工具、接口、页面、设置与投递渠道退出注册。Admin › 插件只读显示状态。

## 核心能力

| 能力 | 当前行为 |
|---|---|
| Sprouty 对话 | 流式文本与工具轨迹、后台运行和续读、任意类型附件、置顶、分叉、分享；富表格/图表/指标/卡片/步骤/Mermaid/HTML 预览；`ask_user` 表单与确认卡。 |
| 保存的提示词 | `/api/prompts` 与对话中的 `task_capture` 卡片（把一段请求存成可复用的提示词）；独立于 Skills 插件。 |
| 文件 | 云盘：团队/个人书架，目录、上传、预览、改名、移动、删除和按名搜索；本地存储或配置的对象存储。插件可在同一文件系统贡献自己的 scope 与授权。 |
| 自动化 | cron 定时 Agent。「自动化」位置提供编辑器（预设或 cron、时区、运行身份、结果去向、无人值守设置）、运行历史、立即运行、暂停与删除，并管理自定义 Agent。默认给可重放读取/搜索；额外工具须由 owner 显式授予且不超本人权限。无人值守不能删除、建自动化或发确认邮件。 |
| 通知 | 通知中心（含近 14 天团队动态）、持久投递队列、WebSocket 更新与可选手机推送。邮件/企微/飞书投递由启用的插件提供。 |
| 操作记录 | Agent 写入、自动化与平台动作的运行、步骤、工具证据及审计；中断的有副作用运行显示结果未知，不自动整轮重跑。super 在 Admin › 操作记录筛选并导出 CSV。 |
| 模型和预算 | 模型目录；模型/搜索/读网页/识图/生图按 USD 计量；团队、服务、成员月预算，先准入后调用，80%/100% 提醒。Admin › 服务与计价、用量查看与设置。模型网关独立默认关。 |
| 团队上下文 | Markdown 约定/术语、数据目录与 MCP 资源/提示词，按成员及授权工具裁剪；Knowledge 可补团队文档选择。Admin › 团队上下文编辑，并设工作区时区。 |
| 配置与品牌 | Runtime Config 与品牌存数据库，密钥加密、读取只给掩码；DB 配置优先于 env；客户端登录前读取品牌。Admin › 品牌带浅/深色预览。 |
| 权限 | 内部 super/team，功能点、能力、行范围与字段策略。Admin › 成员的权限对话框按人开关功能点与高级工具，角色带来的能力与策略只读显示。没有公开注册、匿名或访客 Agent。 |

## 官方插件

每个插件 README 列出自己的设置、环境变量、表、工具与路由。「更多」指宽屏 rail 的插件浮层。

| 插件 | 默认 | 能做什么 | 客户端位置 |
|---|---|---|---|
| [Knowledge](../plugins/knowledge) | 开 | Markdown 文档、团队/个人/共享书架、目录、版本/回滚、模板、AI 编辑、中文全文检索、MCP 文档资源、引用与分享。 | 「知识库」位置：浏览、阅读、编辑、新建与整理 |
| [Tables](../plugins/tables) | 开 | 类型化字段、视图、记录关联、公式/汇总、归档/恢复、数据目录；表结构由助手起草、人点卡片确认。 | 「表格」位置（云盘的表格分段）：库与表、grid、新建库与记录、记录详情；需 `tables` 功能开关 |
| [Skills](../plugins/skills) | 开 | SKILL.md 技能包、不可变版本、变更说明、安全扫描、上传/下载、启动同步内容包、MCP `skill-*` prompts；仓库不附带技能包。 | 「更多」：只读技能列表 |
| [Feedback](../plugins/feedback) | 开 | 需求/摩擦队列、成员反馈与 Agent 提交、工具错误/空检索归并。 | 「更多」：提交反馈；Admin › 问题与需求 |
| [Memory](../plugins/memory) | 开 | 个人长期记忆、标题、置顶、生命周期与巩固。 | 「更多」：只读记忆列表 |
| [Projects](../plugins/projects) | 关 | 项目/成员/任务、列表/看板/甘特、评论与动态。 | 「项目」位置：看板/列表/甘特、新建项目、任务表单 |
| [Reports](../plugins/reports) | 关 | 报告模板与校验，按品牌服务端渲染 PDF/Word/PPT，结果存入文件；默认模板为周报与项目汇报。 | 「更多」：只读模板列表 |
| [Email](../plugins/email) | 关 | 个人 IMAP/SMTP 与共享邮箱，搜索/读取/起草，成员在对话里确认后发送；通知和设密邮件投递。 | 「更多」：只读账户列表 |
| [Feishu](../plugins/feishu) | 关 | 账号绑定、登录、个人通知、可选长连接 Sprouty 机器人；绑定现有内部账号，不自动建号。 | `/login` 飞书登录；设置 › 连接里绑定 |
| [WeCom](../plugins/wecom) | 关 | 账号绑定、个人消息/群 webhook 投递；不提供登录。 | 设置 › 连接里绑定 |
| [Computer](../plugins/computer) | 关 | E2B 按需 Linux 沙箱、命令/文件/传输/停止，按分钟计价；还需凭证与工作区开关。 | 「更多」：状态页；Admin › 云电脑管理（开关、运行中实例、停止） |
| [Retro](../plugins/retro) | 关 | 每月 1 日 09:00 按工作区时区生成上月汇总文档；依赖 Knowledge；没有自己的表或 Agent 工具。 | Admin › 月度复盘：立即生成、查看历次 |

Tables/Memory 及启用后的 Email 还有成员级功能开关；启用插件不会绕过这些权限。
会话分享由核心 `conversations.sharing` 配置控制，默认开。

## 工具与 Agent 接入

工具列表来自核心与启用插件的同一个目录，数量随配置变化。

| 来源 | 主要工具 |
|---|---|
| 核心 | `files_query/mutation`、`session_query`、`automation_query/mutation`、`mcp_call`、`compute`、`read_attachment`、`ask_user`、`task_capture`、`export_data`、`call_llm`、联网/读网页/识图/生图工具 |
| Knowledge / Projects / Tables | `knowledge_query/mutation`、`project_query/mutation`、`tables_query/mutation`；Tables 另有聊天确认卡 `tables_schema_plan` |
| Skills / Memory / Feedback | `skill_query/mutation`、`memory`、`feedback_query`、`feature_request`、`log_friction` |
| Reports / Email / Computer | `report_templates`、`report_render`、`email_query/mutation`、`computer_exec/files/transfer/stop` |
| 数据插件 | 由声明派生 query/mutation、CRUD REST、目录/搜索/导出、实体链接和页面 |

每个工具按 `meta.surface` 决定能在哪用，不是所有工具都对 MCP 开放。邮件依赖真人读草稿，
`automation_mutation` 及聊天确认卡不放到 MCP；云电脑和独立网页读取工具面向外部 Agent。
MCP 始终额外提供 `team_context`、`data_catalog`、`tool_output_read`。

- `/api/mcp` 是标准无状态 Streamable HTTP，只认 OAuth 2.1：成员在自己的 MCP 客户端填站点地址，在 `/oauth-consent` 同意页授权（授权码 + PKCE）；机器客户端由 super 在 Admin › MCP 接入创建并绑定内部账号。
- 能力取成员权限、授权动作（read/write）与资源分组交集，每次请求复核；新增插件组不会自动进入旧授权。
- MCP 写入以成员身份执行并留写入记录；删除类第一次只预览，再带 `confirm: true` 执行，没有审批队列。成员在设置 › 我的 Agent 查看本月花费与 Agent 写入。
- 大回复提供分页 output_id，保存 24 小时，仅同成员/客户端可读，并重查当前权限。
- `/api/agent` 用成员登录令牌，每次写入要求 `confirm: true`；调用记请求日志，平台动作仍经统一审计。
- 连接器向外调用远程 MCP 服务：super 在 Admin › 团队连接器添加，选择不需登录、团队凭证或成员各自登录；写工具逐个开启，破坏性操作预览，写入进操作记录。成员在设置 › 连接里连接、测试或断开。
- 模型网关通过成员密钥提供 OpenAI/Anthropic 兼容端点，预算与其他服务一致；super 可在 Admin › 服务与计价撤销任一密钥。

## 客户端

| 客户端 | 界面与限制 |
|---|---|
| 通用客户端 Web | API 在 `/` 托管。宽屏：rail（内置位置、「更多」插件入口、super 的 Admin）、次级栏、主区、检查器，⌘K，居中对话框与设置窗口；窄窗口用手机布局。 |
| iOS / Android | 原生 Expo，同一 API；对话、附件/离线待发、最近内容离线读、启用插件入口、通知、多站点；iOS 小组件/iPad。没有 Admin（只在浏览器与桌面端的宽窗口）。Android 原生适配存在，商店发布与推送仍需配置。 |
| macOS | Tauri 2 打包通用客户端；Keychain、多站点、菜单/快捷键、通知与 Quick ask。支持本地未签名构建，正式签名/更新源需运维配置。 |
| CLI | 用户、数据库迁移/基线、工具/Agent/会话、自检、插件 list/status/drop；知识导入/重索引、表格恢复由对应插件提供。 |

站点 v2 清单按成员裁剪，页面有 `native`、`entity-list`、`entity-detail`、`settings-form`、`embed`
五种；`parent: 'administration'` 的页面只发给 super，成为 Admin 分区。数据插件的 `user` 字段显示
成员名。`mobile_api` 为 4，客户端也要求 4，3.x 工作站会提示先升级；不认识的页面只在插件
声明了外部地址时提供浏览器打开。声明页面不扩大权限，管理设置写入仍是 super-only。

内嵌 UI 使用主题/品牌 token、语言与成员上下文，以及十分钟窄令牌；只允许所属插件 API 与基础
`/api/me`，通过宿主登录态续期。消息校验来源窗口/origin；助手回传只填草稿不自动发送。

## 4.0 从界面移除的功能

以下界面随 Classic Web 一起移除，多数接口与工具仍在。升级步骤见[升级到 4.0](upgrading-to-4.0.md)。

| 不再提供的界面 | 替代方式 |
|---|---|
| 保存的提示词管理页、输入框 `/` 调用 | 对话里的 `task_capture` 卡片仍可保存；`/api/prompts` 保留 |
| 输入框的逐轮模型选择 | 对话使用 Agent 的默认模型；自定义 Agent 可固定模型；`POST /api/chat` 仍接受 `model` |
| 成员自己的操作记录页与 CSV 导出 | super 用 Admin › 操作记录（可导出）；成员在通知中心看团队动态，在我的 Agent 看 Agent 写入 |
| 成员新建/编辑邮箱账户、记忆与云电脑操作 | 客户端只读显示；记忆可让 Sprouty 用 `memory` 工具维护；接口保留 |
| 技能上传与版本历史、报告模板编辑 | 客户端只读列表；接口保留，技能包也可经 `packs.skills` 启动同步 |
| Agent 接入向导 | 在 MCP 客户端填站点地址并经 `/oauth-consent` 授权；机器客户端在 Admin › MCP 接入 |
| 添加个人连接器 | super 在 Admin › 团队连接器添加并可设为成员各自登录；`/api/me/connectors/personal` 保留 |
| 成员创建模型网关密钥 | 我的 Agent 只读显示；`POST /api/agent-access/gateway/keys` 保留 |
| 知识库分享对话框 | 在对话里让 Sprouty 用 `knowledge_mutation` 的 `share_doc` |
| 项目成员面板 | REST `/api/projects/:id/members` 保留 |
| Tables 字段编辑、回收站、数据目录页、审计对话框 | 表结构经对话确认卡 `tables_schema_plan` 修改；数据目录走 MCP `data_catalog`；对应 REST 保留 |
| SDK 1 React 插件页面 | 改写为 SDK 2 清单页面：native 适配器、实体页、设置表单或 embed |

## 部署与验证边界

- 一个 API 进程托管通用客户端 Web 导出与插件静态 UI，配一个 PostgreSQL；Docker Compose 另有一次性迁移服务。
- 核心 schema 49 张表，官方数据插件 24 张；新装只建核心表，插件启用时建自己的表，关闭插件不删表。
- 3.x 由 `pnpm db:migrate` 原地升级（建议从 3.0.2）；1.6 先经 3.0.2 再升 4.0；2.x 没有升级路径。
- 没有运行时代码热装载、插件市场或远程实体插件协议；远程服务使用 MCP 连接器。
- 活跃 ChatRun、编辑 presence 与部分凭证缓存是进程内状态，多副本需要额外设计。
- Runs 里 workflow / eval 等旧类型只保留历史行；没有浏览器扩展，Tables 没有表单、仪表盘与表内自动化。
- `/health` 报告数据库与开关状态，不报告版本；镜像用 APP_VERSION/APP_REVISION 与 OCI 标签标记来源。
- 稳定 tag 发布精确版本/次版本/latest；rc 只发布精确 rc 标签；main 只发 edge/main-sha。
- 测试层：`pnpm test`（unit / db / db-commit）、`pnpm test:e2e:ci`（真实服务的 HTTP 安全边界）、`pnpm test:core`（不编入任何插件的核心）、`pnpm test:e2e:client`（Playwright，`tests/client-e2e`）。

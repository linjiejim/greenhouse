# Greenhouse 4.0 能力范围

本文按当前 4.0.0-rc.1 代码描述能力。英文入口见 [README](../README.md)，结构与请求流程见
[架构说明](architecture.md)，升级配置见 [CHANGELOG](../CHANGELOG.md#upgrading-from-3x)。

## 定位与默认配置

Greenhouse 是团队自托管的 Agent 中台：核心管身份、权限、运行、审计与预算，官方插件提供
常用业务模块，自有插件补团队的数据与流程。成员的外部 Agent 与应用内 Sprouty 共用工具层。

| 归属 | 能力 |
|---|---|
| 核心 | 账号、角色与实体/字段策略，对话与自定义 Agent，模型目录/网关/计价预算，工具与 Runs，MCP 服务端与连接器，自动化，文件，通知/推送，运行时配置/品牌，插件宿主，管理后台与 CLI |
| 默认开启的插件 | Knowledge、Tables、Skills、Feedback、Memory |
| 编入但默认关闭的插件 | Projects、Reports、Email、Feishu、WeCom、Computer、Retro；另有关闭的 Example 参考包 |

Retro 依赖 Knowledge。`greenhouse.config.ts.plugins` 决定编入包，`extensions.enabled` /
`GREENHOUSE_EXTENSIONS` 决定启用。新增编译包要重建，启停要重启；只配凭证不会自动启用。
关闭后数据保留，相关工具、接口、页面、设置与投递渠道退出注册。管理后台插件页只读显示状态。

## 核心能力

| 能力 | 当前行为 |
|---|---|
| Sprouty 对话 | 流式文本与工具轨迹、后台运行和续读、任意类型附件、按轮选模型、置顶、分叉、分享；富表格/图表/指标/卡片/步骤/Mermaid/HTML 预览。 |
| 保存的提示词 | 我的提示词、变量填写、聊天 `/` 调用与 `task_capture` 确认卡；独立于 SkillHub 插件。 |
| 文件 | 团队/个人书架，目录、上传、预览、改名、移动、删除和按名搜索；本地存储或配置的对象存储。插件可在同一文件系统贡献自己的 scope 与授权。 |
| 自动化 | cron 定时 Agent，运行配置、历史、手动运行、暂停和删除。默认给可重放读取/搜索；额外工具须由 owner 显式授予且不超本人权限。无人值守不能删除、建自动化或发确认邮件。 |
| 通知 | 站内通知中心、持久投递队列、WebSocket 更新与可选手机推送。邮件/企微/飞书投递由启用的插件提供。 |
| 操作记录 | Agent 写入、自动化与平台动作的运行、步骤、工具证据及审计；中断的有副作用运行显示结果未知，不自动整轮重跑。 |
| 模型和预算 | 模型目录；模型/搜索/读网页/识图/生图按 USD 计量；成员、服务、团队三级月预算，先准入后调用，80%/100% 提醒。模型网关独立默认关。 |
| 团队上下文 | Markdown 约定/术语、数据目录与 MCP 资源/提示词；按成员及授权工具裁剪。Knowledge 可补团队文档选择。 |
| 配置与品牌 | Runtime Config/Branding Studio 存数据库，密钥加密、读取只给掩码；DB 配置优先于 env；客户端登录前读取品牌。 |
| 权限 | 内部 super/team，功能点、能力、行范围与字段策略；没有公开注册、匿名或访客 Agent。 |

## 官方插件

每个插件 README 列出自己的设置、环境变量、表、工具与路由。

| 插件 | 默认 | 能做什么 |
|---|---|---|
| [Knowledge](../plugins/knowledge) | 开 | Markdown 文档、编辑器、团队/个人/共享、目录、版本/回滚、模板、AI 编辑、中文全文检索、MCP 文档资源、引用与分享。 |
| [Tables](../plugins/tables) | 开 | 类型化字段、视图、记录关联、公式/汇总、归档/恢复、数据目录；表结构由助手起草、人点卡片确认。 |
| [Skills](../plugins/skills) | 开 | SKILL.md 技能包、不可变版本、变更说明、安全扫描、上传/下载、启动同步内容包、MCP `skill-*` prompts；仓库不附带技能包。 |
| [Feedback](../plugins/feedback) | 开 | 需求/摩擦队列、成员反馈与 Agent 提交、工具错误/空检索归并。 |
| [Memory](../plugins/memory) | 开 | 个人长期记忆、标题、置顶、生命周期与巩固。 |
| [Projects](../plugins/projects) | 关 | 项目/成员/任务、列表/看板/甘特、评论与动态。 |
| [Reports](../plugins/reports) | 关 | 报告模板与校验，按品牌服务端渲染 PDF/Word/PPT，结果存入文件；默认模板为周报与项目汇报。 |
| [Email](../plugins/email) | 关 | 个人 IMAP/SMTP 与共享邮箱，搜索/读取/起草/人确认后发送，通知和设密邮件投递。 |
| [Feishu](../plugins/feishu) | 关 | 账号绑定、登录、个人通知、可选长连接 Sprouty 机器人；绑定现有内部账号，不自动建号。 |
| [WeCom](../plugins/wecom) | 关 | 账号绑定、个人消息/群 webhook 投递；不提供登录。 |
| [Computer](../plugins/computer) | 关 | E2B 按需 Linux 沙箱、命令/文件/传输/停止，按分钟计价；还需凭证与工作区开关。 |
| [Retro](../plugins/retro) | 关 | 每月 1 日 09:00 按工作区时区生成上月汇总文档；可手动生成。依赖 Knowledge；没有自己的业务表或 Agent 工具。 |

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

- `/api/mcp` 是标准无状态 Streamable HTTP，只认 OAuth 2.1；个人授权码 + PKCE，机器客户端绑定内部账号。
- 能力取成员权限、授权动作（read/write）与资源分组交集，每次请求复核；新增插件组不会自动进入旧授权。
- MCP 写入以成员身份执行并留写入记录；删除类第一次只预览，再带 `confirm: true` 执行，没有审批队列。
- 大回复提供分页 output_id，保存 24 小时，仅同成员/客户端可读，并重查当前权限。
- `/api/agent` 用成员登录令牌，每次写入要求 `confirm: true`；调用记请求日志，平台动作仍经统一审计。
- 连接器是向外调用远程 MCP 服务，支持团队/个人凭证和 OAuth；写工具逐个开启，破坏性操作预览，写入进操作记录。
- 模型网关通过成员密钥提供 OpenAI/Anthropic 兼容端点，预算与其他服务一致。

## 客户端

| 客户端 | 界面与限制 |
|---|---|
| Classic Web | 默认根路径 `/`，固定入口 `/classic/`；完整管理后台、SDK 1 React 页面、插件通用渲染器。 |
| 通用客户端 Web | 宽屏 rail/次级栏/主区/检查器，⌘K、对话、知识编辑、文件、表格 grid、项目 board、自动化及插件「更多」。`clients.web: 'universal'` 才接管生产根路径。 |
| iOS / Android | 原生 Expo，同一 API；对话、附件/离线待发、最近内容离线读、启用插件入口、通知、站点管理；iOS 小组件/iPad。Android 原生适配存在，商店发布与推送仍需配置。 |
| macOS | Tauri 2 打包通用客户端；Keychain、多站点、菜单/快捷键、通知与 Quick ask。支持本地未签名构建，正式签名/更新源需运维配置。 |
| CLI | 用户、数据库、迁移/搬家、工具/Agent/会话、自检、插件状态/数据清理；知识导入/重索引、表格恢复等由对应插件提供。 |

站点 v2 能力清单按成员裁剪，页面有 `native`、`entity-list`、`entity-detail`、`settings-form`、
`embed` 五种；不认识的页面给浏览器回退。`mobile_api` 为 4；当前通用客户端最低仍为 3，
v2 缺失时可走旧导航。管理设置写入仍是 super-only，声明页面不扩大权限。

内嵌 UI 使用主题/品牌 token、语言与成员上下文，以及十分钟窄令牌；只允许所属插件 API 与
基础 `/api/me`，通过宿主登录态续期。消息校验来源窗口/origin；助手回传只填草稿不自动发送。

## 部署与验证边界

- 一个 API 进程托管两套静态客户端，一个 PostgreSQL 数据库；Docker Compose 另有迁移服务。
- 核心 schema 49 张表，官方数据插件 24 张；不可变 3.0 基线仍建出原有 73 张，关闭插件不删表。
- 3.x 原地迁移；1.6.x 通过 `migrate-from-1x` 搬到新库，2.x 不支持。
- 没有运行时代码热装载、插件市场或远程实体插件协议；远程服务使用现有 MCP 连接器。
- 活跃 ChatRun、编辑 presence 与部分凭证缓存是进程内状态，多副本需要额外设计。
- 历史工作流/评测等只读记录保留；浏览器扩展、表格表单/仪表盘/表内自动化没有恢复。
- `/health` 不报告版本；镜像用 APP_VERSION/APP_REVISION 与 OCI 标签标记来源。
- 稳定 tag 发布精确版本/次版本/latest；rc 只发布精确 rc 标签；main 只发 edge/main-sha。
- 现有 `docs/assets/screens` 是旧 classic 截图，不能作为 4.0 通用客户端验收；按 README 的 screenshot tour 在可运行 Chromium 的环境更新。

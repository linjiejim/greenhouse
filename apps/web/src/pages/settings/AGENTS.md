## Settings 页面布局规范

### 结构
- 每个子页面是一个 Panel 组件，在 `settings/index.tsx` 或 `administration/index.tsx` 中挂载；Panel 根节点必须是 `components/app/module-page.tsx` 的 `<ModulePage moduleId="..." layout="...">`。
- `ModulePageShell` 只负责模块导航、移动端模块 tabs 和 viewport；`ModulePage` 负责页内身份区、内容宽度、插槽顺序与滚动。路由层不得再包一层 `overflow-y-auto`、页面 padding 或 `max-w-*`。
- 页面图标、标题与说明只从 `lib/nav-registry.ts` 的 `moduleId` 派生；业务页不得重复手写 page header。页级扩展按 `actions → notice → tabs → toolbar → content` 放入对应 slot，只传当前页面真实需要的 slot，不预留 footer/aside。
- 布局只选三种：配置表单用 `form`（最大 960px）、列表/数据页用 `list`（最大 1280px）、固定页头的沉浸工作区用 `canvas`（全宽）。不要在业务页面再发明宽度。
- `form` / `list` 的纵向滚动由 `ModulePage` 拥有；`canvas` 的内容子树必须自己声明 `h-full min-h-0 overflow-y-auto`。宽表格只在自己的表格容器横向滚动，禁止让整个页面横向滚动。
- 移动端页面头自动堆叠，`actions` 内按钮满宽、`toolbar` 换行，模块栏自动把当前项带入视口；调用方不要添加另一套移动端页头、滚动定位或按钮宽度规则。
- 常规配置内容用 `SettingsPanel` + `SettingsSection`；统一 `space-y-4`、标题层级、说明与操作位，禁止手写另一套 Card header。字段内部用 `components/form` 的 `FormField` / `FormGrid` / `FormActions`。
- Automation、Tasks、Agents 的二级范围统一用 `FilterPills variant="segment"`：Mine / Shared / Team（仅 super）；每次进入默认 Mine，扩大范围不持久化。范围切换放在列表工具栏左侧，右侧依次放结果数和主操作。三档语义与空态见 [personal asset scope spec](../../../../docs/specs/20260812-personal-asset-scope-tabs.md)，禁止把管理员可见性冒充共享。
- Eval 使用 `layout="canvas"`，固定 Tabs 放 `tabs` slot，具体视图在 content 内拥有滚动。

### 添加新页面
个人 Settings 模块的唯一真相是 `lib/nav-registry.ts` 的 `settingsSections`；全局 Administration 模块（super only，独立顶层界面）在同文件的 `ADMINISTRATION_MODULES`。**不再**在 `settings/index.tsx` 里维护 MODULES 数组。
1. 在 `pages/settings/` 下创建 `xxx.tsx`，导出以 `<ModulePage moduleId="..." layout="...">` 为根的 `XxxPanel` 组件（Administration 页面放 `pages/administration/`）
2. 在 `lib/nav-registry.ts` 把模块加入对应数组：个人项进 `SETTINGS_TOP`（置顶扁平区）或 `SETTINGS_LABS`（功能开关）；super-only 全局管理项进 `ADMINISTRATION_MODULES`（已整体 `requireRole: ['super']`）。填 `id`/`label`/`icon`/`path`/`description`，按用户功能开关的项加 `requireFeature`
3. import 该 Panel：Settings 走 `settings/index.tsx`（模块列表由 `settingsAllModules` 自动派生）；Administration 走 `pages/administration/index.tsx`
4. TopBar 面包屑与侧边栏都从 `nav-registry` 读取，顺序即数组中的顺序

### 页面分组与权限
**Settings（个人配置，内部全员可见，见 `settingsSections`）**
- **Preferences + Cloud（一个无标题扁平区）**：Preferences、Groups、Agent Connections、Connections（企微 / 飞书绑定）、Email Accounts
- **Labs（feature-gated）**：Memory（`requireFeature: 'memory'`）
- **个人工具独立页面**：Automation、Prompt Tasks、My Agents 分别使用 `#/automations`、`#/tasks`、`#/agents`，入口位于全局 `More`，刷新、后退和深链必须保持当前页面；历史 Settings/`#/chat?view=...` 深链只重定向到这些 canonical 地址。持久执行统一使用 `#/executions` 的「执行中心」，入口位于账户浮层 Inbox 下方，不与 Prompt Tasks 共用命名或 URL；Mission 的主要发起面仍是 Chat。

**Administration（super only，独立顶层界面，入口在侧边栏账户浮层，见 `administrationModules`）**：Users、Agent Usages、Feature Requests、Frictions、Evaluation、AI Gateway、MCP Access、Runtime Config、Branding Studio。内置 Agent 已收敛为单一默认预设，不再提供只读 System Agents 清单；历史 `#/administration/profiles` 与 `#/settings/profiles` 链接落到 Agent Usages。
- Users 行的「权限」按钮打开 `user-permissions-modal.tsx` 统一弹框（功能点优先，tab 归属由服务端注册表的 `group` 驱动：基础权限（默认开放的 Tables/Missions/AI Memory + 只读全局工具）/ 应用权限（Knowledge/Projects/Tables）/ 高级权限（Advanced tools）/ 用量限制 四 tab），已吸收原工具分配弹框、功能开关弹框与独立的 App Permissions 页；用量限制只配置月度 Token 上限（每日消息只保留统计、不限额）；写走既有细粒度端点，读走 `GET /api/admin/users/:id/access`（服务端 `feature-points.ts` 聚合）。详见 [spec](../../../../docs/specs/20260723-user-permissions-unified-modal.md)。

### 列表 / 记录页范式（新页一律走 @greenhouse/crud）
**settings 新增页面或大改一律用 `@greenhouse/crud`**：一份 `defineCrud<Row>` schema 驱动 `<CrudPage>`——工具栏/筛选/排序/分页、新增/编辑 Dialog、详情 Drawer、删除确认、空态全部由框架统一；手写 `<table>` 页面属于 legacy（存量不强迁）。
- **必须从 `./crud`（本目录的绑定模块）import**，不要直接 import `@greenhouse/crud`——绑定模块负责 `installCrudUi()`（框架渲染前注入 app 的 ui.tsx 组件与 toast）
- 数据源：页面已有 hc/typed client 时写 `CrudDataSource` 适配器（零服务端改动；参考 `prompts`、`groups`、`automations`、`oauth-grants`、`skills` 等已迁页面）；全新资源可用服务端 `createCrudRoutes`（`@greenhouse/crud/server`，guard 直接传 `requireInternal()`/`requireSuper()`）+ 客户端 `createRestDataSource`
- **能写就必须显式声明 `access`**：`defineCrud` 把 `canView`/`canAdd`/`canEdit`/`canDelete` **全部默认 false**，而权限为假时框架**根本不构建行操作列**——于是 `dataSource.update`/`remove`、`formFields`、`deleteConfirm` 全成了触达不到的死配置。类型、lint、端点测试、页面渲染**全都不会报**（Frictions 面板就这样上线了一版只能看不能处理的队列，v0.40.0）。护栏在 `tests/web/crud-write-access.test.ts`：写了 `update`/`remove` 却没写对应 `canEdit`/`canDelete` 的页面直接红。
- bespoke 需求走 escape hatch：`type:'custom'` 列/字段、`slots`（toolbar/banner/empty/rowExpand/renderCard）、`tableActions`/`pageActions`、`deleteConfirm`（按行定制删除确认文案）
- 表单字段的次要解释用 `help`，由字段标题旁的信息图标按需展示；`comment` 只保留给禁用原因、校验后果等必须常驻的状态/行动提示，禁止把普通说明堆在输入框下方。
- 框架 chrome 通过 `pages/settings/crud.ts` 注入宿主 `useT()`，必须随当前语言切换；schema 的 name/label/empty/delete 文案同样传页面自己的 `t()` 结果，禁止恢复 English-only 约定
- 参考实现：`prompts.tsx`（表格 + 表单 + custom 字段）、`groups.tsx`（toolbar/rowExpand slot + 行内创建）、`automations.tsx`（toggle 列 + tableActions + cron builder custom 字段）；完整模式另见 OSS greenhouse 的 `crud-example.tsx`
- e2e：给 schema 设 `testId`，框架自动派生 `{testId}-add`/`-field-{key}`/`-submit`/`-delete` 等选择器

下面的手写 `<table>` 规范仅作为 CrudPage 底层形态参考 / 极特殊自定义页使用：
```
┌─ Toolbar: [搜索/筛选] ─────────────────── [操作按钮] ┐
│                                                       │
│ ┌─ Table ───────────────────────────────────────────┐ │
│ │ ☐ │ Column A │ Column B │ Status │ ... │ Actions  │ │
│ │   │          │          │        │     │ 🖊 🗑    │ │
│ └───────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```
- 使用 `<table>` 渲染数据列表
- 表格容器：`bg-surface-raised border border-edge rounded-lg overflow-hidden`
- thead：`bg-surface-sunken text-fg-muted`
- 如支持多选：最左列放 checkbox（`w-10`）
- 操作列放最右侧（`text-center`），使用 icon button（`p-1 rounded`）
- 工具栏放 table 上方：`flex items-center gap-3`，左侧计数/筛选，右侧操作按钮
- 行 hover：`hover:bg-surface-sunken transition-colors`
- 可展开行：点击 row 展开详情（`<td colSpan={N}>`），参考 Eval Datasets

### 表单/配置页范式（参考 Preferences）
- Settings 页面画布统一使用 `bg-surface-canvas`；真正的数据/配置卡片使用共享 `<Card>`（`bg-surface-card border border-edge rounded-xl p-4`），输入框和弹窗继续使用 `bg-surface-raised`
- 多个确定性配置区块使用 `SettingsPanel` + `SettingsSection`；单一区块也保留同一标题与内容节奏，不手写 `space-y-6/8` 或页面级 `max-w-*`
- 页面根使用 `ModulePage layout="form"`；`SettingsPanel` 自身不再承担页面宽度或 padding。字段网格 mobile-first 自适应，宽度上限由页框统一提供

### 样式速查
| 元素 | Class |
|------|-------|
| 表格容器 | `bg-surface-raised border border-edge rounded-lg overflow-hidden` |
| thead | `bg-surface-sunken text-fg-muted` |
| tbody 分割 | `divide-y divide-edge` |
| 行 hover | `hover:bg-surface-sunken transition-colors` |
| 状态 badge | `text-[10px] px-2 py-0.5 rounded-full font-medium` + 语义色 |
| 操作按钮 | `p-1 text-fg-muted hover:text-xxx rounded transition-colors` |
| 工具栏 | `flex items-center gap-3` |

## 前端规则

### 设计系统

**图标：Lucide React**
- 所有图标来自 [Lucide React](https://lucide.dev/)——**禁止用 emoji 当图标**
- 从 `lib/icons.ts` 统一导入（集中管理）
- 辅助函数：`getCategoryIcon()`、`getToolIcon()`、`getContextIcon()`
- 标准尺寸：`size={12}` 行内、`size={14}` 按钮、`size={16}` 导航、`size={20}` 标题

**Logo**
- 使用 `components/ui.tsx` 中的 `<AppLogo />`（Lucide `Sprout` 图标 + "Greenhouse" 文字，无外部图片）

### UI 组件 (`components/ui.tsx`)
- 基础组件：Button、Badge、Tag、TagList、Card、Input、Select、Textarea、Tabs、Dialog、ConfirmDialog、Drawer、Pagination、Spinner、Skeleton、SkeletonRow、SkeletonCard、StarRating、EmptyState、ErrorBoundary、AppLogo、ToastContainer、`toast()`
- 新增原子组件：SearchInput、Toggle、StatusDot、Checkbox、Avatar、DateRangeInput、ListToolbar
- 详情页组件 (`components/detail/`)：`<DetailHeader>`、`<DetailSection>`、`<FieldGrid>`、`<Field>`——见下方「详情页规范」
- 列表分页：`<Pagination>` + `usePersistedPageSize`——见下方「列表分页规范」
- 标签：`<Tag>`（方角紧凑、单行）/`<TagList>`（多标签单行 +N）——见下方「标签 Tag 规范」
- **始终使用这些组件**，不要用原生 HTML + 内联 Tailwind
- 弹窗 → `<Dialog>` / `<ConfirmDialog>`，不要手写 `fixed inset-0`
- **Dialog vs Drawer 交互约定**：
  - 创建/编辑**表单** → 居中 `<Dialog>`；多字段表单用 `size="lg"`，简单确认/单字段用 `sm`/`md`
  - 浏览类**详情/辅助面板**（任务详情、成员列表、活动流、只读预览）→ 右侧 `<Drawer>`
  - Drawer 背景只压暗**不加 backdrop-blur**（保持页面上下文可读）；Dialog 背景保留 blur
  - 定时排程不要让用户裸写 cron——用频率+时间的可视化构建器（见 `pages/settings/automations.tsx` 的 buildCron/parseCron），cron 表达式仅作高级逃生口
- 浮层面板 → `<OverlayPanel>`（`components/app/overlay-panel.tsx`），不要手写 backdrop + fixed inset-0
  - `variant="side"`（右侧面板）或 `variant="bottom"`（底部抽屉）
- 表单输入 → `<Input>`、`<Select>`、`<Textarea>`，不要用原生 `<input>`、`<select>`、`<textarea>`
- 列表页头部 → `<ListToolbar>`（hint 左 / count + actions 右，主操作按钮最后），不要手写 `flex items-center + flex-1 spacer + 按钮`
- 空状态 → `<EmptyState>`（`icon` 只接 Lucide，**禁止 emoji**；有创建语义时把 Create 按钮传 `action` 槽），不要手写 `text-center py-12`
- 搜索框 → `<SearchInput>`，不要手写 Search icon + Input 组合
- 复选框 → `<Checkbox>`，不要用原生 `<input type="checkbox">`
- 开关 → `<Toggle>`，不要手写 role="switch" + translate-x 动画
- 日期范围 → `<DateRangeInput>`，不要手写 From/To 两个 date input
- 用户头像 → `<Avatar>`，不要手写 rounded-full + 首字母 + flex center
- 状态指示点 → `<StatusDot>`，不要手写 w-2 h-2 rounded-full bg-xxx
- 通知 → `toast(message, variant)`——禁止 `alert()` 或 `window.confirm()`
- 确认 → `<ConfirmDialog>` 配合 state——禁止 `window.confirm()`
- 加载 → `<Skeleton>` / `<SkeletonRow>` / `<SkeletonCard>` 用于布局占位；`<Spinner>` 用于行内指示
- 错误边界 → `<ErrorBoundary>` 包裹可能出错的子树
- `<AppLogo>` 支持 `size`（`sm|md|lg|xl`）、`showVersion`、`logoOnly` prop——品牌图标只走 `<AppLogo>`，不要自行硬编码 logo
- `<Input>` / `<Select>` 支持 `size` prop（`xs` | `sm` | `md` | `lg`），**禁止用 `!important` 覆盖 padding/font-size**

- `<Select>` 支持 `inline` prop（`w-auto` 而非 `w-full`），用于行内筛选器场景
### 数据展示组件 (`components/blocks/`)
- `<DataTableBlock>` — 可排序、可搜索的数据表格，支持 text/number/currency/percent/boolean/badge 列类型
- `<ConfirmBlock>` — 行内确认按钮组，用于 Agent 交互
- 以上组件可独立使用，也可通过 `<RichMarkdown>` 自动解析 code fence 渲染

### Markdown 渲染
- `<Markdown>` (`components/markdown.tsx`) — 基础 Markdown 渲染，支持 `compact` prop
  - 默认使用 `prose-base` 样式（宽松，适用于知识库文档/详情页）
  - `compact` 时使用 `prose-compact` 样式（紧凑，适用于聊天/Agent 消息）
- `<RichMarkdown>` (`components/rich-markdown.tsx`) — 增强版，自动解析 chart/datatable/confirm code fence 为交互组件，支持 `compact` prop 透传
- 聊天/Agent 场景用 `<RichMarkdown compact />`，知识库/详情页用 `<Markdown>`

### 设计系统预览页
- 访问路径：`#/design`（不在导航栏显示，仅直接 URL 访问）
- 文件：`pages/design.tsx`（lazy-loaded，不影响主包体积）
- 覆盖所有共享组件：颜色 token、字体、间距、Button、Badge、Tag、TagList、Pagination、Input、Card、Tabs、Dialog、Drawer、详情 kit（DetailHeader/DetailSection/FieldGrid/Field）、Toast、Spinner、Skeleton、EmptyState、StarRating、DataTableBlock、ChartBlock、ConfirmBlock、Markdown、RichMarkdown、ErrorBoundary、AppLogo
- 新增共享组件时同步更新此页面

### 组件目录 (`components/`)
```
components/
├── ui.tsx              # 原子级基础组件（全项目复用）
├── blocks/             # 数据展示：DataTableBlock、ChartBlock、ConfirmBlock
├── app/                # 应用外壳：Sidebar、TopBar、LoginScreen、UserMenu、MyProfilePanel
├── project/            # 项目管理：TaskTree、BoardColumn、GanttView、TaskDrawer、CreateTaskDialog
├── knowledge/          # 知识库：详情、编辑器、共享、版本历史
├── agent-panel/        # Agent 助手面板
├── chat/               # 聊天：消息气泡、输入框、profile 选择器、流式消息、标注
├── detail/             # 详情页 kit：DetailHeader、DetailSection、FieldGrid、Field
├── session-groups/     # 会话分组
├── session-tags/       # 会话标签
├── usage/              # 用量统计展示
├── agent-context.tsx   # 全局上下文 Provider
├── markdown.tsx        # 共享 Markdown 渲染器
├── rich-markdown.tsx   # 增强版 Markdown（解析 chart/datatable/confirm code fence）
└── pdf-export.tsx      # PDF 导出工具

stores/
├── index.ts            # Barrel export
├── auth-store.ts       # 认证状态 (Zustand)
└── ui-store.ts         # UI 状态 (Zustand)
```
- 新功能？在 `components/` 下创建子目录并配 barrel `index.ts`
- 每个组件文件保持专注（建议 < 300 行）

### 共享工具函数 (`lib/utils.ts`)
- `safeParse(json, fallback)`、`relativeTime()`、`timeAgo()`、`formatDate()`、`formatTokens()`
- `roleBadgeStyles`——角色徽章样式，禁止在组件中重复定义
- `CHART_PALETTE` / `BADGE_PALETTE`——数据可视化配色，禁止在组件中硬编码色板
- **禁止在组件文件中重复实现**

### 全局状态管理 (Zustand)
- 全局状态统一使用 Zustand store，存放在 `stores/` 目录
- `useAuthStore` — 认证状态、当前用户、登录/登出
- `useUIStore` — 导航抽屉、个人资料面板、偏好设置弹窗
- 页面级/功能级状态可以用 `useState`/`useReducer`
- **禁止为全局状态新建 React Context**——统一用 Zustand store
- 现有 Context（`AgentContext`、`SessionManagerContext`、`I18nContext`）保留使用，但新功能优先用 store

### 构建与开发模式（Vite，2026-06 起）

- **构建工具 = Vite**（`apps/web/vite.config.ts`）：`@vitejs/plugin-react`（Fast Refresh）+ `@tailwindcss/vite`。入口 HTML 是 `apps/web/index.html`（Vite root），`<script src="/src/app.tsx">`；CSS 由 `app.tsx` 里 `import './app.css'` 引入，**不要**在 index.html 写 `<link>`。
- **Dev**：`pnpm dev` = Vite dev server `:3100`（HMR）+ api `:3101`。Vite 把 `/api`(含 ws)、`/public`、`/health` 代理到 api，浏览器视角同源——**dev 打开 `:3100`**。改 `.tsx` 即时热更新，无需手动重建（对比旧 esbuild --watch 的痛点）。后端改动仍要重启（api 无 --watch）。
- **生产**：`pnpm web:build` = `vite build` → hash 产物进**仓库根 `public/`**（api、Electron 打包、热更新发布都指向这里）。关键约束：
  - `base: './'`——产物用相对引用，**同一份 `public/index.html` 既能被 api 在 `/` serve、又能被 Electron 以 `file://` 加载**。改 base 会二选一破坏其一。
  - `emptyOutDir: false` + build 脚本先 `rm -rf public/assets`——不整盘清空 `public/`（保留任何 git 跟踪的静态文件），同时清掉旧 hash 产物。
  - 新增/重命名 bundle 资产路径（`/assets/*`）后，必须同步 `apps/api/src/auth/middleware.ts` 的 `isPublicPath` 放行 + `apps/api/src/index.ts` 的 serveStatic 映射，否则资产被 auth 拦成 401。
- **运行时静态资产**（logo 等，非 bundle）：用 `lib/api-base.ts` 的 `publicAssetUrl('xxx.jpg')`——web 解析为 `/public/xxx.jpg`、Electron 解析为 `./xxx.jpg`。不要硬编码 `/public/...`。

### 代码分割 (Code Splitting)
- 使用 `React.lazy` + `Suspense` 对路由页面做懒加载
- `ChatPage` 为即时加载（高频访问），其他页面均为懒加载
- Vite 自动按动态 `import()` 切分 chunk，输出 hash 文件名到 `public/assets/`
- 新增路由页面必须使用 `lazy(() => import('./pages/xxx'))` 模式

### API 调用
- **首选 hc 类型化调用**（2026-06 起）：领域模块在 `lib/api/<domain>.ts`，统一经 `lib/api/client.ts` 的 `rpc`（`hc<AppType>` over authFetch，自动 Bearer + 401 刷新）。响应类型由服务端实现推导，与声明类型的冲突=编译期漂移告警，**禁止用 `as` 压掉**
- hc 约定（详见 `lib/api/client.ts` 头注释 + `lib/api/profiles.ts` 示范）：无 validator 路由传 json/query 用**变量间接**（`const args = {param, json}; rpc...$put(args)`）；param 值含 `/` 或 `%` 时显式 `encodeURIComponent`（hc 不编码）；流式（NDJSON）与 FormData 端点保持 raw `authFetch`（`lib/api/chat.ts`、`lib/api/upload.ts`）
- 旧直连写法仅限流式/上传：`lib/auth.ts` 的 `authFetch()`——自动处理 token 和 401 跳转
- 历史遗留 `lib/*-api.ts` 模块用 `lib/http.ts` 的 `fetchJson<T>()`——新代码不要再用，迁到 `lib/api/` + rpc
- 复制到剪贴板用 `hooks/use-copy-to-clipboard.ts` 的 `useCopyToClipboard()`，不要重复 `copied` + `setTimeout` 模板

### 流式事件处理 (`lib/stream-events.ts` + `lib/stream-utils.ts`)
- NDJSON 流解析统一使用 `readNdjsonStream<T>()`——不要手写 `reader.read()` + `TextDecoder` 循环
- 流事件类型定义使用 `StreamingEvent` 联合类型（discriminated union）
- 消费端使用 `handleStreamEvent(event, callbacks)` 分发——不要写 `switch(event.type)`
- 新增流事件类型时更新 `stream-events.ts` 中的 `StreamingEvent` 联合和 `handleStreamEvent` 分发

### 页面上下文注入
- Context Provider 放在 `lib/context-providers/`——每个文件注册一个页面类型
- 每个 Provider 定义：`label`、`emptyMessage`、`placeholder`、`quickActions`、`contextHint`
- `contextHint` 生成纯文本字符串，以 `context_hint` 参数发送给后端（注入到 system prompt）
- 后端没有自己的 context provider——直接接收和使用 hint 字符串
- 新页面在 `lib/context-providers/` 添加 provider 文件并在 `index.ts` 中导入
- 页面组件使用 `enrichPageContext()` 添加 URL 之外的数据（如 title、email）

### Fork 扩展点（下游个性化）
下游 fork 用这些接缝新增私有功能，**不改共享注册文件**，从而这些文件与上游保持一致、合并不冲突。**上游本仓库每个接缝都为空**，由 guard 测试锁定。
- **私有工具的聊天卡片渲染** → `components/tool-call/artifact-renderers.ts`（`ARTIFACT_RENDERERS`）。fork 加 `{ match, render }` 项；`body-artifacts.tsx` 在核心 case 之后消费它们，让私有工具输出渲染成行内卡片，无需改 `body-artifacts.tsx`。
- **Global-Agent 页面上下文（URL→PageContext）** → `lib/context-resolvers.ts`（`registerUrlContextResolver`）。fork 为其私有路由（如 `#/crm/...`）注册解析器；`agent-context.tsx` 的 `resolveUrlContext` 对核心 switch 未覆盖的路由回退到该注册表。`PageContext.type` 含 `(string & {})` 成员，故 fork 类型无需改中央 union。
- **主页面 / 设置面板挂载**（`app.tsx` 的 Route union + 懒加载 + 渲染分支、`settings/index.tsx` 面板分支）目前仍是硬编码，是 S8 页面注册表接缝的待办项——新增私有页面暂时仍需改 `app.tsx`。

### 样式规范
- **Tailwind v4（编译模式）**——CSS 入口：`app.css`（由 `app.tsx` import），经 `@tailwindcss/vite` 插件构建，打进 `public/assets/index-*.css`
- **语义化颜色 token**——使用自动适配明暗主题的语义 class：
  - 表面：`bg-surface-raised`（卡片）、`bg-surface-muted`（高亮区域）、`bg-surface-sunken`（页面背景）
  - 文字：`text-fg`（主要）、`text-fg-secondary`（正文）、`text-fg-muted`（标签）、`text-fg-faint`（提示）
  - 边框：`border-edge`（普通）、`border-edge-strong`（输入框）、`divide-edge`
  - 状态：`text-danger`/`bg-danger-subtle`、`text-success`/`bg-success-subtle`、`text-warning`/`bg-warning-subtle`、`text-info`/`bg-info-subtle`
  - 破坏性操作：`bg-destructive`/`bg-destructive-hover`——禁止直接用 `bg-red-*`
  - 星级评分：`text-star`/`text-star-hover`——禁止直接用 `text-amber-*`
  - **禁止使用 `bg-white`、`text-gray-*`、`border-gray-*`、`bg-gray-*`、`bg-red-*`、`text-red-*`**——始终用上述语义 token
  - 开关/Toggle 圆点用 `bg-surface-raised` 替代 `bg-white`
- 主色：基于 CSS 变量的 `primary-*` 色板（如 `primary-500`、`primary-600`）
  - 主题定义在 `lib/theme.ts`，通过 CSS 自定义属性应用
  - **禁止硬编码颜色名**（如 `teal-500`、`emerald-500`）——始终用 `primary-*` 或语义 token（`text-success`、`bg-success-subtle`）
  - 可用主题：Teal Garden、Forest、Ocean、Blossom、Harvest、Rose、Midnight（暗色）、Deep Ocean（暗色）、AMOLED Black（暗色）
- 暗色模式：通过 CSS 变量自动切换——不需要 `dark:` 前缀。切换主题 = 切换 `--t-*` 变量值
- 主题过渡：bg/border/color 平滑 0.2s；`theme-loading` class 在首次渲染时抑制动画
- 动画：`animate-fade-in`、`animate-slide-up`、`animate-slide-in-left/right`、`animate-toast-in/out`、`animate-skeleton`
- 间距：`px-3 md:px-4` 区块、`p-3` 卡片、`gap-2` flex
- 圆角：`rounded-md` 小、`rounded-lg` 卡片、`rounded-xl` 弹窗、`rounded-full` 徽章
- z-index：`z-10` sticky、`z-20` dropdown、`z-40` backdrop、`z-50` modal、`z-[60]` 嵌套弹窗
- 字号：`text-[10px]` 时间戳、`text-xs` 标签、`text-sm` 正文、`text-base` 标题、`text-lg` 大标题
- 文本截断：`truncate` 旁边始终加 `title={value}`，悬停显示完整内容
- 扁平内容布局：详情/文章类视图（如知识库文档、设置子面板）正文**直接平铺**，不套 `<Card>` 凸显；元信息（标题/标签/时间）与操作（编辑/归档/历史）放在顶栏 `border-b border-edge bg-surface-raised` 行内；侧栏目录用 `border-r border-edge` 竖线分隔，**不加** `bg-surface-raised` 背景，可折叠。只有真正的数据容器才用单层 Card。
- 新建/编辑表单：用**整页视图**（顶栏 Back/Cancel 在左、Save 在右上角），不要用 Dialog 弹框；表单字段组件抽出复用（如知识库的 `EditorInline`/`EditorView`）。
- 列表分类筛选：用搜索框右侧的 `<Select size="sm" inline>` 下拉（默认"全部"+计数），不要单独的左侧分类栏/移动端 Drawer。

### 快捷键
- `Cmd+K` / `Ctrl+K`——切换 Agent 面板
- `Cmd+N` / `Ctrl+N`——新建聊天
- `Cmd+Escape`——关闭 Agent 面板
- `Escape`（无修饰键，输入框外）——关闭 Agent 面板（如已打开）
- 弹窗：Escape 关闭（通过背景点击处理）
- Popover（@提及/斜杠命令）：`↑↓` 导航、`Enter/Tab` 选中、`Escape` 关闭

### 聊天输入框（Composer）
- 输入框是纯 `<textarea>` + 结构化选中项，**不要**改成 contenteditable 富文本。
- `@` 触发 [mention-popover.tsx](./components/chat/mention-popover.tsx)：提及 agent profile = 切换当前会话 profile（仅新建会话生效，沿用 ProfileSelector 只读规则），驱动 `selectedProfileId`。
- `/` 触发 [command-menu-popover.tsx](./components/chat/command-menu-popover.tsx) 命令菜单：**快捷提示词** → 展开为可编辑文本。（技能 Skills / MCP 选择器是已移除的桌面端能力。）
- 选中的 profile 以**药丸**形式渲染在 [composer-chips.tsx](./components/chat/composer-chips.tsx)（textarea 上方），可移除。
- 触发检测复用 [use-trigger-popup.ts](./components/chat/use-trigger-popup.ts)（`insertSelection('')` 删 token、`insertSelection(text)` 展开）。
- `ChatInput` 被 ChatPage 与 AgentPanel 共用，新增 props 一律 optional。

### 移动端适配

所有新 UI 必须支持移动端（≥ 375px 宽度），遵循以下模式：

**断点：** `sm:`（640px）、`md:`（768px）、`lg:`（1024px）。以 `md:` 作为移动/桌面的主分界点。

**侧边栏：**
- 桌面侧边栏 → `hidden md:flex md:flex-col w-48`
- 移动端替代 → 横向可滚动标签栏（`md:hidden overflow-x-auto scrollbar-hide`）或由按钮触发的 `<Drawer>`
- 参考：Settings（`pages/settings/index.tsx`）、Knowledge（`pages/knowledge.tsx`）

**表格：**
- `<table>` 始终包在 `overflow-x-auto` 容器中
- 表格设置 `min-w-[600px]` 等，防止列压缩
- 移动端隐藏非核心列：`hidden md:table-cell`、`hidden lg:table-cell`
- 参考：Usage（`pages/settings/usage-enhanced.tsx`）

**筛选/工具栏：**
- 使用 `flex flex-wrap gap-2` 允许窄屏换行
- 筛选输入：`flex-1 min-w-[100px] sm:flex-none sm:w-[140px]` 模式
- 复杂工具栏：移动端隐藏次要控件（`hidden sm:flex`）
- 参考：项目详情工具栏（`pages/project-detail.tsx`）

**触摸交互：**
- **禁止仅依赖 hover 显示关键操作。** 配合 `group-hover:opacity-100` 使用 `.touch-visible` CSS 辅助类，确保触屏设备上按钮可见：
  ```tsx
  className="opacity-0 group-hover:opacity-100 touch-visible"
  ```
- `touch-visible` 类定义在 `index.html`，通过 `@media (hover: none)` 设置 `opacity: 1`

**iOS 安全区域：**
- 应用头部使用 `pt-[max(0.5rem,env(safe-area-inset-top))]`
- 底部输入区域使用 `pb-[max(0.75rem,env(safe-area-inset-bottom))]`
- viewport meta 标签已设置 `viewport-fit=cover`

**弹出/下拉宽度：**
- 固定宽度弹出框必须添加 `max-w-[calc(100vw-2rem)]` 防止溢出视口

**视图默认值：**
- 复杂视图（Gantt 图）在移动端应默认使用更简单的替代方案：
  ```tsx
  const [view, setView] = useState(() => window.innerWidth < 768 ? 'list' : 'gantt');
  ```

### 设置列表页规范（ListToolbar + EmptyState）

所有设置类列表页（`pages/settings/*`）统一同一套头部 + 空状态结构，**禁止各页手写 `flex + spacer + 按钮`**：

- **头部一行用 `<ListToolbar>`**（`components/ui.tsx`）：左侧 `hint` 一句话说明，右侧 `actions` 放操作（次要按钮如 Refresh 在前，**主操作 Create 按钮永远最后/最右**），`count` 放结果计数。
  - 不要再写大图标块头部（icon-box + `<h3>` 标题）——TopBar 面包屑已有模块名，重复即冗余。
  - `hint` 较长时用 `<span className="block max-w-2xl">…</span>` 约束换行宽度。
- **主操作按钮统一文案 `Create <X>`**（句首大写、单数名词），统一 `<Plus size={14} className="mr-1" />` + `size="sm"`。禁止 `New X` / `Add X` / 裸 `Create` 等参差写法；i18n 页改对应词条值（如 `automations.create` = `Create automation`）。
- **空状态一律 `<EmptyState>`**：`icon` 只接 Lucide 组件（**emoji 已被类型禁止**），把同一个 Create 按钮传给 `action` 槽，让空态也能直接创建。
- 没有"创建"语义的页（Memory 自动提取、Feature Requests 用户提交）：`<ListToolbar>` 只给 `hint` + `count`，`<EmptyState>` 不传 `action`。
- 配套：删除确认 `<ConfirmDialog>`（禁止 `confirm()`）、状态点 `<StatusDot>`、开关 `<Toggle>`——不要手写 `bg-green-100` / `w-2 h-2 rounded-full` 之类。
- 创建表单：单字段用 `sm` 居中 `<Dialog>`（如 Groups），多字段用 `lg` `<Dialog>`（如 Automation）或右侧 `<Drawer>`（如 My Agents），见「Dialog vs Drawer 交互约定」。

参考样板：`pages/settings/email-accounts.tsx`、`automations.tsx`、`prompts.tsx`。

### 列表筛选栏规范

所有列表页的顶部筛选栏必须遵循统一规范：**紧凑单行布局 + 可展开更多筛选**。

**核心原则：**
- 所有筛选控件放在**一行**内（`flex items-center gap-2 flex-wrap`）
- 常用筛选直接显示，不常用的收进 **"More ▼"** 可展开区域
- 每行右侧放操作按钮和结果计数，中间用 `<div className="flex-1" />` 撑开

**标准结构：**
```tsx
{/* Row 1: 主要筛选（始终可见） */}
<div className="flex items-center gap-2 flex-wrap">
  {/* 搜索 */}
  <SearchInput size="sm" className="flex-1 min-w-[120px] sm:flex-none sm:w-[180px]" />
  {/* 1-3 个高频筛选 Select */}
  <Select size="sm" inline> ... </Select>
  {/* More 展开按钮 */}
  <button className="text-xs ..."><Filter size={12} /> More ▼</button>
  <div className="flex-1" />
  {/* 结果计数 + 操作 */}
  <span className="text-xs text-fg-faint">{total} results</span>
</div>

{/* Row 2: 次要筛选（可折叠） */}
{showMoreFilters && (
  <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-edge">
    {/* 低频筛选控件 */}
  </div>
)}
```

**具体规则：**
| 规则 | 说明 |
|------|------|
| 搜索框 | 使用 `<SearchInput>` 组件，禁止手动拼 Search icon + Input |
| Select 筛选 | 使用 `<Select size="sm" inline>`（`inline` = `w-auto`） |
| Input 筛选 | 使用 `<Input size="sm" className="w-[120px]">` |
| 容器 | `border-b border-edge bg-surface-raised px-4 py-2.5` |
| 更多按钮 | 有次要筛选时显示，使用 `<Filter>` icon + "More ▼" / "Less ▲" |
| 日期范围 | 使用 `<DateRangeInput>` 组件 |
| 展开区域 | `pt-1 border-t border-edge`，与主行保持相同 flex 模式 |

**"More" 分界原则（哪些放主行 vs 展开区）：**
- 主行（始终可见）：搜索框、状态/类型等最高频 1-3 个筛选
- 展开区：日期范围、ID 搜索、评分、来源渠道等低频筛选

**筛选控件宽度细节：**
- 每个筛选控件包裹在 `<div className="flex-shrink-0 w-[xxxpx]">` 容器内
- `<Input>` / `<Select>` 默认 `w-full`，填充容器宽度，避免 Tailwind 类冲突
- **禁止**直接在 Input/Select 的 `className` 上写宽度类——会被组件内部 `w-full` 覆盖

### 列表表格规范（sticky / nowrap / tooltip）

所有列表 `<table>` 统一遵循：

- **表头 sticky**：`<thead className="sticky top-0 z-10 bg-<opaque> [&_th]:whitespace-nowrap">`，下滑时表头始终可见。bg 用不透明色（`bg-surface-sunken` 或 `bg-surface-muted`）。
- **关键陷阱**：sticky 只相对**最近的滚动祖先**生效。**禁止**把 `<table>` 再包一层 `<div className="overflow-x-auto">` 放进 `flex-1 overflow-auto` 里——`overflow-x-auto` 会让该 div 成为滚动容器（CSS 规范：一轴非 visible 另一轴自动算 auto），导致 thead sticky 失效。正确做法：**`<table>` 直接作为单个 `flex-1 overflow-auto` 容器的子元素**（横向滚动由外层 `overflow-auto` 一并处理，配合 `min-w-[Npx]`）。
- **表头不换行**：用 `[&_th]:whitespace-nowrap`（一个类作用于所有 `<th>`），不要让表头标签换行。
- **单元格默认单行**：表格加 `[&_td]:whitespace-nowrap`（一个类作用于所有 `<td>`），**所有单元格默认不换行、单行显示**。
- **单元格截断 + tooltip**：长自由文本列用**内层** `<span className="block max-w-[…] truncate" title={value}>`（auto-layout 表 `max-width` 必须放在内层块元素上，放 `<td>` 上不生效）超出省略；`title` 必须带，悬停看全文。`<Tag truncate>` / `<Badge truncate>` 已自动写 `title`。
- 非整页滚动的列表（页面级滚动、卡片内小表）可只做 nowrap + tooltip，sticky 视容器而定。

### 列表分页规范

所有分页列表统一用共享 `<Pagination>`（`components/ui.tsx`）+ `usePersistedPageSize`（`hooks/use-persisted-page-size.ts`）。

- **禁止**再手写 `Prev/Next`/Chevron 页脚，或在页面里定义 `const PAGE_SIZE = 20`。
- `<Pagination page pageSize total onPageChange onPageSizeChange />`——`page` 为 **0-based**；自带左侧区间文案、每页数量下拉（默认 `[20,50,100]`）、Prev/Next、`X / Y` 和跳页输入框；`total===0` 时自渲染为空。
- 每页数量用 `const [pageSize, setPageSize] = usePersistedPageSize('<scope>', 20)` 持久化到 localStorage（key 如 `knowledge`、`usage`）；**改变 pageSize 时调用方负责把 `page` 重置为 0**。
- 数据加载的 `limit/offset`（或 `page_size`）一律取自 `pageSize`，并把 `pageSize` 加入 `loadData` 依赖。
- 1-based 的旧页码在调用处做 `page={page-1}` / `onPageChange={(p)=>setPage(p+1)}` 适配，不改内部约定。

### 标签 Tag 规范

表格单元格 / 紧凑容器里的彩色标签**一律单行，宁可省略不换行**。

- 状态/结果/类型等单个标签 → `<Tag tone truncate>`（`components/ui.tsx`）。`tone` 取 `neutral|primary|success|warning|danger|info`，内置 `whitespace-nowrap`；在受限列里加 `truncate`（自动写 `title`，可用 `maxW` 调宽度）。
- 多标签单元格 → `<TagList items max>`，单行展示前 `max` 个再 `+N`，**不要** `flex-wrap`。
- **禁止**再手写 `text-[10px] px-1.5 py-0.5 rounded border ...` 的 pill `<span>`，也**禁止**在表格里用 `flex flex-wrap` 堆叠多个 Badge/Tag。
- 域值→tone 的映射集中在 `lib/utils.ts`——新增枚举改这里，各页 import，不要在页面里重复 `XXX_BADGE_VARIANT` 字典。
- `<Badge>` 也支持 `truncate` / `maxW`；圆角 pill 风格用 Badge，方角紧凑风格用 Tag。
- 例外：**详情页头部的标签云**（`<DetailHeader badges>`）是展示区，允许 `flex-wrap`；只有**表格/紧凑容器**强制单行。

### 详情页规范（查看 / 编辑）

所有记录详情页统一用 detail kit（`components/detail/`），查看与编辑共用同一套视觉原语。

- `<DetailHeader>` — 图标/头像 + 标题 + meta（id/时间戳）+ 状态标签（单行）+ 右侧操作（Edit/Refresh/Close/Back）。
- `<DetailSection title action>` — **扁平**区块（`border-b` 标题行），遵循「扁平内容布局」，**不 card-on-card**；只有真正的数据容器（如带边框的表格、进度条）才在 Section 内套单层 `<Card>`。
- `<FieldGrid cols>` + `<Field label value hideEmpty span>` — 字段统一 **label 在上、value 在下**；空值显示 `—`，`hideEmpty` 可整条隐藏；长文本用 `span="full"`。
- **禁止**再在页面里手写 `Section`/`InfoRow`（label 左 value 右）局部组件，或 `<Card><h3 uppercase>` 区块标题——统一走上述组件。
- 编辑表单：字段沿用 `<FieldGrid>`/`<Field>` 布局与查看态一致；头部 / 底部按钮 **Cancel 在左、Save 在右**。
- 参考：`pages/project-detail.tsx`、`components/knowledge/`。

### 知识库模块布局规范

适用范围：`pages/knowledge.tsx` 以及 `components/knowledge/` 中由知识库路由承载的页面。

- **不要在页面 body 重复模块标题**：TopBar 面包屑已经展示 `知识库 › 团队知识库 / 个人知识库 / 共享给我 / 新建文档`，列表页和工具栏内不要再放同名 `<h1>`。
- **列表页顶部使用紧凑单行工具栏**：搜索在左，结果计数和操作按钮在右；使用 `flex items-center gap-2 flex-wrap`，窄屏允许自然换行。
- **搜索框统一用 `<SearchInput size="sm" />`**，不要用普通 `<Input>` 或手写 Search icon。
- **详情页顶部工具条只放导航和操作**：如 `Back / Edit / Archive / History`；不要再展示路径文本，因为 TopBar 已有面包屑。正文中的文档标题属于内容标题，可以保留。
- **分类/范围筛选**：列表顶部工具栏用搜索框右侧的 `<Select size="sm" inline>` 切换范围（团队/个人/共享），不另起左侧分类栏。

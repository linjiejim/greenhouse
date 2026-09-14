---
name: add-frontend-page
description: >-
  在 greenhouse web 前端新增页面：ModulePage 页框 → nav-registry 注册 → app.tsx 懒加载路由 →
  ui.tsx 组件 + 语义化 token → hc 类型化 API → 移动端适配。用户说加个页面、新增前端页面、
  做个新界面、加个路由页时使用。核心红线：禁止原生 HTML + 内联 Tailwind、禁止硬编码颜色、
  页面身份只从导航注册表派生。Settings / Administration 子页请改用 add-settings-page。
---

# 新增前端页面

> 规范事实源是 [apps/web/src/AGENTS.md](../../../apps/web/src/AGENTS.md)（设计系统、样式 token、
> 移动端、组件目录都在那）。本技能只负责顺序与联动点；细节冲突以那份为准。
> **Settings / Administration 子页走 [add-settings-page](../add-settings-page/SKILL.md)**。

## 前置判断

1. **core 还是 extension？** 私有 / 可选模块的页面走扩展缝：
   `defineWebExtension({ modules, routes })`，见 [EXTENDING.md](../../../EXTENDING.md)
   与 `apps/web/src/extensions/example/page.tsx`。
2. **是不是列表 / 记录页？** 是的话优先 `@greenhouse/crud` 的 `defineCrud` + `CrudPage`，
   手写 `<table>` 属于 legacy（见 settings AGENTS.md 的 CRUD 一节）。
3. 需要的后端端点是否已有？没有先走 `add-api-route`。
4. 先翻 `components/` 与 `pages/design.tsx` 设计预览页，确认没有现成组件可用
   （根 AGENTS.md 的 anti-entropy 要求："别造第二个"）。

## 步骤 1：页面组件

在 `apps/web/src/pages/` 下建文件（复杂页面建子目录 + barrel `index.ts`）。

**常规总览 / 集合 / 列表页的根节点必须是 `<ModulePage>`**
（`components/app/module-page.tsx`）：

```tsx
<ModulePage moduleId="my-module" layout="list">
  …
</ModulePage>
```

- 页面图标、标题、说明**只从 `lib/nav-registry.ts` 的 `moduleId` 派生**，业务页不得手写 page header
- `layout` 三选一：`form`（配置表单，≤960px）、`list`（列表 / 数据页，≤1280px）、`canvas`（全宽沉浸工作区）
- 页级扩展按 `actions → notice → tabs → toolbar → content` 放进对应 slot
- `form` / `list` 的纵向滚动由 `ModulePage` 拥有；`canvas` 的内容子树自己声明 `h-full min-h-0 overflow-y-auto`
- **不得再自建外层 header、padding、`max-w-*` 或滚动容器**
- 记录详情、整页编辑器、数据工作区这类沉浸式页面继续用 Detail/Canvas 专用结构，不要为了统一硬套第二层页头

## 步骤 2：注册导航

在 `apps/web/src/lib/nav-registry.ts` 加模块项（`id` / `label` / `icon` / `path` / `description`，
按开关门控的加 `requireFeature`）。TopBar 面包屑与侧边栏都从这里读，数组顺序即展示顺序。

## 步骤 3：懒加载路由

在 `apps/web/src/app.tsx` 用 `React.lazy` + `Suspense` 注册。注意本仓页面多是**具名导出**，
所以要 `.then()` 取出：

```tsx
const MyPage = lazy(() => import('./pages/my-page').then((m) => ({ default: m.MyPage })));
```

`ChatPage` 是唯一即时加载（高频访问），其余页面**一律懒加载**。

## 步骤 4：UI 组件

**必须用 `components/ui.tsx` 的组件，禁止原生 HTML + 内联 Tailwind。** 常见对应：

| 需求 | 用 | 不要 |
| --- | --- | --- |
| 按钮 / 纯图标按钮 | `<Button>` / `<IconButton label>` | `<button className=…>` |
| 输入 / 下拉 / 多行 | `<Input>` `<Select>` `<Textarea>` | 原生 `<input>` `<select>` `<textarea>` |
| 搜索框 | `<SearchInput>` | Search icon + Input 手拼 |
| 复选 / 开关 | `<Checkbox>` `<Toggle>` | 原生 checkbox、手写 switch |
| 弹窗 / 确认 | `<Dialog>` `<ConfirmDialog>` | 手写 `fixed inset-0`、`window.confirm()` |
| 浮层 / 抽屉 | `<OverlayPanel>` `<Drawer>` | 手写 backdrop |
| 通知 | `toast()` | `alert()` |
| 空态 | `<EmptyState>` | 手写 `flex justify-center py-*` |
| 加载 | `<Skeleton>` / `<SkeletonRow>` / `<Spinner>` | 空白 |
| 表单布局 | `components/form/` 的 `FormField` / `FormGrid` / `FormActions` | 各写一套 label/help/error 间距 |

- **Dialog vs Drawer**：列表上下文内的创建 / 编辑表单 → 居中 `<Dialog>`；
  浏览类详情 / 辅助面板 → 右侧 `<Drawer>`；长文档或多步骤 → 整页视图
- 新增弹层一律经 `<OverlayFrame>` 底座接入，不要再手写安全区 / Escape / 滚动锁那一套
- 禁止用 `!important` 覆盖组件样式

## 步骤 5：语义化颜色 token

**禁止任何硬编码颜色**：`bg-white`、`text-gray-*`、`border-gray-*`、`bg-gray-*`、`bg-red-*`、
`text-red-*`，以及 `teal-500`/`emerald-500` 这类色名。改用：

- 表面：`bg-surface-canvas`（页面）、`bg-surface-card`（数据卡片）、`bg-surface-raised`（输入框/顶栏/弹窗）、
  `bg-surface-muted`、`bg-surface-sunken`、`bg-surface-chrome`（侧栏/Composer）
- 文字：`text-fg` / `text-fg-secondary` / `text-fg-muted` / `text-fg-faint`
- 边框：`border-edge` / `border-edge-strong` / `divide-edge`
- 状态：`text-danger`/`bg-danger-subtle`、`text-success`、`text-warning`、`text-info`（各配 `-subtle`）
- 破坏性操作 `bg-destructive`；星级 `text-star`
- 主色 `primary-*`（基于 CSS 变量）

暗色模式由 CSS 变量自动切换，**不需要 `dark:` 前缀**。
坐在 `bg-primary-subtle` 上的**文字**用 `text-primary-fg-strong`（`primary-fg` 只够图标）。

## 步骤 6：API 调用

- **首选 hc 类型化调用**：领域模块写 `lib/api/<domain>.ts`，经 `lib/api/client.ts` 的 `rpc`
  （`hc<AppType>` over authFetch，自动 Bearer + 401 刷新）。响应类型由服务端实现推导，
  **与声明类型冲突 = 编译期漂移告警，禁止用 `as` 压掉**
- 无 validator 的路由传 json/query 要用**变量间接**：`const args = { param, json }; rpc…$put(args)`；
  param 含 `/` 或 `%` 时显式 `encodeURIComponent`
- 流式（NDJSON）与 FormData 端点保持 raw `authFetch()`（`lib/auth.ts`）
- 历史遗留的 `lib/*-api.ts` + `fetchJson<T>()` **不要在新代码里用**
- NDJSON 解析统一 `readNdjsonStream<T>()`，事件分发统一 `handleStreamEvent()`
  （`lib/stream-utils.ts` / `lib/stream-events.ts`），不要手写 `reader.read()` 循环或 `switch(event.type)`

## 步骤 7：状态与图标

- 全局状态用 Zustand store（`stores/`）；页面级用 `useState` / `useReducer`
- **禁止为全局状态新建 React Context**
- 图标全部从 `lib/icons.ts` 导入（Lucide React），尺寸 `12` 行内 / `14` 按钮 / `16` 导航 / `20` 标题
- **禁止用 emoji 当图标**

## 步骤 8：移动端适配

所有新 UI 必须支持 ≥375px：

- 断点 `sm:640` / `md:768` / `lg:1024`，以 `md:` 为移动/桌面主分界
- 表格：包 `overflow-x-auto`，设 `min-w-[600px]`，非核心列 `hidden md:table-cell`
- 筛选 / 工具栏：`flex flex-wrap gap-2`
- 移动端侧栏替代：横向滚动标签栏（`md:hidden overflow-x-auto scrollbar-hide`）或 `<Drawer>`
- 文本截断 `truncate` 旁边始终加 `title={value}`

## 步骤 9：门禁

```bash
pnpm typecheck
pnpm lint
pnpm test        # 前端单测在 tests/web/
```

浏览器验收（`pnpm dev` 开 `:3100`，或 `pnpm run-dev up`）：桌面、375px 移动端、明暗两种主题。
可见 UI 改动后重跑 `node scripts/capture-screens.mjs` 让文档截图保持真实。

## 检查清单

- [ ] 判断过 core vs extension；列表页优先 `@greenhouse/crud`
- [ ] 根节点是 `<ModulePage moduleId layout>`，没有自建 header / padding / max-w / 滚动容器
- [ ] `lib/nav-registry.ts` 已注册（含 `requireFeature`，若需要）
- [ ] `app.tsx` 懒加载注册（具名导出记得 `.then()`）
- [ ] 只用 `ui.tsx` / `components/form/` 组件，无原生 HTML + 内联 Tailwind
- [ ] 无硬编码颜色，全部语义 token；无 `dark:` 前缀；无 `!important`
- [ ] API 走 `lib/api/` + `rpc`（流式/上传除外），没有 `as` 压类型
- [ ] 全局状态用 Zustand，未新建 Context
- [ ] 图标来自 `lib/icons.ts`，无 emoji
- [ ] 移动端 ≥375px 正常；`truncate` 配 `title`
- [ ] typecheck + lint + test 通过，浏览器实际看过明暗两态

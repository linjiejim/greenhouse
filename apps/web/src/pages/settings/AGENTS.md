## Settings 页面布局规范

### 结构
- 每个子页面是一个 Panel 组件，在 `settings/index.tsx` 中挂载
- **不要在 body 中重复页面标题**——TopBar 面包屑已展示 "Settings › xxx" + 描述
- **全宽布局**：外层容器提供 `px-3 md:px-4 py-4`，子页面内不要再加 `max-w-*` / `mx-auto` / 额外 padding
- 若页面有自己的固定 Tabs 栏（如 AI Gateway 的 upstreams/models/keys），保持 `h-full flex flex-col overflow-hidden` 模式

### 添加新页面
模块（导航 + 分组 + 权限）的唯一真相是 `lib/nav-registry.ts` 的 `settingsSections`，**不再**在 `settings/index.tsx` 里维护 MODULES 数组。
1. 在 `pages/settings/` 下创建 `xxx.tsx`，导出 `XxxPanel` 组件
2. 在 `lib/nav-registry.ts` 把模块加入对应 section 数组（`SETTINGS_TOP` / `SETTINGS_PERSONAL` / `SETTINGS_WORKSPACE` / `SETTINGS_ADMIN` / `SETTINGS_LABS`）；填 `id`/`label`/`icon`/`path`/`description`，super-only 项加 `requireRole: ['super']`（整段 section 也可用 `requireRole` 门控）
3. 在 `settings/index.tsx` import 该 Panel，并在渲染区域添加 `{effectiveModule === 'xxx' && <XxxPanel />}`（模块列表由 `settingsAllModules` 自动派生，无需再手写数组）
4. TopBar 面包屑与侧边栏都从 `nav-registry` 读取，顺序即 `settingsSections` 中的顺序

### 页面分组与权限（见 `settingsSections`）
- **Preferences（无分组标题，置顶，内部全员可见）**
- **Personal（内部全员可见）**：Automation、My Prompts、My Agents
- **Workspace（内部全员可见）**：Groups、Cloud Email
- **Administration（super only）**：Users、AI Gateway、MCP Access、System Agents、Agent Usages、Feature Requests
- **Labs（super only）**：Memory

### 列表页范式（参考 Users / Feature Requests）
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
- 可展开行：点击 row 展开详情（`<td colSpan={N}>`），参考 Feature Requests

### 表单/配置页范式（参考 Preferences）
- 使用 Card 卡片式布局（`bg-surface-raised border border-edge rounded-xl p-4`）
- 利用 `grid` 自适应，不限宽

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

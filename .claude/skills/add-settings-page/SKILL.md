---
name: add-settings-page
description: >-
  在 greenhouse 新增 Settings（个人配置）或 Administration（super 全局管理）子页：
  Panel 组件以 ModulePage 为根 → nav-registry 单一真源注册 → index.tsx 挂载 →
  列表页用 @greenhouse/crud。用户说加个设置页、新增 Settings 子页、加个管理页、
  加后台页面时使用。核心红线：导航真源只有 nav-registry（不再维护 MODULES 数组）；
  defineCrud 的 access 权限默认全 false，能写就必须显式声明。
---

# 新增 Settings / Administration 页面

> 规范事实源是 [apps/web/src/pages/settings/AGENTS.md](../../../apps/web/src/pages/settings/AGENTS.md)，
> 通用前端规范见 [apps/web/src/AGENTS.md](../../../apps/web/src/AGENTS.md)。
> 本技能只负责顺序与联动点。

## 前置判断：放哪一边

| 分区 | 位置 | 可见性 |
| --- | --- | --- |
| **Settings**（个人配置） | `apps/web/src/pages/settings/` | 内部全员 |
| **Administration**（全局管理） | `apps/web/src/pages/administration/` | **super only**（整体已 `requireRole: ['super']`） |

现有 Settings：Preferences、Groups、Agent Connections、Connections（企微 / 飞书绑定）、
Email Accounts、Memory（Labs，`requireFeature: 'memory'`）。
现有 Administration：Users、Agent Usages、Feature Requests、Frictions、Evaluation、
AI Gateway、MCP Access、Runtime Config、Branding Studio。

注意 Automation、Prompt Tasks、My Agents 是**独立页面**（`#/automations`、`#/tasks`、`#/agents`），
不是 Settings 子页；持久执行统一在 `#/executions` 执行中心。

扩展贡献的设置模块走 `defineWebExtension({ settingsModules })`，见 [EXTENDING.md](../../../EXTENDING.md)。

## 步骤 1：Panel 组件

在对应目录建 `xxx.tsx`，导出 `XxxPanel`，**根节点必须是 `<ModulePage>`**：

```tsx
export function XxxPanel() {
  return (
    <ModulePage moduleId="settings.xxx" layout="form">
      …
    </ModulePage>
  );
}
```

- `layout`：配置表单 `form`（≤960px）／列表数据页 `list`（≤1280px）／固定页头的沉浸工作区 `canvas`（全宽）
- **不要在 body 里重复页面标题**——图标 / 标题 / 说明由 `nav-registry` 的 `moduleId` 派生
- **不要**加 `max-w-*`、`mx-auto`、页面 padding 或额外 `overflow-y-auto`，页框已经拥有这些
- 常规配置内容用 `SettingsPanel` + `SettingsSection`（统一 `space-y-4` 与标题层级），
  字段用 `components/form/` 的 `FormField` / `FormGrid` / `FormActions`，
  **禁止手写另一套 Card header 或 `space-y-6/8`**
- 页面画布 `bg-surface-canvas`，数据卡片用共享 `<Card>`，输入框与弹窗用 `bg-surface-raised`

## 步骤 2：列表 / 记录页一律走 `@greenhouse/crud`

新增页面或大改**一律**用 `defineCrud<Row>` + `<CrudPage>`（工具栏、筛选、排序、分页、
新增/编辑 Dialog、详情 Drawer、删除确认、空态全由框架统一）。手写 `<table>` 属于 legacy。

- **必须从 `./crud`（本目录的绑定模块）import，不要直接 import `@greenhouse/crud`**——
  绑定模块负责 `installCrudUi()`，把 app 的 ui.tsx 组件与 toast 注入框架
- 数据源：已有 hc / typed client 的写 `CrudDataSource` 适配器（零服务端改动）；
  全新资源可用服务端 `createCrudRoutes`（`@greenhouse/crud/server`，guard 直接传
  `requireInternal()` / `requireSuper()`）+ 客户端 `createRestDataSource`
- ⚠️ **能写就必须显式声明 `access`**：`defineCrud` 把 `canView` / `canAdd` / `canEdit` /
  `canDelete` **全部默认 false**，权限为假时框架**根本不构建行操作列**——于是
  `dataSource.update` / `remove`、`formFields`、`deleteConfirm` 全成了触达不到的死配置，
  而类型、lint、端点测试、页面渲染**全都不会报**。护栏在
  [tests/web/crud-write-access.test.ts](../../../tests/web/crud-write-access.test.ts)
- bespoke 需求走 escape hatch：`type:'custom'` 列/字段、`slots`（toolbar/banner/empty/rowExpand/renderCard）、
  `tableActions` / `pageActions`、`deleteConfirm`
- 字段的次要解释用 `help`（标题旁信息图标）；`comment` 只留给禁用原因、校验后果这类必须常驻的提示
- 框架 chrome 经 `pages/settings/crud.ts` 注入宿主 `useT()`；schema 的 name/label/empty/delete
  文案同样传页面自己的 `t()` 结果，**禁止恢复 English-only**
- 参考实现（都是真在跑的 `defineCrud` 页）：`pages/tasks.tsx`（表格 + 表单 + custom 字段）、
  `pages/settings/groups.tsx`（toolbar / rowExpand slot + 行内创建）、
  `pages/automations.tsx`（toggle 列 + tableActions + cron builder）、
  `pages/settings/email-accounts.tsx`、`pages/settings/oauth-grants.tsx`、
  `pages/administration/frictions.tsx`

## 步骤 3：注册到 nav-registry（**唯一真源**）

在 `apps/web/src/lib/nav-registry.ts` 把模块加进对应数组：

- 个人项 → `SETTINGS_TOP`（置顶扁平区）或 `SETTINGS_LABS`（功能开关）
- super-only 全局管理项 → `ADMINISTRATION_MODULES`

字段：`id`、`label`、`icon`（Lucide 组件）、`path`（hash 路由）、`parent`、`description`，
按用户功能开关门控的加 `requireFeature`。**数组顺序即侧边栏与面包屑顺序。**

> **不再**在 `settings/index.tsx` 里维护 MODULES 数组，也不用再改 `top-bar.tsx` 或
> `settings-nav-panel.tsx`——TopBar 面包屑和侧边栏都从 `nav-registry` 读。

## 步骤 4：挂载 Panel

只需 import 并挂上：

- Settings → `apps/web/src/pages/settings/index.tsx`（模块列表由 `settingsAllModules` 自动派生）
- Administration → `apps/web/src/pages/administration/index.tsx`

## 步骤 5：验收与门禁

```bash
pnpm typecheck
pnpm lint
pnpm test
```

浏览器验收：导航项出现在正确分区、TopBar 面包屑正确、深链 / 刷新 / 后退保持当前页、
移动端模块 tabs 正常、明暗两态正常。给 crud schema 设 `testId`，
框架会自动派生 `{testId}-add` / `-field-{key}` / `-submit` / `-delete` 等 e2e 选择器
（Playwright 用例在 `tests/e2e-ui/`）。

## 检查清单

- [ ] 分区选对（Settings 个人 vs Administration super-only）
- [ ] Panel 根节点是 `<ModulePage moduleId layout>`，body 里没有重复标题 / max-w / 自建滚动
- [ ] 列表页用 `defineCrud` + `CrudPage`，且从 `./crud` 绑定模块 import
- [ ] **写能力对应的 `canEdit` / `canDelete` / `canAdd` 已显式声明**
- [ ] 文案走 `t()`，没有 English-only 硬编码
- [ ] `lib/nav-registry.ts` 已注册（正确数组 + `requireFeature`）
- [ ] Panel 已在 `settings/index.tsx` 或 `administration/index.tsx` 挂载
- [ ] 没有去改 `top-bar.tsx` / `settings-nav-panel.tsx`（它们从注册表读）
- [ ] crud schema 设了 `testId`
- [ ] 移动端 ≥375px 正常；typecheck + lint + test 通过

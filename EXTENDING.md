# 扩展 Greenhouse v2

扩展是部署者审核、编译进服务端与 Web 的可信代码。它复用 v2 的成员身份、服务、工具审批与 Provider 管理；不提供运行时安装任意代码的接口。

## 注册与启用

1. API：在 `apps/api/src/extensions/<id>/` 导出 `defineExtension(...)`，只在 `apps/api/src/extensions/index.ts` 登记。
2. Web：在 `apps/web/src/extensions/<id>/` 导出 `defineWebExtension(...)`，只在 `apps/web/src/extensions/index.ts` 登记。
3. 在根目录 `greenhouse.config.ts` 的 `extensions.enabled` 写 ID 列表或 `'all'`。默认空列表；`GREENHOUSE_EXTENSIONS=example`、`all` 或空值可在 API 启动时覆盖。
4. API 在启动时校验启用项、注册适配器并执行启用扩展的迁移，再创建服务与开始监听。未知 ID 或重复 ID 会阻止启动。
5. Web 编译进所有已登记扩展，仅显示 `GET /api/extensions` 返回的启用项及其声明的分区、页面与详情面板。管理员分区仅返回给管理员。

```ts
import { defineExtension } from '../../extension-kit.js';

export const myExtension = defineExtension({
  id: 'my-module',
  name: 'My module',
  pages: ['records'],
  // routes: (services) => new Hono<AppEnv>()...
  // tools: (services) => [defineTool(...)],
});
```

API 的公共导入是 `apps/api/src/extension-kit.ts`；Web 的是 `apps/web/src/extension-kit.ts`。数据库与契约分别从 `@greenhouse/db`、`@greenhouse/contract` 导入。扩展独有的 zod 契约可放在 `packages/contract/src/extensions/<id>.ts`，通过 `@greenhouse/contract/extensions/<id>` 导入；核心不导出或导入这些实现。

## 扩展面

| 扩展面 | API `defineExtension` | Web `defineWebExtension` |
| --- | --- | --- |
| 页面 | `pages: ['records']` 声明路由 ID | `pages: [{ id, label: { zh, en }, component }]`；`#/ext/<id>/<page>[/<path>]`；组件收到 `path`、`params`，出现在「更多」及窄屏模块菜单 |
| HTTP | `routes(services)` 返回 Hono，固定挂到 `/api/ext/<id>` | 使用统一 `api.request`，沿用刷新令牌及错误处理 |
| Agent 工具 | `tools(services)` 返回现有 `ToolDef`；名称必须以 `ext_<id 的下划线形式>_` 开头 | 复用现有过程、审批与结果展示 |
| 全局搜索来源 | `searchSources(services)`；每项有 `id`、`search(memberId, query, limit)`，返回 `id/title/snippet?/path` | ⌘K 自动显示 `extensions` 分组的结果；`path` 只能落在该扩展的 `#/ext/<id>/` 下 |
| Provider 适配器 | `providerAdapters` 使用现有 `ProviderAdapter`；kind 以 `<id>-` 开头 | 自动加入现有管理 → 服务的配置表单，复用适配器的 schema 和 secretKeys |
| 设置分区 | `settingsSections` 声明 ID；扩展路由调用自己的成员设置服务 | `settingsSections`；`#/settings/ext/<id>/<section>` |
| 管理分区 | `adminSections` 声明 ID；`/api/ext/<id>/admin` 及子路由强制管理员 | `adminSections`；`#/admin/ext/<id>/<section>`，同时检查管理员身份 |
| 实体详情面板 | `entityPanels: [{ id, entity }]` 声明面板；数据仍由扩展服务检查可见性 | `entityPanels` 的组件收到实体 `id`；支持 doc、agent、record、app、skill、run，或扩展自己的 `ext:<id>:<kind>`；自有实体页调用 `ExtensionPanels` |
| 独立迁移 | `migrations: { dir }` 绝对目录 | 无 |

没有工作台配方、按成员功能开关、公共回调或 `/api/agent` 工具代理等旧扩展面。外部 MCP 接口仍是核心已定义的权限组；注册 Agent 工具不会自动把它公开到 MCP。

## 权限与网络

- 每个扩展 HTTP 路由都先经过核心 `requireMember`，使用当前数据库里的角色、状态和 auth_version。扩展不能替换核心路由或增加匿名入口。
- 路由用 zod 解析请求，服务负责查询、事务与权限；路由、搜索、面板和工具调用同一服务。仅藏 UI 不算权限检查。成员设置只属于本人；工作区设置修改须在同一事务记 `audit`，摘要只列字段名。
- 工具完整沿用 read / tier1 / tier2 / tier3；声明写入风险，通过审批执行器运行。公开 Agent 默认看不到扩展工具，除非工具明确声明 `publicAgent` 并按使用者权限处理。工具读取不可信数据须标记 `taints`；后台的 private/outbound 限制照常适用。
- 外部调用只走 `services.providers`。扩展适配器必须使用其 `create` 获得的 pinned `fetch`，仅到配置的 `endpoints`；不能直接使用全局 fetch、厂商 SDK 或环境变量里的密钥。服务解析、机密封装、计量、预算与回退均复用核心。
- 用户文案使用中英字典，样式使用组件库与设计 token；面板错误局部显示。删除扩展时同时删除自己的声明、契约、迁移与测试，核心不保留兼容占位。

## 数据库迁移

扩展表以 `ext_<id 的下划线形式>_` 命名，不进入核心 baseline。独立目录中的 `NNNN_name.sql` 按文件名排序，可用 `--> statement-breakpoint` 分隔语句。已执行文件只能追加，不能修改、删除或在前面插入文件。

核心表 `extension_migrations` 以 `(extension_id, name)` 为主键，记录 checksum 与 applied_at。启动只迁移启用项；所有待执行文件在一个事务和同一个 advisory lock 下执行，失败整体回滚。多个副本同时启动不会重复执行。迁移漂移会阻止启动，不能自动抹掉记录或覆盖 SQL。

核心 schema 改动仍编辑 `packages/db/src/schema` 后运行 `pnpm db:generate --name <改动>` 生成下一份迁移；已发布的迁移不能重新生成或修改；不要用扩展通道修改核心表，也不要直接运行裸 `drizzle-kit migrate`。

## 完整示例与验证

仓库的 `example` 扩展覆盖上表每个扩展面：每人私有笔记、成员和管理员设置、文档详情及自有实体面板、带审批的写工具、搜索来源、使用 pinned fetch 的搜索适配器和独立 SQL 迁移。平常默认关闭；Web 浏览器测试启用它。

- API：`apps/api/src/extensions/example/`，测试在 `extensions/__tests__/example.db.test.ts`，覆盖鉴权、私有数据、管理审计、审批执行、迁移 checksum、Provider 计量。
- Web：`apps/web/src/extensions/example/`，浏览器验证在 `apps/web/e2e/platform.e2e.ts`，覆盖页面、设置、管理、详情面板、搜索和 light/dark/390 px。
- 防泄漏：`tests/architecture/extensions.test.ts` 扫描静态导入、再导出、动态导入和 require；只有两端的 `extensions/index.ts` 可从核心侧导入具体扩展。核心可依赖通用 define/host 与公共 extension-kit。

私有覆盖层保留自己的扩展目录、扩展契约、注册清单和部署配置。需要新通用能力时，先给核心增加一个可验证的扩展面，再让私有代码使用它。

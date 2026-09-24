---
name: full-feature
description: >-
  greenhouse 端到端功能开发的编排技能：需求分析 → core/extension 归属决策 → DB → 共享类型 →
  API → 前端 → Agent 工具 → 测试 → 门禁 → 文档。是 add-db-table / add-api-route /
  add-frontend-page / add-settings-page / add-agent-tool / quality-gate 的超集。
  用户说做个完整功能、端到端实现、从表到页面都要、full feature 时使用。
---

# 端到端功能开发

本技能只做**编排与决策**，每一层的细则在对应子技能里，不在这里复制（复制必然漂移）：

| 层 | 子技能 | 规范事实源 |
| --- | --- | --- |
| 数据库 | [add-db-table](../add-db-table/SKILL.md) | `packages/db/src/AGENTS.md` |
| API | [add-api-route](../add-api-route/SKILL.md) | `apps/api/src/AGENTS.md` |
| 前端页面 | [add-frontend-page](../add-frontend-page/SKILL.md) | `apps/web/src/AGENTS.md` |
| Settings / 管理页 | [add-settings-page](../add-settings-page/SKILL.md) | `apps/web/src/pages/settings/AGENTS.md` |
| Agent 工具 | [add-agent-tool](../add-agent-tool/SKILL.md) | `apps/api/src/tools/define.ts` |
| Agent 角色 | [add-agent-profile](../add-agent-profile/SKILL.md) | `apps/api/src/profiles/AGENTS.md` |
| 门禁 | [quality-gate](../quality-gate/SKILL.md) | 根 `AGENTS.md` |

## Phase 0：需求分析与归属决策

编码前先答完这几问：

1. **数据模型**：需要哪些表？字段？关系（域内 FK 还是跨域逻辑关联）？
2. **API 设计**：哪些端点？鉴权级别（内部全员 / 仅 super / feature flag 门控）？
3. **前端**：列表页？详情页？表单？放导航哪一格？能不能直接用 `@greenhouse/crud`？
4. **Agent 面**：模型需要调用它吗？需要经 `/api/agent`、`/api/mcp` 吗？
5. **权限模型**：走 feature flag 还是 feature point？谁能看、谁能写？

### ⚠️ 最关键的一问：core 还是 extension？

**私有、可选、实验性、或只服务某个部署的模块，应该走扩展缝，而不是改 core。**

```
apps/api/src/extensions/<id>/    ← tools, routes, tables + migrations, services, jobs, commands, flags
apps/web/src/extensions/<id>/    ← pages, navigation, settings modules, translations, chat cards
apps/api/src/extensions/index.ts ← import + 一行列表项
apps/web/src/extensions/index.ts ← import + 一行列表项
```

除这两行外 core 不动：工具目录、路由挂载、平台应用、功能开关与功能点、工作区设置、
公共路径、调度器、CLI、数据库 service 与迁移、hash 路由、侧边栏、i18n、工具卡片、
Agent 上下文，全部从**激活的扩展集**里聚合。

- 参考实现 `apps/api/src/extensions/example/` + `apps/web/src/extensions/example/`（两边合起来覆盖了每个字段）
- 契约与字段表见 [EXTENDING.md](../../../EXTENDING.md)
- 开关在 `greenhouse.config.ts` 的 `extensions.enabled`（`GREENHOUSE_EXTENSIONS` 可在 boot 覆盖）
- **core 永远不能按 id 引用某个扩展**。缺 hook 就给契约和注册表加 hook（同时补 example 与 seam 测试），
  绝不在 core 里写 `case '<extension-id>'` 这种特判
- 缝本身的护栏是 `apps/api/src/extensions/__tests__/seam.test.ts` 与
  `apps/web/src/extensions/__tests__/seam.test.ts`
- （仅 fork 场景）`node scripts/check-extension-overlay.mjs` 是**下游 fork 的 CI 护栏**——
  它断言 fork 在 upstream 之上的改动都待在扩展缝内。上游仓库自身没有东西要查，不必跑

### 其次一问：能不能不新增？

根 AGENTS.md 的 anti-entropy 是硬门禁：加"第二个做同一件事的东西"之前，
必须先确认现有实现不能复用或扩展，并把理由登记进相关 AGENTS.md。
非平凡的跨切面功能先在 `docs/specs/` 写 spec（`YYYYMMDD-<kebab-name>.md`，目录是本地的）。

## Phase 1：数据库

→ [add-db-table](../add-db-table/SKILL.md)

schema → 域 service → `provider.ts` 注册 → `pnpm drizzle-kit generate`（仓库根）→
review SQL → `db-schema.md`。**持久库只 `migrate` 永不 `push`。**

## Phase 2：共享类型

- 前后端共享的类型放 `packages/types/src/`，从 `@greenhouse/types` 导入
- 需要工具函数先查 `packages/utils/`（`date` / `json` / `concurrency` / `crypto` / `error` …），**不要重造**

## Phase 3：API

→ [add-api-route](../add-api-route/SKILL.md)

链式 `new Hono<AppEnv>()` → 守卫 → 经 db service → 在 `mountRoutes()` 单链挂载
（**顺序有安全语义，禁止重排**）。`AppType` 即前端 typed client 的契约。

## Phase 4：前端

→ [add-frontend-page](../add-frontend-page/SKILL.md)（Settings / 管理页走
[add-settings-page](../add-settings-page/SKILL.md)）

`<ModulePage>` 根 → `lib/nav-registry.ts` 注册 → `app.tsx` 懒加载 →
`ui.tsx` 组件 + 语义 token → `lib/api/` + `rpc` → 移动端 ≥375px。
列表 / 记录页优先 `@greenhouse/crud`，**写能力必须显式声明 `access`**。

## Phase 5：Agent 集成（按需）

→ [add-agent-tool](../add-agent-tool/SKILL.md)

`defineTool({ meta, kind, create? })` 同文件 → `registry.ts` 的 `CORE_TOOL_MODULES`（lazy 工具再到
`buildLazyServerTools` 接构造分支）→
`surface` 决定 proxy/MCP 暴露 → 归属一个 feature point。
**多数情况不需要改 profile YAML**（系统 profile 的 `tools:` 运行时不读取）。

## Phase 6：测试

三层（命名决定跑在哪个 project，见根 AGENTS.md 的 Testing 表）：

| 层 | 文件名 | 放哪 |
| --- | --- | --- |
| 单元 / 契约 | `*.test.ts(x)` | `tests/api/`、`tests/web/`、`tests/utils/` 或模块内 `__tests__/` |
| DB 集成（事务回滚） | `*.db.test.ts(x)` | `tests/db/`、`tests/api/` |
| 已提交态 DB（串行） | `*.db-commit.test.ts(x)` | 仅限多连接可见性 / DDL / 锁竞态，文件头写 `@db-commit-reason` |
| 安全 / 隔离 E2E | `*.e2e.test.ts` | `tests/e2e/`（`pnpm test:e2e:ci`） |
| 浏览器 E2E | `*.spec.ts` | `tests/e2e-ui/`（`pnpm test:e2e:ui`） |

- 内部测试用户用 `tests/helpers/internal-user.ts`；不要 `resetSchema()`
- 每条测试自建 fixture、断言 `create` 返回的 id，**不要依赖固定 serial id**
- 每个测试只断言自己造的行（事务只藏自己的写入）

## Phase 7：门禁

→ [quality-gate](../quality-gate/SKILL.md)

```bash
pnpm typecheck && pnpm lint && pnpm test
```

## Phase 8：文档

按改动面更新（清单见 quality-gate 的文档同步表）。硬要求：

- schema 变更 → `db-schema.md`
- 结构 / 约定变更 → 对应 AGENTS.md
- 对人的行为变化 → `README.md`
- 扩展契约变更 → `EXTENDING.md` + example + seam 测试
- 可见 UI 变化 → 重跑 `node scripts/capture-screens.mjs`
- **删除同样要同步文档并级联清理孤儿**

## 本地验收

```bash
pnpm dev            # web :3100（代理 /api 到 :3000），开 :3100
# 或
pnpm run-dev up     # Postgres + API + web 一起起，日志在 .run-dev/logs/
pnpm seed           # 示例数据集
```

worktree 会自动拿到自己的库 `greenhouse_wt_<dir>`——**不要从 worktree 对主库跑迁移**，
端口冲突交给引擎仲裁，不要手工 kill 进程。

## 总检查清单

- [ ] Phase 0 的五问答完，且明确了 core vs extension
- [ ] 登记过"为什么不能复用现有实现"（若新增了并行实现）
- [ ] DB：schema + service + provider + generate 的迁移 + `db-schema.md`
- [ ] 类型进 `@greenhouse/types`；helper 先查 `packages/utils/`
- [ ] API：链式定义 + 守卫 + `mountRoutes()` 挂载（未重排）
- [ ] 前端：ModulePage + nav-registry + 懒加载 + 语义 token + 移动端
- [ ] Agent 工具（若有）：defineTool + registry + surface + feature point
- [ ] 三层测试齐备，命名正确
- [ ] `pnpm typecheck && pnpm lint && pnpm test` 全绿
- [ ] 相关 AGENTS.md / README / EXTENDING.md 已同步；截图已重跑（若 UI 变化）

---
name: add-api-route
description: >-
  在 greenhouse 里新增 Hono API 路由：顶部端点注释块 → 链式定义 new Hono<AppEnv>() →
  鉴权守卫 → 经 db service 取数 → mountRoutes 单链挂载 → 共享类型 → tests/api。
  用户说加个接口、新增 API、加条路由、写个 endpoint 时使用。核心红线：必须链式定义
  （否则从 AppType 契约里消失）、响应对象里不许有 any、注册顺序有安全语义。
---

# 新增 API 路由

> 规范事实源是 [apps/api/src/AGENTS.md](../../../apps/api/src/AGENTS.md)。
> 本技能只负责顺序与联动点；冲突时以那份为准。

## 前置判断

1. **core 还是 extension？** 私有 / 可选模块的路由走扩展缝：
   `defineExtension({ routes: [{ path: '/api/ext/<id>', app, guards }] })`，
   见 [EXTENDING.md](../../../EXTENDING.md) 与 `apps/api/src/extensions/example/routes.ts`。
   扩展路由**不进** `AppType` 公共契约。
2. 需要的 db service 是否已存在？没有先走 `add-db-table`。
3. 定好访问级别：内部全员（team + super）还是仅 super。

## 步骤 1：路由文件

在 `apps/api/src/routes/<资源>.ts` 建文件，每个资源一个。

**顶部注释块（必须）**，逐条列出端点：

```typescript
/**
 * Session Tag routes — /api/session-tags
 *
 * GET    /api/session-tags       — 获取当前用户的所有标签
 * POST   /api/session-tags       — 创建新标签
 * DELETE /api/session-tags/:id   — 删除标签
 */
```

**必须链式定义**（2026-06 起，hc 契约的前提）：

```typescript
import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';

const myRoutes = new Hono<AppEnv>()
  .get('/', async (c) => {
    const user = getAuthUser(c);
    const rows = await getDb().myDomain.listByUser(user.id);
    return c.json({ rows });
  })
  .post('/', async (c) => {
    // ...
  });

export default myRoutes;
```

- **禁止语句式注册**（`app.get(...)` 单独成句）——语句式不积累类型，端点会从 `AppType` 契约里消失
- 工厂路由 `createXxxRoute()` **禁止写显式 `: Hono` 返回类型注解**，会把链式 schema 抹平
- **响应对象里不许有 `any`**：handler 返回值含 `any` 字段会让整条路由的推导响应塌成 `never`，
  hc 端点直接不可用。raw SQL 结果先标注形状再 `c.json()`

## 步骤 2：鉴权守卫

守卫从 `../auth/middleware.js` 导入（**没有 `auth/index.ts`**，直接引具体模块）：

| 守卫 | 允许 |
| --- | --- |
| `requireSuper()` | 仅 super |
| `requireInternal()` | 内部团队（team + super） |
| `requireRole('team', 'super')` | 自定义角色组合 |
| `requireFeature('<flag>')` | 按 per-user 功能开关 |

- 当前用户用 `getAuthUser(c)`；有效账号角色只有 `team` 与 `super`
- 守卫可以挂在路由文件内，也可以在 `mountRoutes()` 里用 `.use('/api/xxx/*', requireSuper())`
- ⚠️ Hono 的 `/*` **匹配不到裸路径本身**——写入口若挂在 `/` 上会绕过角色守卫，
  把写入口放到具体子路径（如 `/upload`）再用 `/*` 守卫
- 写操作要带 `user_id` 审计

## 步骤 3：实现约束

- 数据库操作一律经 `getDb().<域>.<方法>()`，**禁止在路由里直接写 SQL**
- 日志用 `@greenhouse/utils/logger` 的 `logger.info/warn/error`，**禁止 `console.log`**
- 用户输入传给 LLM 前**必须** `sanitizeForPrompt()`（`security/security.ts`）
- 限流用共享的 `InMemoryRateLimiter`，不要另写；来源 IP 走 `security/request-ip.ts`
- 文件上传用 `validateMagicBytes()` 校验；上传读写一律走 `storage/uploads.ts`
- Agent 工具下载公网图片走 `security/network.ts` 的 `fetchPublicImage()`，禁止裸 `fetch()`
- **错误文案要指路**，且插值的动态值必须加引号：写 `(ID: "${id}")` 不要写 `(ID: ${id})`
  （不加引号会逃逸 friction 归一化，同一个问题碎成很多行）

## 步骤 4：挂载

在 `apps/api/src/index.ts` 的 `mountRoutes()` 单链里加一节：

```typescript
.route('/api/my-resource', myRoutes)
```

**注册顺序有安全语义，禁止重排**（公共路径、OAuth 根路由、通配守卫都依赖顺序）。
`export type AppType = ReturnType<typeof mountRoutes>` 就是对外契约，
由 `@greenhouse/contract` 重导出给前端 typed client。

## 步骤 5：共享类型

前后端共享的请求 / 响应类型放 `packages/types/src/`，从 `@greenhouse/types` 导入。
跨包一律用包名，不用相对路径；包内相对路径要带 `.js` 扩展名。

## 步骤 6：测试

- 路由 / 权限测试放 `tests/api/`，需要真库的命名 `*.db.test.ts`
- 安全与跨用户隔离类放 `tests/e2e/`（`pnpm test:e2e:ci`，跑在真 HTTP + 死 LLM 端点上）
- 需要真模型回复的用例要 `describe.skipIf(process.env.E2E_NO_LLM === '1')` 门住

## 步骤 7：门禁

```bash
pnpm typecheck
pnpm lint
pnpm test
```

## 检查清单

- [ ] 判断过 core vs extension
- [ ] 顶部注释块列全端点
- [ ] `new Hono<AppEnv>()` 链式定义，无语句式注册，工厂无 `: Hono` 注解
- [ ] 响应对象无 `any`
- [ ] 守卫从 `auth/middleware.js` 导入且级别正确；写入口没被 `/*` 漏过
- [ ] 数据经 `getDb()` service，无裸 SQL；日志用 `logger`
- [ ] LLM 入参过 `sanitizeForPrompt()`
- [ ] 错误文案指路 + 动态值加引号
- [ ] 已在 `mountRoutes()` 挂载，且没有重排既有顺序
- [ ] 共享类型进 `@greenhouse/types`
- [ ] 测试覆盖（`tests/api/`，安全类补 `tests/e2e/`）
- [ ] typecheck + lint + test 通过

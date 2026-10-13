---
name: add-api-route
description: >-
  Add or change a core endpoint in the Greenhouse Hono API (apps/api): chained route file, guard,
  db service call, mount in mountRoutes, shared types and tests. Use for 加个接口 / 新增 API /
  加条路由 / 写个 endpoint / add an API route / add an endpoint.
---

Rules live in apps/api/src/AGENTS.md (routes, auth, security, logging, error wording). Copy apps/api/src/routes/push-devices.ts, its mount in apps/api/src/index.ts and `apps/api/src/routes/__tests__/push-devices.db.test.ts`.

Before you start:
- Check the feature's row in docs/product/features.md; never extend a module marked 删除 or 合并.
- A private or optional module's routes belong in an extension (apps/api/src/extensions/example/routes.ts); they stay out of AppType.
- The data comes from a db service; if it is missing, run the add-db-table skill first.
- Pick the guard: requireInternal() for any account (team or super), requireSuper() for super only, plus `requireFeature('<flag>')` for a flagged module.

Steps:
1. Create `apps/api/src/routes/<resource>.ts` with a header comment that lists every endpoint.
2. Define all handlers as one chain, `new Hono<AppEnv>().get(...).post(...)`, and export it.
3. Read the caller with getAuthUser(c) from ../auth/middleware.js and data with `getDb().<service>.<method>()`.
4. Put request and response types that clients share in `packages/types/src/<domain>.ts`; a new file also needs an exports entry in packages/types/package.json.
5. Mount it in mountRoutes() in apps/api/src/index.ts: `.use()` the guard on both the bare path and `/*` (the wildcard does not match the bare path), then `.route()`.
6. Place the new lines with routes of the same guard; never reorder existing lines, the order is part of the security model.
7. Only for a login-free endpoint, add its exact path to PUBLIC_PATHS in apps/api/src/auth/middleware.ts.
8. Test the routes in `apps/api/src/routes/__tests__/` or tests/api/ (`*.db.test.ts` when they touch the database); put auth, isolation and escalation cases in tests/e2e/.
9. Call it from the web through lib/api and the typed client (add-frontend-page skill).
10. Run the quality-gate skill, with `pnpm test:e2e:ci` when access rules changed.
11. If the change ships or removes a feature, set its row in docs/product/features.md (status and PR) in the same PR.

Red lines:
- Statement-style registration or a `: Hono` return annotation on a route factory silently drops the endpoints from AppType.
- An any inside a response object collapses the inferred response to never.

v2: routes move to `apps/api/src/modules/<domain>/routes.ts`, call the same service as the tools and follow docs/product/api.md (zod schemas from @greenhouse/contract, cursor lists, coded errors, roles member and admin).

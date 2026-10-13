---
name: add-api-route
description: >-
  Add or change an endpoint in the Greenhouse v2 API: contract schema, module service, routes,
  mounting in app.ts and tests. Use for 加个接口 / 新增 API / 加条路由 / 写个 endpoint /
  add an API route / add an endpoint.
---

Rules live in the root AGENTS.md (Code rules, Auth and permissions) and docs/product/api.md. Copy apps/api/src/modules/members/ (service.ts, routes.ts, __tests__/).

Steps:
1. Check the feature's row in docs/product/features.md and the resource in api.md.
2. Add request and response zod schemas to `packages/contract/src/<domain>.ts` (snake_case keys) and export them from its index.
3. Write the logic in `apps/api/src/modules/<domain>/service.ts`: queries, transactions, permission checks, view functions that map rows to contract types, ApiError for failures.
4. Write `routes.ts`: a header comment listing every endpoint, `new Hono<AppEnv>()` chained handlers that read input with readJson or readQuery and call the service.
5. Mount it in apps/api/src/app.ts: public routes before the signed-in sub-app, member routes on it, admin routes under /admin.
6. Test through createTestApp() in `__tests__/<name>.db.test.ts`: the happy path, invalid input, unauthorized, forbidden and each conflict code.
7. Update api.md if the resource changed, then run the quality-gate skill and set the feature row's status.

Red lines:
- Never read process.env outside apps/api/src/config.
- Never return a database row or a raw error; never trust a client for ownership.

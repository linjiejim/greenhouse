/**
 * Fork extension point for HTTP routes — the ONLY file a downstream fork edits to
 * add private API routes.
 *
 * Upstream (greenhouse) ships this EMPTY. A downstream fork registers its private
 * routes by pushing entries onto `EXTRA_ROUTES`, WITHOUT touching `index.ts`'s
 * typed `mountRoutes()` chain — so `index.ts` stays byte-identical to upstream and
 * never conflicts on sync.
 *
 * These routes mount AFTER the typed chain and are therefore intentionally OUTSIDE
 * the `AppType` contract — the same treatment `/api/client-tools` already gets.
 * Trade-off: private routes are not part of the hc-typed client contract, so the
 * fork calls them with plain `fetch` (or its own extended contract). Apply guard
 * middleware (requireInternal / requireFeature) inside the route module or via the
 * optional `use` list below.
 *
 * Fork example (in the fork's copy of this file):
 *
 *   import crmRoutes from './crm.js';
 *   import { requireInternal, requireFeature } from '../auth/middleware.js';
 *   export const EXTRA_ROUTES: ExtraRoute[] = [
 *     { path: '/api/crm', create: () => crmRoutes, use: [requireInternal(), requireFeature('crm')] },
 *   ];
 */

import type { Hono, MiddlewareHandler } from 'hono';
import type { ToolRegistry } from '../agent.js';
import type { AppEnv } from '../app-env.js';

export interface ExtraRoute {
  /** Mount path, e.g. '/api/crm'. */
  path: string;
  /** Builds the route app. Receives the DB-backed tool registry for registry-dependent routes. */
  create: (toolRegistry: ToolRegistry) => Hono<AppEnv>;
  /** Optional guard middleware applied to `${path}/*` before the route (e.g. requireInternal()). */
  use?: MiddlewareHandler[];
}

/** Private routes contributed by a downstream fork. Empty upstream. */
export const EXTRA_ROUTES: ExtraRoute[] = [];

/**
 * Mount every fork-contributed route on `app`, applying any declared guard
 * middleware first. Called from main() after the typed mountRoutes() chain and the
 * client-tools mount. No-op upstream (EXTRA_ROUTES is empty).
 */
export function mountExtraRoutes(app: Hono<AppEnv>, toolRegistry: ToolRegistry): void {
  for (const route of EXTRA_ROUTES) {
    if (route.use?.length) {
      app.use(`${route.path}/*`, ...route.use);
    }
    app.route(route.path, route.create(toolRegistry));
  }
}

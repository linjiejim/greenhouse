/**
 * Shared Hono environment — types what auth middleware puts on the context.
 *
 * Route files instantiate `new Hono<AppEnv>()` so `c.get('user')` is typed
 * and the chained route definitions compose into the exported `AppType`
 * consumed by hc clients (packages/contract).
 */

import type { AuthUser } from './auth/token.js';

export type AppEnv = {
  Variables: {
    /** Set by authMiddleware for authenticated requests. */
    user: AuthUser;
  };
};

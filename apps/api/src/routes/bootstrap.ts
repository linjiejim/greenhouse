/**
 * Workspace bootstrap route — /api/bootstrap (PUBLIC).
 *
 * GET /api/bootstrap — pre-login workspace personalization (tenant name, logo
 * data URL, theme tokens, team Sprouty). Served before auth so the login
 * screen can brand itself; therefore it must never expose secrets, user data
 * or feature configuration. Listed in PUBLIC_PATHS (auth/middleware.ts).
 */

import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { getWorkspaceBootstrap } from '../settings/workspace-config.js';

const bootstrapRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const payload = await getWorkspaceBootstrap();
  // Admin edits should show up on the next reload — don't let browsers cache.
  c.header('Cache-Control', 'no-store');
  return c.json(payload);
});

export default bootstrapRoutes;

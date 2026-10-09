/**
 * Workspace bootstrap route — /api/bootstrap (PUBLIC).
 *
 * GET /api/bootstrap — pre-login workspace personalization (tenant name, logo
 * data URL, theme tokens) plus `setup_pending` (no administrator owns the
 * instance yet). Served before auth so the login screen can brand itself and
 * explain a fresh install; therefore it must never expose secrets, user data
 * or feature configuration. Listed in PUBLIC_PATHS (auth/middleware.ts).
 */

import { Hono } from 'hono';
import type { WorkspaceBootstrap } from '@greenhouse/types';
import type { AppEnv } from '../app-env.js';
import { isFirstRunSetupPending } from '../security/first-admin.js';
import { getWorkspaceBranding } from '../settings/workspace-config.js';

const bootstrapRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const [branding, setupPending] = await Promise.all([getWorkspaceBranding(), isFirstRunSetupPending()]);
  const payload: WorkspaceBootstrap = { ...branding, setup_pending: setupPending };
  // Admin edits should show up on the next reload — don't let browsers cache.
  c.header('Cache-Control', 'no-store');
  return c.json(payload);
});

export default bootstrapRoutes;

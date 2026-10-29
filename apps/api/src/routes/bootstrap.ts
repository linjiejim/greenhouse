/**
 * Workspace bootstrap route — /api/bootstrap (PUBLIC).
 *
 * GET /api/bootstrap — pre-login workspace personalization (tenant name, logo
 * data URL, theme tokens). Served before auth so the login
 * screen can brand itself; therefore it must never expose secrets, user data
 * or feature configuration. Listed in PUBLIC_PATHS (auth/middleware.ts).
 *
 * `mobile_api` is the level of the API the phone app relies on: the app reads it
 * before sign-in and asks for a server update when the level is below what it
 * needs. Bump it when a release adds an endpoint the app starts calling.
 */

import type { WorkspaceBootstrap } from '@greenhouse/types';
import { isFirstRunSetupPending } from '../security/first-admin.js';
import { CLIENT_API_LEVEL } from '@greenhouse/types/plugins';
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { getWorkspaceBootstrap } from '../settings/workspace-config.js';

/**
 * 1: password sign-in, notifications, push devices (`/api/auth/me/push-devices`).
 * 2: Feishu sign-in returning to the app (`/api/feishu/oauth/start-login?app_redirect=`).
 * 3: projects and tasks, tables, my agent writes, my spend (`/api/usage/spend`), my gateway keys
 *    (`/api/agent-access/gateway`) and the assistant chat, as of 1.7.
 * 4: station manifest v2 and plugin surfaces.
 */
export const MOBILE_API_LEVEL = CLIENT_API_LEVEL;

const bootstrapRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const [branding, setupPending] = await Promise.all([getWorkspaceBootstrap(), isFirstRunSetupPending()]);
  const payload: WorkspaceBootstrap = { ...branding, setup_pending: setupPending, mobile_api: MOBILE_API_LEVEL };
  // Admin edits should show up on the next reload — don't let browsers cache.
  c.header('Cache-Control', 'no-store');
  return c.json(payload);
});

export default bootstrapRoutes;

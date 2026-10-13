/**
 * GET   /api/bootstrap          public: branding, api_version, login methods, setup_pending
 * PATCH /api/admin/branding     admin: name and primary color
 */

import { Hono } from 'hono';
import { brandingInputSchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson } from '../../http/validate.js';
import type { WorkspaceService } from './service.js';

export function bootstrapRoutes(workspace: WorkspaceService) {
  return new Hono<AppEnv>().get('/', async (c) => c.json(await workspace.bootstrap()));
}

/** Mounted under /api/admin, which already requires an admin. */
export function brandingRoutes(workspace: WorkspaceService) {
  return new Hono<AppEnv>().patch('/', async (c) => {
    const input = await readJson(c, brandingInputSchema);
    return c.json(await workspace.updateBranding(input, c.get('member').id));
  });
}

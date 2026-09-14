/**
 * GET /api/extensions — the active extensions of this deployment (id, name).
 *
 * The web client filters its compiled extension pages / navigation against this
 * list, so a disabled extension leaves no trace in the UI. Authenticated: which
 * extensions a deployment runs is configuration, not pre-login branding.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { EXTENSIONS } from '../extensions/index.js';

const extensionsRoutes = new Hono<AppEnv>().get('/', (c) =>
  c.json({
    extensions: EXTENSIONS.map((ext) => ({ id: ext.id, name: ext.name, description: ext.description ?? null })),
  }),
);

export default extensionsRoutes;

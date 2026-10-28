import { getDb } from '@greenhouse/db';
import { stationManifest } from '../plugin-host/station-manifest.js';
/**
 * GET /api/extensions — what this deployment's active extensions contribute.
 *
 * The station manifest (packages/types/src/plugins.ts): clients render plugins
 * from it as DATA rather than as code — nav, pages, entities and record-kind
 * routes (so an extension's deeplinks resolve, which is what turns a link in
 * chat into a peek). They are declared once, on the api half, and shipped
 * here — a second hand-written copy in a client is exactly the drift this
 * avoids.
 *
 * Authenticated: which extensions a deployment runs is configuration, not
 * pre-login branding.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { GREENHOUSE_CONFIG } from '../config/greenhouse-config.js';
import { fromExtensions } from '../plugin-host/index.js';

const extensionsRoutes = new Hono<AppEnv>().get('/', async (c) => {
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    ...(await stationManifest(getDb(), c.get('user'))),
    notificationTransports: fromExtensions('notificationTransports').map(
      ({ id, title, bindingSettings, acceptsWebhook }) => ({
        id,
        title,
        bindingSettings,
        // An automation's group-bot webhook is offered only when some transport takes one.
        webhook: typeof acceptsWebhook === 'function',
      }),
    ),
    identityProviders: fromExtensions('identityProviders')
      .filter((p) => p.available())
      .map(({ id, title, icon, login, bind }) => ({ id, title, icon, login, bind })),
    automationTools: fromExtensions('automationTools'),
    conversations: GREENHOUSE_CONFIG.conversations,
  });
});

export default extensionsRoutes;

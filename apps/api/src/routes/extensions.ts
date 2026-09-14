/**
 * GET /api/extensions — what this deployment's active extensions contribute.
 *
 * The web client compiles every extension in but renders only the active ones,
 * so it needs the list. Two registries additionally have to reach the browser
 * as DATA rather than as code: record-kind routes (so `entityUrl` /
 * `parseEntityUrl` resolve an extension's deeplinks, which is what turns a link
 * in chat into a peek) and workbench recipes (so the card picker offers them).
 * Both are declared once, on the API half, and shipped here — a second
 * hand-written copy in the web half is exactly the drift this avoids.
 *
 * Authenticated: which extensions a deployment runs is configuration, not
 * pre-login branding.
 */
import { Hono } from 'hono';
import type { AppEnv } from '../app-env.js';
import { EXTENSIONS, fromExtensions } from '../extensions/index.js';

const extensionsRoutes = new Hono<AppEnv>().get('/', (c) =>
  c.json({
    extensions: EXTENSIONS.map((ext) => ({ id: ext.id, name: ext.name, description: ext.description ?? null })),
    entityKinds: fromExtensions('entityKinds'),
    workbenchRecipes: fromExtensions('workbenchRecipes'),
  }),
);

export default extensionsRoutes;

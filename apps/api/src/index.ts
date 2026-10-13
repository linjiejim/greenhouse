/**
 * Greenhouse API v2 entry point: load config, connect, migrate when asked, make sure the
 * workspace and first admin exist, then serve.
 */

import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { serve } from '@hono/node-server';
import { applyMigrations, assertNotV1Database, createDbClient, setDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { createApp, createServices } from './app.js';
import { loadConfig } from './config/index.js';
import { pgTransport } from './realtime/pg.js';
import { attachRealtime } from './realtime/socket.js';
import { ensureFirstAdmin } from './security/first-admin.js';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

async function main() {
  const config = loadConfig();
  const client = createDbClient(config.DATABASE_URL);
  await assertNotV1Database(client.sql);
  if (config.MIGRATE_ON_START) await applyMigrations(config.DATABASE_URL);
  setDb(client.db);

  const services = createServices(config);
  await services.workspace.row();
  await ensureFirstAdmin(config.BOOTSTRAP_ADMIN_EMAIL, services.auth);
  await services.hub.connect(pgTransport(client.sql));
  services.engine.start();
  services.schedules.start();
  // Turns another process left behind (a restart, a crash) carry on here.
  await services.engine.sweep();

  const app = createApp(services);
  const server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
    logger.info(`[api] Greenhouse v2 listening on http://localhost:${info.port}`),
  );
  const realtime = attachRealtime(server as Server, {
    hub: services.hub,
    tokens: services.tokens,
    allowedOrigins: config.corsAllowedOrigins,
  });

  const stop = async () => {
    services.schedules.stop();
    await realtime.close();
    server.close();
    await services.engine.shutdown();
    await services.hub.close();
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  logger.error('[api] failed to start', error);
  process.exit(1);
});

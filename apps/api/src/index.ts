import { COMPILED_EXTENSIONS } from './extensions/index.js';
import { selectExtensions } from './extensions/define.js';
import { registerExtensionAdapters } from './extensions/host.js';
/**
 * Greenhouse API v2 entry point: load config, connect, migrate when asked, make sure the
 * workspace and first admin exist, then serve.
 */

import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { applyMigrations, applyExtensionMigrations, assertNotV1Database, createDbClient, setDb } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { createApp, createServices } from './app.js';
import { loadConfig, loadEnvironment } from './config/index.js';
import { attachComputerSockets } from './realtime/computer.js';
import { pgTransport } from './realtime/pg.js';
import { attachRealtime } from './realtime/socket.js';
import { ensureFirstAdmin } from './security/first-admin.js';

// GREENHOUSE_ENV_FILE picks another file (or /dev/null for none, as the browser tests do).
loadEnvironment();

async function main() {
  const config = loadConfig();
  const client = createDbClient(config.DATABASE_URL);
  await assertNotV1Database(client.sql);
  if (config.MIGRATE_ON_START) await applyMigrations(config.DATABASE_URL);
  setDb(client.db);

  const extensions = selectExtensions(COMPILED_EXTENSIONS, config.extensions);
  registerExtensionAdapters(extensions);
  await applyExtensionMigrations(
    extensions
      .filter((extension) => extension.migrations)
      .map((extension) => ({ extensionId: extension.id, dir: extension.migrations!.dir })),
  );
  const services = createServices(config, { extensions });
  await services.workspace.row();
  if (config.GREENHOUSE_ROLE !== 'worker') {
    await ensureFirstAdmin(config.BOOTSTRAP_ADMIN_EMAIL, services.auth);
    // Official skills seed after an admin exists.
    await services.skills.seedOfficial();
  }
  // NOTIFYs leave on a connection of their own, in order (realtime/pg.ts).
  const notifier = createDbClient(config.DATABASE_URL, { max: 1 });
  await services.hub.connect(pgTransport(client.sql, notifier.sql));
  services.engine.start();
  if (config.GREENHOUSE_ROLE !== 'api') {
    services.schedules.start();
    services.channels.start();
    services.tables.worker.start();
    services.computers.startWatching((conversationId, item) => services.engine.deliver(conversationId, item));
  }
  await services.engine.sweep();

  let server: ReturnType<typeof serve> | undefined;
  let realtime: ReturnType<typeof attachRealtime> | undefined;
  let computerSockets: ReturnType<typeof attachComputerSockets> | undefined;
  if (config.GREENHOUSE_ROLE !== 'worker') {
    const app = createApp(services);
    server = serve({ fetch: app.fetch, port: config.PORT }, (info) =>
      logger.info(`[api] Greenhouse v2 (${config.GREENHOUSE_ROLE}) listening on http://localhost:${info.port}`),
    );
    realtime = attachRealtime(server as Server, {
      hub: services.hub,
      tokens: services.tokens,
      allowedOrigins: config.corsAllowedOrigins,
    });
    computerSockets = attachComputerSockets(server as Server, {
      computers: services.computers,
      hub: services.hub,
      allowedOrigins: config.corsAllowedOrigins,
    });
  } else logger.info('[worker] Greenhouse v2 background worker started');

  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      // Stop admission before waiting on a socket, model or job. Keep reply sockets open while draining.
      services.engine.drain();
      services.schedules.stop();
      services.computers.stopWatching();
      server?.close();
      let deadline: NodeJS.Timeout | undefined;
      await Promise.all([
        services.engine.shutdown(),
        Promise.race([
          Promise.all([services.channels.stop(), services.tables.worker.stop()]),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 60_000);
          }),
        ]),
      ]);
      clearTimeout(deadline);
      await Promise.all([services.channels.release(), services.tables.worker.release()]);
      await realtime?.close();
      await computerSockets?.close();
      (server as Server | undefined)?.closeAllConnections();
      await services.hub.close();
      await notifier.close();
      await client.close();
      process.exit(0);
    })().catch((error: unknown) => {
      logger.error('[runtime] shutdown failed', error);
      process.exit(1);
    }));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((error: unknown) => {
  logger.error('[api] failed to start', error);
  process.exit(1);
});

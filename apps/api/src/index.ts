import { identityDiscoveryRoutes } from './auth/identity-providers.js';
import { startChannels } from './plugin-host/channels.js';
import { fromExtensions } from './plugin-host/index.js';
/**
 * Greenhouse API — Hono server entry point.
 *
 * Mounts route modules, applies middleware, starts server.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { config } from 'dotenv';
import { ENV_FILE, PUBLIC_DIR } from './paths.js';

// Load .env before anything else
config({ path: ENV_FILE });

// ─── Proxy for configured outbound APIs ───
// Node.js native fetch (undici) doesn't read HTTPS_PROXY by default.
// Set global dispatcher if proxy env var is present.
import { ProxyAgent, setGlobalDispatcher, fetch as undiciFetch } from 'undici';
const _httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (_httpsProxy) {
  setGlobalDispatcher(new ProxyAgent(_httpsProxy));
  // The dispatcher above belongs to *this* undici, which Node's global fetch cannot
  // run — it validates dispatchers against its own embedded undici and rejects ours
  // with `UND_ERR_INVALID_ARG`, failing every request as `TypeError: fetch failed`.
  // Swapping in undici's own fetch keeps one HTTP stack, so the proxy actually applies.
  globalThis.fetch = undiciFetch as unknown as typeof globalThis.fetch;
  logger.info(`[Proxy] 🌐 Global fetch proxy set: ${_httpsProxy}`);
}

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { mountClientHosting } from './hosting.js';
import { extUiScopeMiddleware } from './auth/middleware.js';
import extUiRoutes from './routes/ext-ui.js';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';
import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { createToolRegistry, type ToolRegistry } from './agent.js';
import type { AppEnv } from './app-env.js';
import { listProfileIds, startProfileWatcher } from './profiles/profile.js';
import { authMiddleware, requireSuper, requireInternal } from './auth/middleware.js';
import { assertAuthEnv } from './auth/token.js';
import {
  corsMiddleware,
  rateLimitMiddleware,
  redactQueryForLog,
  securityHeadersMiddleware,
} from './security/security.js';

// Route modules
import authRoutes from './routes/auth.js';
import meRoutes from './routes/me.js';
import peopleRoutes from './routes/people.js';
import profileRoutes from './routes/profiles.js';
import sessionRoutes from './routes/sessions.js';
import { createChatRoute } from './routes/chat.js';
import clientActionRoutes from './routes/client-actions.js';
import { CLIENT_ACTIONS_API_PREFIX } from '@greenhouse/types/api';
import { createAgentRoutes } from './routes/agent-tools.js';
import { createMcpRoutes } from './routes/mcp.js';
import { createAnthropicGatewayRoutes, createGatewayRoutes } from './routes/gateway.js';
import { GATEWAY_ANTHROPIC_PATH, GATEWAY_OPENAI_PATH } from '@greenhouse/types/agent-access';
import { createAgentAccessRoutes } from './routes/agent-access.js';
import oauthRoutes from './routes/oauth.js';
import healthRoutes from './routes/health.js';
import bootstrapRoutes from './routes/bootstrap.js';
import extensionsRoutes from './routes/extensions.js';
import adminPluginRoutes from './routes/admin-plugins.js';
import {
  applyExtensionMigrations,
  extensionApplicationRegistrations,
  mountExtensionRoutes,
  mountExtensionUis,
  runExtensionBootHooks,
  runExtensionShutdownHooks,
} from './plugin-host/boot.js';
import adminSettingsRoutes from './routes/admin-settings.js';
import { adminTeamContextRoutes } from './routes/admin-team-context.js';
import { applyWorkspaceEnvOverlay } from './settings/workspace-config.js';
import uploadRoutes from './routes/upload.js';
import adminRoutes from './routes/admin.js';
import platformAdminRoutes from './routes/platform-admin.js';
import { bootstrapPlatform } from './plugin-host/bootstrap.js';
import { initializePlatformRuntime } from './plugin-host/runtime.js';
import promptRoutes from './routes/prompts.js';
import { createSearchRoute } from './routes/search.js';
import { createRefsRoutes } from './routes/refs.js';
import { createActivityRoutes } from './routes/activity.js';
import shareRoutes from './routes/shares.js';
import { createNotificationRoutes } from './routes/notifications.js';
import pushDeviceRoutes from './routes/push-devices.js';
import adminMeteringRoutes from './routes/admin-metering.js';
import usageRoutes from './routes/usage.js';
import { adminClientReportRoutes, clientReportRoutes } from './routes/client-reports.js';
import toolsRoutes from './routes/tools.js';
import driveRoutes from './routes/drive.js';
import chatFileRoutes from './routes/chat-files.js';
import artifactActionRoutes from './routes/artifact-actions.js';
import { initScheduler } from './scheduler/index.js';
import { createTasksRoute } from './routes/tasks.js';
import runtimeRoutes from './routes/runtime.js';
import { startRuntimeWorker } from './runtime/worker.js';
import { reconcileInterruptedChatRuntimeRuns } from './chat/runtime.js';
import { reconcileInterruptedAgentWrites } from './agent-access/governed-write.js';
import { reconcileInterruptedConnectorWrites } from './connectors/writes.js';
import { refreshConnectorDirectory } from './connectors/directory.js';
import adminConnectorRoutes from './routes/admin-connectors.js';
import { connectorOAuthCallbackRoutes, memberConnectorRoutes } from './routes/connectors.js';
import { sweepExpiredToolOutputs } from './agent-runtime/tool-output-store.js';
import { scheduleRetention } from './upkeep/retention.js';
import { createAutomationRuntimeDriver } from './scheduler/runtime-driver.js';
import { createRuntimeNotificationProjector } from './notifications/runtime-projector.js';
import { automationDeliveryChannels, startNotificationDeliveryWorker } from './notifications/delivery-worker.js';
import { mobilePushEnabled } from './notifications/push/config.js';
import { createRuntimeDomainProjector } from './runtime/domain-projector.js';
import { resolveTrustedExecutionSwitches, trustedExecutionBootPlan } from './trusted-execution/kill-switches.js';
import { initServiceCatalog } from './config/services.js';
import { initModelCatalog } from './config/models.js';
// ws CJS/ESM interop — use namespace import for reliable access
import * as _ws from 'ws';
const WsServer = _ws.WebSocketServer ?? (_ws as any).default?.WebSocketServer;
import wsRoutes from './ws/index.js';
import { connectionManager } from './ws/connection-manager.js';
import { chatRunRegistry } from './chat/runs.js';
import { startUsageBudgetSweeper } from './llm/usage-budget-sweeper.js';

const app = new Hono<AppEnv>();
const trustedExecutionSwitches = resolveTrustedExecutionSwitches();
const trustedExecutionPlan = trustedExecutionBootPlan(trustedExecutionSwitches);

if (trustedExecutionSwitches.invalidEnv.length > 0) {
  logger.error('[trusted-execution] invalid kill-switch values were disabled', {
    env: trustedExecutionSwitches.invalidEnv,
  });
}

// ─── Security Middleware ─────────────────────────────────

app.use('*', securityHeadersMiddleware);
app.use('*', corsMiddleware);
app.use('*', extUiScopeMiddleware);
mountExtensionUis(app);
mountClientHosting(app, PUBLIC_DIR);
app.use('*', authMiddleware);
app.use('*', rateLimitMiddleware);

// ─── Request Logging Middleware ──────────────────────────

app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const url = new URL(c.req.url);
  const query = redactQueryForLog(url);

  logger.info(`[API] → ${method} ${path}${query}`);

  await next();

  const duration = Date.now() - start;
  const status = c.res.status;
  const statusIcon = status >= 400 ? '❌' : '✅';
  logger.info(`[API] ← ${statusIcon} ${method} ${path} ${status} (${duration}ms)`);
});

// Client hosting excludes API/plugin prefixes before their authenticated routes.
// ─── Mount Routes ────────────────────────────────────────
// One chained expression so the full route schema composes into AppType.
// Registration order is load-bearing (e.g. OAuth protocol routes precede application routes) — do not reorder.
// Called from main() once the toolRegistry exists (needs the DB).

function mountRoutes(toolRegistry: ToolRegistry) {
  return (
    app
      // OAuth discovery/protocol and authenticated consent routes. This root
      // router must be mounted before narrower application routes.
      .route('/', oauthRoutes)
      .route('/api/auth', authRoutes)
      .route('/api/auth', identityDiscoveryRoutes)
      .route('/api/me', meRoutes)
      .route('/api/ext-ui', extUiRoutes)
      // A member's own connectors (connect / disconnect team ones, CRUD personal
      // ones); the router also requires the mcp_call tool.
      .use('/api/me/connectors', requireInternal())
      .use('/api/me/connectors/*', requireInternal())
      .route('/api/me/connectors', memberConnectorRoutes)
      .route('/api/profiles', profileRoutes)
      .route('/api/sessions', sessionRoutes)
      .route('/health', healthRoutes)
      // Pre-login workspace personalization (name / logo / theme) — public.
      .route('/api/bootstrap', bootstrapRoutes)
      .route('/api/extensions', extensionsRoutes)
      .route('/api/admin/plugins', adminPluginRoutes)
      .route('/api/upload', uploadRoutes)
      // A connector's OAuth provider redirects the browser to `/oauth/callback`
      // without a Bearer (a public path, rate-limited); it only redirects back to
      // the app. Must sit before every wildcard role guard.
      .route('/api/connectors', connectorOAuthCallbackRoutes)
      // Super-admin-only routes
      .use('/api/admin/*', requireSuper())
      .route('/api/admin/connectors', adminConnectorRoutes)
      .route('/api/admin/platform', platformAdminRoutes)
      .route('/api/admin/metering', adminMeteringRoutes)
      .route('/api/admin/client-reports', adminClientReportRoutes)
      .route('/api/admin', adminRoutes)
      .route('/api/admin/settings', adminSettingsRoutes)
      .route('/api/admin/team-context', adminTeamContextRoutes)
      // Email accounts — every internal user (mailbox binding is per-user and
      // self-service; the shared mailbox stays super-only inside the service).
      // Prompts, knowledge docs & shares — all internal users
      .use('/api/prompts/*', requireInternal())
      .route('/api/prompts', promptRoutes)
      // Global search — guards live inside the route (a bare `/api/search` is not
      // matched by a `/*` prefix middleware), and each domain lane gates itself.
      .route('/api/search', createSearchRoute())
      // Object links → titles for chips (guard inside; each item authorized on its own).
      .route('/api/refs', createRefsRoutes())
      // Member ids → display names for plugin record fields (internal members only).
      .route('/api/people', peopleRoutes)
      // Activity log — guard inside the route (a bare `/api/activity` is not matched by `/*`).
      .route('/api/activity', createActivityRoutes())
      // Drive — internal users; per-node checks live in resolveDriveAccess
      .use('/api/drive/*', requireInternal())
      .route('/api/drive', driveRoutes)
      .use('/api/chat-files/*', requireInternal())
      .route('/api/chat-files', chatFileRoutes)
      .use('/api/artifact-actions/*', requireInternal())
      .route('/api/artifact-actions', artifactActionRoutes)
      .use('/api/shares/*', requireInternal())
      .route('/api/shares', shareRoutes)
      .use('/api/notifications', requireInternal())
      .use('/api/notifications/*', requireInternal())
      .route('/api/notifications', createNotificationRoutes())
      // Mobile push devices — the member's own phones. The bare collection path is
      // not matched by `/*`, so it is guarded explicitly.
      .use('/api/auth/me/push-devices', requireInternal())
      .use('/api/auth/me/push-devices/*', requireInternal())
      .route('/api/auth/me/push-devices', pushDeviceRoutes)
      // Module usage counts (page opens) — all internal users; counts only
      .use('/api/usage/*', requireInternal())
      .route('/api/usage', usageRoutes)
      // Client error reports — a member's app sends what it caught; the bare path is the endpoint.
      .use('/api/client-reports', requireInternal())
      .use('/api/client-reports/*', requireInternal())
      .route('/api/client-reports', clientReportRoutes)
      // Tool metadata — authenticated internal users
      .route('/api/tools', toolsRoutes)
      // WebSocket endpoint — internal users only (auth via query token)
      .route('/api/ws', wsRoutes)
      // Browser client-action results — internal user-bound and part of the typed contract
      .use(`${CLIENT_ACTIONS_API_PREFIX}/*` as const, requireInternal())
      .route(CLIENT_ACTIONS_API_PREFIX, clientActionRoutes)
      // ── Registry-dependent routes (need DB-backed toolRegistry) ──
      .route('/api/chat', createChatRoute(toolRegistry))
      .use('/api/tasks/*', requireInternal())
      .route('/api/tasks', createTasksRoute())
      // Runtime is the cross-domain Execution Center read model. Domain drivers
      // remain authoritative and every object is owner/super guarded again in
      // the route as defense in depth.
      // Agent access: a member's own external agents — the MCP endpoint and
      // their recorded writes. Every handler re-scopes to the caller.
      .use('/api/agent-access/*', requireInternal())
      .route('/api/agent-access', createAgentAccessRoutes())
      .use('/api/runtime', requireInternal())
      .use('/api/runtime/*', requireInternal())
      .route('/api/runtime', runtimeRoutes)
      // Agent tool proxy (login access-token auth, revalidated against the internal user)
      .route('/api/agent', createAgentRoutes(toolRegistry))
      .route('/api/mcp', createMcpRoutes(toolRegistry))
      // Model gateway (OpenAI-compatible): a public path authenticated only by a
      // member's `ghgw_` key, switched by `gateway.enabled`, metered to the member.
      .route(GATEWAY_OPENAI_PATH, createGatewayRoutes())
      // The same gateway on the Anthropic Messages wire (Claude Code's ANTHROPIC_BASE_URL).
      .route(GATEWAY_ANTHROPIC_PATH, createAnthropicGatewayRoutes())
  );
}

/**
 * The full typed route schema — the API contract for Hono `hc` clients.
 * Type-only: importing this never runs the server.
 */
export type AppType = ReturnType<typeof mountRoutes>;

let dbProvider: DatabaseProvider;

// ─── Start Server ────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT ?? '3000', 10);
const HOSTNAME = process.env.API_HOST;

async function main() {
  assertAuthEnv(); // fail fast before binding if the signing key is absent
  dbProvider = await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });
  // Extension-owned tables live in their own migration lane (core DDL stays in
  // packages/db/migrations, applied before boot). Pending files are applied here, under
  // an advisory lock, before anything can want the tables.
  await applyExtensionMigrations(dbProvider);
  // Admin-edited runtime config (LLM / media / search credentials) wins over the
  // environment: overlay it onto process.env before anything reads those vars.
  await applyWorkspaceEnvOverlay();
  // The model catalog is config, not data — load it before anything can want a
  // model, and let a malformed file stop the boot rather than the first message.
  initModelCatalog();
  // Service prices (search, page reads, images, …) — same fail-fast rule.
  initServiceCatalog();
  const usageBudgetSweeper = await startUsageBudgetSweeper(dbProvider);
  const platformBootstrap = await bootstrapPlatform(dbProvider);
  initializePlatformRuntime(dbProvider, extensionApplicationRegistrations());
  if (
    platformBootstrap.rolesCreated.length > 0 ||
    platformBootstrap.capabilitiesAdded > 0 ||
    platformBootstrap.entityPoliciesAdded > 0
  ) {
    logger.info('[Platform] Kernel bootstrap applied', { ...platformBootstrap });
  }

  // Knowledge docs written before segmented FTS tokens existed are invisible to
  // search until tokenized. One-off backfill, fire-and-forget like the sweeps.

  const toolRegistry = createToolRegistry(dbProvider);
  await runExtensionBootHooks(dbProvider);

  // Chat is trace-only and cannot safely replay after process death. Always
  // close historical active traces, even when new Chat tracing is killed for
  // rollout; a Runtime outage must not prevent the rest of Chat from booting.
  await reconcileInterruptedChatRuntimeRuns(dbProvider).catch((error) => {
    logger.error('[chat-runtime] boot reconciliation unavailable', { error: String(error) });
  });
  // An external agent's write that was executing when the process stopped may
  // or may not have taken effect: close it as outcome unknown, never replay it.
  await reconcileInterruptedAgentWrites(dbProvider).catch((error) => {
    logger.error('[agent-access] boot reconciliation unavailable', { error: String(error) });
  });
  await reconcileInterruptedConnectorWrites(dbProvider).catch((error) => {
    logger.error('[connectors] boot reconciliation unavailable', { error: String(error) });
  });
  await refreshConnectorDirectory(dbProvider);
  let runtimeWorker: Awaited<ReturnType<typeof startRuntimeWorker>> | null = null;
  let notificationDeliveryWorker: Awaited<ReturnType<typeof startNotificationDeliveryWorker>> | null = null;

  // Mount everything (single typed chain — see mountRoutes/AppType above)
  mountRoutes(toolRegistry);
  // Extension routes sit outside the typed contract: a fork's private API never
  // reshapes the public AppType.
  mountExtensionRoutes(app);

  // Active channel adapters own their connections and return their shutdown hooks.
  const stopChannels = await startChannels(fromExtensions('channels'), { db: dbProvider, toolRegistry });

  startProfileWatcher();

  // Start task scheduler
  const scheduler = initScheduler(toolRegistry, { runtimeEnabled: trustedExecutionPlan.automationDriver });
  await scheduler.start();

  // Abort in-flight chat runs BEFORE closing the DB: the interruption
  // persistence path then writes safe partial answers, so a deploy/restart
  // doesn't erase whole in-progress turns.
  const shutdown = async () => {
    scheduler.stop();
    usageBudgetSweeper.stop();
    runtimeWorker?.stop();
    notificationDeliveryWorker?.stop();
    await stopChannels();
    await runExtensionShutdownHooks();
    await chatRunRegistry.shutdown(5000);
    await dbProvider.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  const wss = new WsServer({ noServer: true });

  await new Promise<void>((resolveListening, rejectListening) => {
    const server = serve(
      { fetch: app.fetch, port: PORT, ...(HOSTNAME ? { hostname: HOSTNAME } : {}), websocket: { server: wss } },
      (info) => {
        const profileIds = listProfileIds();
        logger.info(`\n🌱 Greenhouse API running at http://localhost:${info.port}`);
        logger.info(`   Database: PostgreSQL`);
        logger.info(`   Profiles: ${profileIds.join(', ')}`);
        logger.info(`   WebSocket: enabled`);
        resolveListening();
      },
    );
    server.once('error', rejectListening);
  });

  // External Automation channels are transport facts, not part of the
  // terminal Runtime transaction. Drain their permanent per-channel queue on
  // every boot and keep retrying independently until delivered/dead-lettered.
  // Mobile pushes ride the same queue under their own switch (MOBILE_PUSH_ENABLED):
  // off, the worker never claims one and nothing is sent to exp.host.
  const deliveryChannels = [
    ...(trustedExecutionPlan.notificationProjector ? automationDeliveryChannels() : []),
    ...(mobilePushEnabled() ? (['mobile_push'] as const) : []),
  ];
  notificationDeliveryWorker =
    deliveryChannels.length > 0
      ? await startNotificationDeliveryWorker({ db: dbProvider, channels: deliveryChannels })
      : null;

  // No Runtime driver may claim work until the socket above is actually
  // listening. The boot pass also drains stale leases/outbox immediately.
  runtimeWorker = trustedExecutionPlan.runtimeWorker
    ? await startRuntimeWorker({
        db: dbProvider,
        onEvent: async (event) => {
          await createRuntimeDomainProjector(dbProvider)(event);
          if (trustedExecutionPlan.notificationProjector) {
            await createRuntimeNotificationProjector(dbProvider)(event);
          }
        },
        drivers: {
          ...(trustedExecutionPlan.automationDriver ? { automation: createAutomationRuntimeDriver(toolRegistry) } : {}),
        },
        driverConcurrency: { automation: 3 },
        // An Automation whose worker died mid-turn may have written something:
        // it ends interrupted / outcome unknown and the owner is told which
        // writes were in flight. It is never re-executed.
        outcomeUnknownKinds: ['automation'],
      })
    : null;

  // Five-minute expiry sweeps, each failing on its own (one bad sweep never
  // skips the others, and never becomes an unhandled rejection):
  //  - oversized MCP replies past their 24-hour life (agent-runtime/tool-output-store.ts);
  //  - rate-limit buckets whose window has ended (security/security.ts);
  //  - Feishu / WeCom login states and one-time login codes past their TTL.
  const expirySweeps: Array<[string, () => Promise<unknown>]> = [
    ['MCP tool output', () => sweepExpiredToolOutputs()],
    ['rate-limit bucket', () => dbProvider.rateLimits.sweepExpired()],
    ['OAuth login state', () => dbProvider.oauthLoginStates.sweepExpired()],
  ];
  setInterval(() => {
    for (const [label, sweep] of expirySweeps) {
      void sweep().catch((error) => logger.warn(`[upkeep] ${label} sweep failed`, { error: toErrorMessage(error) }));
    }
  }, 5 * 60_000);

  // Daily retention cleanup of high-growth tables (upkeep/retention.ts).
  scheduleRetention(dbProvider);

  // Heartbeat: ping all WS connections every 30s. Never an unhandled rejection:
  // Node would exit the whole API over one failed tick.
  setInterval(
    () =>
      void connectionManager
        .pingAll()
        .catch((error) => logger.warn('[WS] heartbeat tick failed', { error: toErrorMessage(error) })),
    30_000,
  );
}

main().catch((err) => {
  logger.error('Fatal:', err);
  process.exit(1);
});

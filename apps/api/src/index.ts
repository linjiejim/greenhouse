/**
 * Greenhouse API — Hono server entry point.
 *
 * Mounts route modules, applies middleware, starts server.
 */

import { resolve } from 'node:path';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { readFileSync, existsSync } from 'node:fs';
import { config } from 'dotenv';
import { ENV_FILE, PUBLIC_DIR, REPO_ROOT } from './paths.js';

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
import { serveStatic } from '@hono/node-server/serve-static';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';
import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { createToolRegistry, type ToolRegistry } from './agent.js';
import type { AppEnv } from './app-env.js';
import { listProfileIds, startProfileWatcher } from './profiles/profile.js';
import { authMiddleware, requireSuper, requireInternal, requireFeature } from './auth/middleware.js';
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
import {
  applyExtensionMigrations,
  extensionApplicationRegistrations,
  mountExtensionRoutes,
  runExtensionBootHooks,
  runExtensionShutdownHooks,
} from './extensions/boot.js';
import adminSettingsRoutes from './routes/admin-settings.js';
import { adminRetroRoutes, adminTeamContextRoutes } from './routes/admin-team-context.js';
import dataCatalogRoutes from './routes/data-catalog.js';
import { applyWorkspaceEnvOverlay } from './settings/workspace-config.js';
import uploadRoutes from './routes/upload.js';
import adminRoutes from './routes/admin.js';
import costValueRoutes from './routes/cost-value.js';
import { wecomOAuthRoutes } from './routes/wecom-oauth.js';
import { feishuOAuthRoutes } from './routes/feishu-oauth.js';
import { initFeishuBot, stopFeishuBot } from './feishu/bot/client.js';
import featureRequestRoutes from './routes/feature-requests.js';
import frictionRoutes from './routes/frictions.js';
import projectRoutes from './routes/projects.js';
import platformRoutes from './routes/platform.js';
import platformAdminRoutes from './routes/platform-admin.js';
import { bootstrapPlatform } from './platform/bootstrap.js';
import { projectsRegistration } from './platform/projects/application.js';
import { knowledgeRegistration } from './platform/knowledge/registration.js';
import { tablesRegistration } from './platform/tables/application.js';
import { initializePlatformRuntime } from './platform/runtime.js';
import promptRoutes from './routes/prompts.js';
import knowledgeRoutes from './routes/knowledge.js';
import { createSearchRoute } from './routes/search.js';
import { createRefsRoutes } from './routes/refs.js';
import { createActivityRoutes } from './routes/activity.js';
import shareRoutes from './routes/shares.js';
import { createNotificationRoutes } from './routes/notifications.js';
import pushDeviceRoutes from './routes/push-devices.js';
import adminMeteringRoutes from './routes/admin-metering.js';
import { adminComputerRoutes, computerRoutes } from './routes/computer.js';
import { sweepComputers } from './computer/service.js';
import usageRoutes from './routes/usage.js';
import toolsRoutes from './routes/tools.js';
import driveRoutes from './routes/drive.js';
import chatFileRoutes from './routes/chat-files.js';
import artifactActionRoutes from './routes/artifact-actions.js';
import skillRoutes from './routes/skills.js';
import reportTemplateRoutes from './routes/report-templates.js';
import { seedDefaultReportTemplates } from './reports/defaults.js';
import tablesRoutes from './routes/tables.js';
import { getSkillStore } from './skills/store.js';
import { seedSkillhub } from './skills/boot-seed.js';
import { sweepUnscannedSkills } from './skills/center.js';
import { backfillKnowledgeTokens } from './knowledge/backfill.js';
import { initScheduler } from './scheduler/index.js';
import { createEmailRoutes } from './routes/email.js';
import { createTasksRoute } from './routes/tasks.js';
import runtimeRoutes from './routes/runtime.js';
import { settleRetiredRuntimeRuns } from './runtime/retired-kinds.js';
import { startRuntimeWorker } from './runtime/worker.js';
import { reconcileInterruptedChatRuntimeRuns } from './chat/runtime.js';
import { reconcileInterruptedAgentWrites } from './agent-access/governed-write.js';
import { sweepExpiredToolOutputs } from './agent-runtime/tool-output-store.js';
import { scheduleRetention } from './upkeep/retention.js';
import { createAutomationRuntimeDriver } from './scheduler/runtime-driver.js';
import { createRuntimeNotificationProjector } from './notifications/runtime-projector.js';
import { AUTOMATION_DELIVERY_CHANNELS, startNotificationDeliveryWorker } from './notifications/delivery-worker.js';
import { mobilePushEnabled } from './notifications/push/config.js';
import { createRuntimeDomainProjector } from './runtime/domain-projector.js';
import {
  requireTrustedExecutionSurface,
  resolveTrustedExecutionSwitches,
  trustedExecutionBootPlan,
} from './trusted-execution/kill-switches.js';
import { initServiceCatalog } from './config/services.js';
import { initModelCatalog } from './config/models.js';
// ws CJS/ESM interop — use namespace import for reliable access
import * as _ws from 'ws';
const WsServer = _ws.WebSocketServer ?? (_ws as any).default?.WebSocketServer;
import wsRoutes from './ws/index.js';
import { connectionManager } from './ws/connection-manager.js';
import { startKnowledgeLiveUpdates } from './knowledge/live.js';
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

// ─── Static File Serving ──────────────────────────────

// Root is the repo root (absolute, computed from this module's location) — NOT
// `process.cwd()`. serve-static does `join(root, requestPath)`, so a relative
// `./` root silently breaks when the API is launched from anywhere other than
// the repo root (e.g. `cd apps/api && pnpm dev`), turning every /public asset
// (the logo included) into a 404. REPO_ROOT mirrors PUBLIC_DIR used below.
app.use('/public/*', serveStatic({ root: REPO_ROOT }));
// Vite emits the hashed bundle under public/assets with `base: './'`, so the
// SPA (served at `/`) requests them at `/assets/*`. Rewrite to the on-disk
// public/assets path (mirrors the proven `/public/*` mapping above).
app.use(
  '/assets/*',
  serveStatic({
    root: REPO_ROOT,
    rewriteRequestPath: (p) => `/public${p}`,
    // Vite 产物是内容哈希文件名——内容变则文件名变，所以这些 URL 的内容永不改写，
    // 可以按 immutable 永久缓存。浏览器与桌面壳都受益，WebView 壳尤其明显：冷启动
    // 只需回源取 index.html，其余静态资源全部本地命中。
    onFound: (_localPath, c) => {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }),
);

// Root-level static files the SPA references by absolute path (the icon set +
// web manifest shipped in apps/web/public and copied next to index.html by
// Vite). Explicit allowlist — never a directory listing of public/.
const ROOT_STATIC_FILES: Record<string, string> = {
  '/favicon.svg': 'image/svg+xml',
  '/apple-touch-icon.png': 'image/png',
  '/icon-192.png': 'image/png',
  '/icon-512.png': 'image/png',
  '/site.webmanifest': 'application/manifest+json',
};
for (const [path, contentType] of Object.entries(ROOT_STATIC_FILES)) {
  app.get(path, (c) => {
    const filePath = resolve(PUBLIC_DIR, path.slice(1));
    if (!existsSync(filePath)) return c.body(null, 404);
    c.header('Content-Type', contentType);
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(readFileSync(filePath));
  });
}

// Favicon — serve from public or return empty
app.get('/favicon.ico', (c) => {
  const faviconPath = resolve(PUBLIC_DIR, 'favicon.ico');
  if (existsSync(faviconPath)) {
    const data = readFileSync(faviconPath);
    c.header('Content-Type', 'image/x-icon');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(data);
  }
  return c.body(null, 204);
});

app.get('/', (c) => {
  // Vite build writes the production index.html (with hashed asset refs) into
  // public/. In dev the SPA is served by the Vite dev server (:3100), not here.
  const htmlPath = resolve(PUBLIC_DIR, 'index.html');
  if (!existsSync(htmlPath)) {
    return c.text('Frontend not built. Run: pnpm web:build', 404);
  }
  const html = readFileSync(htmlPath, 'utf-8');
  // index.html 引用的是哈希文件名，所以它自己必须每次回源确认——否则发布后客户端
  // 会拿着旧 HTML 去请求已经不存在的 assets。用 no-cache（可缓存但须 revalidate）
  // 而不是 no-store，前进/后退仍能走缓存。
  c.header('Cache-Control', 'no-cache');
  return c.html(html);
});

// ─── Mount Routes ────────────────────────────────────────
// One chained expression so the full route schema composes into AppType
// (consumed by hc clients via @greenhouse/contract). Registration order is
// load-bearing (e.g. OAuth protocol routes precede application routes) — do not reorder.
// Called from main() once the toolRegistry exists (needs the DB).

function mountRoutes(toolRegistry: ToolRegistry) {
  return (
    app
      // OAuth discovery/protocol and authenticated consent routes. This root
      // router must be mounted before narrower application routes.
      .route('/', oauthRoutes)
      .route('/api/auth', authRoutes)
      .route('/api/me', meRoutes)
      .route('/api/profiles', profileRoutes)
      .route('/api/sessions', sessionRoutes)
      .route('/health', healthRoutes)
      // Pre-login workspace personalization (name / logo / theme) — public.
      .route('/api/bootstrap', bootstrapRoutes)
      .route('/api/extensions', extensionsRoutes)
      .route('/api/upload', uploadRoutes)
      // `/oauth/callback` is a browser redirect from WeCom and carries no Bearer,
      // so it is allowed by isPublicPath and this router must not sit behind a
      // wildcard role guard; `/oauth/start` and `/binding` guard themselves.
      .route('/api/wecom', wecomOAuthRoutes)
      // Same reason: `/oauth/callback`, `/oauth/start-login` and `/oauth/exchange`
      // are public paths (the callback is a Feishu browser redirect; start-login /
      // exchange serve the not-yet-logged-in QR login), so no wildcard role guard;
      // `/oauth/start` and `/binding` guard themselves.
      .route('/api/feishu', feishuOAuthRoutes)
      // Super-admin-only routes
      .use('/api/admin/*', requireSuper())
      .route('/api/admin/platform', platformAdminRoutes)
      .route('/api/admin/operations', costValueRoutes)
      .route('/api/admin/metering', adminMeteringRoutes)
      .route('/api/admin/computers', adminComputerRoutes)
      .route('/api/admin', adminRoutes)
      .route('/api/admin/settings', adminSettingsRoutes)
      .route('/api/admin/team-context', adminTeamContextRoutes)
      .route('/api/admin/retro', adminRetroRoutes)
      .route('/api/admin/feature-requests', featureRequestRoutes)
      .route('/api/admin/frictions', frictionRoutes)
      // Project management — all internal users
      .use('/api/platform/*', requireInternal())
      .route('/api/platform', platformRoutes)
      .use('/api/projects/*', requireInternal())
      .route('/api/projects', projectRoutes)
      .use('/api/tables/*', requireInternal())
      .use('/api/tables/*', requireFeature('tables'))
      .route('/api/tables', tablesRoutes)
      // Email accounts — every internal user (mailbox binding is per-user and
      // self-service; the shared mailbox stays super-only inside the service).
      .use('/api/email/*', requireInternal())
      .route('/api/email', createEmailRoutes())
      // Prompts, knowledge docs & shares — all internal users
      .use('/api/prompts/*', requireInternal())
      .route('/api/prompts', promptRoutes)
      .use('/api/knowledge/*', requireInternal())
      .route('/api/knowledge', knowledgeRoutes)
      // Global search — guards live inside the route (a bare `/api/search` is not
      // matched by a `/*` prefix middleware), and each domain lane gates itself.
      .route('/api/search', createSearchRoute())
      // Object links → titles for chips (guard inside; each item authorized on its own).
      .route('/api/refs', createRefsRoutes())
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
      // Skill Center — all internal users (writes owner/super-gated in skills/center.ts)
      .use('/api/skills/*', requireInternal())
      .route('/api/skills', skillRoutes)
      // Report templates (v1.7) — all internal users (edit rights in reports/templates.ts)
      .use('/api/report-templates', requireInternal())
      .use('/api/report-templates/*', requireInternal())
      .route('/api/report-templates', reportTemplateRoutes)
      // Module usage counts (page opens) — all internal users; counts only
      .use('/api/data-catalog', requireInternal())
      .route('/api/data-catalog', dataCatalogRoutes)
      .use('/api/usage/*', requireInternal())
      .route('/api/usage', usageRoutes)
      .use('/api/computer/*', requireInternal())
      .route('/api/computer', computerRoutes)
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
      .use('/api/runtime', requireTrustedExecutionSurface(trustedExecutionPlan.taskCenter, 'task-center'))
      .use('/api/runtime/*', requireTrustedExecutionSurface(trustedExecutionPlan.taskCenter, 'task-center'))
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
 * The full typed route schema — the API contract consumed by hc clients
 * (via @greenhouse/contract). Type-only: importing this never runs the server.
 */
export type AppType = ReturnType<typeof mountRoutes>;

let dbProvider: DatabaseProvider;

// ─── Start Server ────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT ?? '3000', 10);
const HOSTNAME = process.env.API_HOST;

async function main() {
  assertAuthEnv(); // fail fast before binding if the signing key is absent
  // Resolve the Skill Center bundle store now: a PARTIAL SKILLS_S3_* config must
  // refuse to start (silently falling back to disk would strand new bundles).
  const skillStore = getSkillStore();
  dbProvider = await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });
  // Announce knowledge writes over WS (`knowledge.changed`) from the service's single write path.
  startKnowledgeLiveUpdates(dbProvider);
  // Extension-owned tables live in their own migration lane (core DDL stays in
  // drizzle/*.sql, applied before boot). Pending files are applied here, under
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
  initializePlatformRuntime(dbProvider, [
    projectsRegistration,
    knowledgeRegistration,
    tablesRegistration,
    ...extensionApplicationRegistrations(),
  ]);
  if (
    platformBootstrap.rolesCreated.length > 0 ||
    platformBootstrap.capabilitiesAdded > 0 ||
    platformBootstrap.entityPoliciesAdded > 0
  ) {
    logger.info('[Platform] Kernel bootstrap applied', { ...platformBootstrap });
  }

  // First-party skill packs ride the release: sync the repo's skillhub/ into
  // the Skill Center on boot (no-op without the directory; never blocks boot).
  await seedSkillhub(dbProvider);

  // The shipped report templates, once, while the workspace has never had one.
  await seedDefaultReportTemplates(dbProvider);

  // Backfill security verdicts for skills published before the scanner existed.
  // Fire-and-forget like the other boot sweeps — never blocks the health gate,
  // and failures only warn (publishing itself scans synchronously).
  void sweepUnscannedSkills(dbProvider);

  // Knowledge docs written before segmented FTS tokens existed are invisible to
  // search until tokenized. One-off backfill, fire-and-forget like the sweeps.
  void backfillKnowledgeTokens(dbProvider);

  const toolRegistry = createToolRegistry(dbProvider);
  await runExtensionBootHooks(dbProvider);

  // Runs of retired kinds (Eval, Mission, Workflow in v1.4; Subagent in 1.5) can never progress again;
  // close any that were still active at upgrade so they render as finished.
  await settleRetiredRuntimeRuns(dbProvider).catch((error) => {
    logger.error('[runtime] retired-kind settlement unavailable', { error: String(error) });
  });
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
  let runtimeWorker: Awaited<ReturnType<typeof startRuntimeWorker>> | null = null;
  let notificationDeliveryWorker: Awaited<ReturnType<typeof startNotificationDeliveryWorker>> | null = null;

  // Mount everything (single typed chain — see mountRoutes/AppType above)
  mountRoutes(toolRegistry);
  // Extension routes sit outside the typed contract: a fork's private API never
  // reshapes the public AppType.
  mountExtensionRoutes(app);

  // Feishu bot long connection: off by default (FEISHU_BOT_ENABLED=1 to connect);
  // a failed connection only warns and never takes the main API down.
  void initFeishuBot(toolRegistry);

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
    stopFeishuBot();
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
        logger.info(`   Skill store: ${skillStore.backend === 's3' ? 'S3-compatible' : 'local disk (data/skills)'}`);
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
    ...(trustedExecutionPlan.notificationProjector ? AUTOMATION_DELIVERY_CHANNELS : []),
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

  // Cloud computers, every minute: stop idle ones (all of them while the
  // switch is off), roll per-minute billing blocks, close half-done starts and
  // stops. Never creates a computer.
  setInterval(
    () =>
      void sweepComputers(dbProvider).catch((error) =>
        logger.warn('[computer] sweep failed', { error: toErrorMessage(error) }),
      ),
    60_000,
  );

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

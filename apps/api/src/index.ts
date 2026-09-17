/**
 * Greenhouse API — Hono server entry point.
 *
 * Mounts route modules, applies middleware, starts server.
 */

import { resolve } from 'node:path';
import { logger } from '@greenhouse/utils/logger';
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
import profileRoutes from './routes/profiles.js';
import sessionRoutes from './routes/sessions.js';
import coworkerRoutes from './routes/coworkers.js';
import evalRoutes from './routes/eval.js';
import { createChatRoute } from './routes/chat.js';
import clientActionRoutes from './routes/client-actions.js';
import { createAgentRoutes } from './routes/agent-tools.js';
import { createMcpRoutes } from './routes/mcp.js';
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
import { applyWorkspaceEnvOverlay } from './settings/workspace-config.js';
import uploadRoutes from './routes/upload.js';
import adminRoutes from './routes/admin.js';
import costValueRoutes from './routes/cost-value.js';
import adminGatewayRoutes from './routes/admin-llm-gateway.js';
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
import llmKeyRoutes from './routes/llm-keys.js';
import { createLlmRelayRoutes } from './routes/llm-relay.js';
import promptRoutes from './routes/prompts.js';
import knowledgeRoutes from './routes/knowledge.js';
import { createSearchRoute } from './routes/search.js';
import groupRoutes from './routes/groups.js';
import shareRoutes from './routes/shares.js';
import { createNotificationRoutes } from './routes/notifications.js';
import sessionTagRoutes from './routes/session-tags.js';
import sessionGroupRoutes from './routes/session-groups.js';
import toolsRoutes from './routes/tools.js';
import driveRoutes from './routes/drive.js';
import chatFileRoutes from './routes/chat-files.js';
import artifactActionRoutes from './routes/artifact-actions.js';
import skillRoutes from './routes/skills.js';
import tablesRoutes from './routes/tables.js';
import { createWorkbenchRoutes } from './routes/workbench.js';
import { getSkillStore } from './skills/store.js';
import { seedSkillhub } from './skills/boot-seed.js';
import { sweepUnscannedSkills } from './skills/center.js';
import { backfillKnowledgeTokens } from './knowledge/backfill.js';
import { initScheduler } from './scheduler/index.js';
import { createEmailRoutes } from './routes/email.js';
import { createTasksRoute } from './routes/tasks.js';
import { createWorkflowsRoute } from './routes/workflows.js';
import { initWorkflowEngine } from './workflow-engine/index.js';
import { createCloudAgentRoutes, createCloudAgentInternalRoutes } from './routes/cloud-agent.js';
import runtimeRoutes from './routes/runtime.js';
import { initMissionRuntime } from './cloud-agent/index.js';
import { startRuntimeReconciler } from './runtime/reconciler.js';
import { startRuntimeWorker } from './runtime/worker.js';
import { createEvalRuntimeDriver, reconcileEvalRuntimeRuns, reconcileReclaimedEvalRun } from './runtime/eval-driver.js';
import { reconcileInterruptedChatRuntimeRuns } from './chat/runtime.js';
import { createAutomationRuntimeDriver } from './scheduler/runtime-driver.js';
import { createSubagentRuntimeDriver, reconcileReclaimedSubagentRun } from './runtime/subagent-driver.js';
import { createRuntimeNotificationProjector } from './notifications/runtime-projector.js';
import { startNotificationDeliveryWorker } from './notifications/delivery-worker.js';
import { createRuntimeDomainProjector } from './runtime/domain-projector.js';
import { startAgentGovernanceWorker } from './agent-governance/worker.js';
import {
  requireTrustedExecutionSurface,
  resolveTrustedExecutionSwitches,
  trustedExecutionBootPlan,
} from './trusted-execution/kill-switches.js';
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
  // Canonical Mission paths and their temporary technical aliases share the
  // exact same Hono instances. Compatibility must never fork authorization or
  // validation into a second handler implementation.
  const missionRoutes = createCloudAgentRoutes();
  const missionInternalRoutes = createCloudAgentInternalRoutes();
  return (
    app
      // OAuth discovery/protocol and authenticated consent routes. This root
      // router must be mounted before narrower application routes.
      .route('/', oauthRoutes)
      .route('/api/auth', authRoutes)
      .route('/api/profiles', profileRoutes)
      .route('/api/sessions', sessionRoutes)
      .route('/api/coworkers', coworkerRoutes)
      .route('/health', healthRoutes)
      // Pre-login workspace personalization (name / logo / theme) — public.
      .route('/api/bootstrap', bootstrapRoutes)
      .route('/api/extensions', extensionsRoutes)
      .route('/api/upload', uploadRoutes)
      // Internal-only routes (team + super)
      .use('/api/eval/*', requireSuper())
      .route('/api/eval', evalRoutes)
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
      .route('/api/admin', adminRoutes)
      .route('/api/admin/settings', adminSettingsRoutes)
      .route('/api/admin/llm-gateway', adminGatewayRoutes)
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
      // Drive — internal users; per-node checks live in resolveDriveAccess
      .use('/api/drive/*', requireInternal())
      .route('/api/drive', driveRoutes)
      .use('/api/chat-files/*', requireInternal())
      .route('/api/chat-files', chatFileRoutes)
      .use('/api/artifact-actions/*', requireInternal())
      .route('/api/artifact-actions', artifactActionRoutes)
      .use('/api/groups/*', requireInternal())
      .route('/api/groups', groupRoutes)
      .use('/api/shares/*', requireInternal())
      .route('/api/shares', shareRoutes)
      .use('/api/notifications', requireInternal())
      .use('/api/notifications/*', requireInternal())
      .route('/api/notifications', createNotificationRoutes())
      // Skill Center — all internal users (writes owner/super-gated in skills/center.ts)
      .use('/api/skills/*', requireInternal())
      .route('/api/skills', skillRoutes)
      // Session tags — all internal users
      .use('/api/session-tags/*', requireInternal())
      .route('/api/session-tags', sessionTagRoutes)
      // Session groups (folders) + Pinned — all internal users
      .use('/api/session-groups/*', requireInternal())
      .route('/api/session-groups', sessionGroupRoutes)
      // Tool metadata — authenticated internal users
      .route('/api/tools', toolsRoutes)
      // Team Gateway Key self-service — all internal users
      .use('/api/auth/llm-keys/*', requireInternal())
      .route('/api/auth/llm-keys', llmKeyRoutes)
      // WebSocket endpoint — internal users only (auth via query token)
      .route('/api/ws', wsRoutes)
      // Browser client-action results — internal user-bound and part of the typed contract
      .use('/api/client-actions/*', requireInternal())
      .route('/api/client-actions', clientActionRoutes)
      // ── Registry-dependent routes (need DB-backed toolRegistry) ──
      .route('/api/chat', createChatRoute(toolRegistry))
      // Home workbench card evaluation — every internal user. Cards are
      // evaluated as the requesting user through the read-only tool allowlist,
      // so this widens nothing the user could not already query; a user with no
      // cards never calls it at all.
      .use('/api/workbench/*', requireInternal())
      .route('/api/workbench', createWorkbenchRoutes(toolRegistry))
      .use('/api/tasks/*', requireInternal())
      .route('/api/tasks', createTasksRoute())
      // Runtime is the cross-domain Execution Center read model. Domain drivers
      // remain authoritative and every object is owner/super guarded again in
      // the route as defense in depth.
      .use('/api/runtime', requireInternal())
      .use('/api/runtime/*', requireInternal())
      .use('/api/runtime', requireTrustedExecutionSurface(trustedExecutionPlan.taskCenter, 'task-center'))
      .use('/api/runtime/*', requireTrustedExecutionSurface(trustedExecutionPlan.taskCenter, 'task-center'))
      .route('/api/runtime', runtimeRoutes)
      // Workflow graph engine — temporarily restricted to super while the
      // feature is being validated. Guard both the collection root and children.
      .use('/api/workflows', requireSuper())
      .use('/api/workflows/*', requireSuper())
      .route('/api/workflows', createWorkflowsRoute())
      // Sandbox Runner push surface — run-bound task-token auth inside the
      // route (exempted from central Bearer via isPublicPath). Mounted BEFORE
      // the user-facing guards so those never intercept /internal/*. The
      // technical path remains a compatibility alias for older runner images.
      .route('/api/missions/internal', missionInternalRoutes)
      .route('/api/cloud-agent/internal', missionInternalRoutes)
      // Canonical Mission user surface. The technical cloud-agent path below
      // remains a compatibility alias.
      .use('/api/missions/*', requireInternal())
      .use('/api/missions/*', requireFeature('cloud-agent'))
      .route('/api/missions', missionRoutes)
      // Legacy user surface — internal users behind the same feature flag.
      .use('/api/cloud-agent/*', requireInternal())
      .use('/api/cloud-agent/*', requireFeature('cloud-agent'))
      .route('/api/cloud-agent', missionRoutes)
      // LLM gateway relay (independent relay-key auth + rate limiting)
      .route('/api/llm', createLlmRelayRoutes())
      // Agent tool proxy (login access-token auth, revalidated against the internal user)
      .route('/api/agent', createAgentRoutes(toolRegistry))
      .route('/api/mcp', createMcpRoutes(toolRegistry))
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
  const usageBudgetSweeper = await startUsageBudgetSweeper(dbProvider);
  const platformBootstrap = await bootstrapPlatform(dbProvider);
  initializePlatformRuntime(dbProvider, [
    projectsRegistration,
    knowledgeRegistration,
    tablesRegistration,
    ...extensionApplicationRegistrations(),
  ]);
  if (
    platformBootstrap.appReleasesActivated.length > 0 ||
    platformBootstrap.rolesCreated.length > 0 ||
    platformBootstrap.capabilitiesAdded > 0 ||
    platformBootstrap.entityPoliciesAdded > 0
  ) {
    logger.info('[Platform] Kernel bootstrap applied', { ...platformBootstrap });
  }

  // First-party skill packs ride the release: sync the repo's skillhub/ into
  // the Skill Center on boot (no-op without the directory; never blocks boot).
  await seedSkillhub(dbProvider);

  // Backfill security verdicts for skills published before the scanner existed.
  // Fire-and-forget like the other boot sweeps — never blocks the health gate,
  // and failures only warn (publishing itself scans synchronously).
  void sweepUnscannedSkills(dbProvider);

  // Knowledge docs written before segmented FTS tokens existed are invisible to
  // search until tokenized. One-off backfill, fire-and-forget like the sweeps.
  void backfillKnowledgeTokens(dbProvider);

  const toolRegistry = createToolRegistry(dbProvider);
  await runExtensionBootHooks(dbProvider);

  // Rebuild Mission/Workflow Runtime projections before accepting Execution Center
  // reads, then keep compensating domain/read-model dual writes in background.
  const runtimeReconciler = trustedExecutionPlan.runtimeReconciler
    ? await startRuntimeReconciler(dbProvider, {
        adapters: {
          mission: trustedExecutionSwitches.missionAdapter,
          workflow: trustedExecutionSwitches.workflowAdapter,
        },
      })
    : null;
  // Chat is trace-only and cannot safely replay after process death. Always
  // close historical active traces, even when new Chat tracing is killed for
  // rollout; a Runtime outage must not prevent the rest of Chat from booting.
  await reconcileInterruptedChatRuntimeRuns(dbProvider).catch((error) => {
    logger.error('[chat-runtime] boot reconciliation unavailable', { error: String(error) });
  });
  // Eval queueing is a write-side Runtime consumer and therefore follows the
  // durable worker switch. Mission/Workflow domain engines remain independent.
  if (trustedExecutionPlan.evalDriver) await reconcileEvalRuntimeRuns(dbProvider);
  let runtimeWorker: Awaited<ReturnType<typeof startRuntimeWorker>> | null = null;
  let notificationDeliveryWorker: Awaited<ReturnType<typeof startNotificationDeliveryWorker>> | null = null;
  const agentGovernanceWorker = trustedExecutionPlan.agentGovernance
    ? await startAgentGovernanceWorker({ db: dbProvider })
    : null;

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

  // Workflow graph engine — boot sweep resumes unfinished runs in the background
  initWorkflowEngine(toolRegistry);

  // Abort in-flight chat runs BEFORE closing the DB: the interruption
  // persistence path then writes safe partial answers, so a deploy/restart
  // doesn't erase whole in-progress turns.
  const shutdown = async () => {
    scheduler.stop();
    usageBudgetSweeper.stop();
    runtimeReconciler?.stop();
    runtimeWorker?.stop();
    notificationDeliveryWorker?.stop();
    agentGovernanceWorker?.stop();
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
  notificationDeliveryWorker = trustedExecutionPlan.notificationProjector
    ? await startNotificationDeliveryWorker({ db: dbProvider })
    : null;

  // Eval calls the authenticated local HTTP surface, so no Runtime driver may
  // claim work until the socket above is actually listening. The boot pass is
  // now safe and also drains stale leases/outbox immediately.
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
          ...(trustedExecutionPlan.evalDriver ? { eval: createEvalRuntimeDriver() } : {}),
          ...(trustedExecutionPlan.automationDriver ? { automation: createAutomationRuntimeDriver(toolRegistry) } : {}),
          ...(trustedExecutionPlan.subagentDriver ? { subagent: createSubagentRuntimeDriver({ toolRegistry }) } : {}),
        },
        driverConcurrency: { eval: 1, automation: 3, subagent: 5 },
        onRunReclaimed: async (run) => {
          if (run.kind === 'eval') await reconcileReclaimedEvalRun(dbProvider, run);
          else if (run.kind === 'subagent') await reconcileReclaimedSubagentRun(dbProvider, run);
        },
      })
    : null;

  // Mission control plane + Sandbox Runner initializes after the main platform
  // is already serving. Missing/hung Docker hardening therefore closes only
  // Mission admission instead of delaying Chat and health availability.
  await initMissionRuntime();

  // Heartbeat: ping all WS connections every 30s
  setInterval(() => void connectionManager.pingAll(), 30_000);
}

main().catch((err) => {
  logger.error('Fatal:', err);
  process.exit(1);
});

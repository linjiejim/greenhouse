/**
 * Greenhouse API — Hono server entry point.
 *
 * Mounts route modules, applies middleware, starts server.
 */

import { resolve } from 'node:path';
import { logger } from '@greenhouse/utils/logger';
import { PRODUCT_NAME } from '@greenhouse/utils/brand';
import { readFileSync, existsSync } from 'node:fs';
import { config } from 'dotenv';
import { ENV_FILE, PUBLIC_DIR, REPO_ROOT } from './paths.js';

// Load .env before anything else
config({ path: ENV_FILE });

// ─── Proxy for external APIs (Google, Microsoft, etc.) ───
// Node.js native fetch (undici) doesn't read proxy env vars by default.
// EnvHttpProxyAgent honors HTTP(S)_PROXY *and* NO_PROXY — a plain ProxyAgent
// would also drag loopback/LAN targets (a local MinIO skill store, Ollama)
// through the proxy, where they are unreachable.
import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';
const _httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (_httpsProxy) {
  setGlobalDispatcher(new EnvHttpProxyAgent());
  logger.info(`[Proxy] 🌐 Global fetch proxy set: ${_httpsProxy} (NO_PROXY honored)`);
}

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse';
import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { createToolRegistry, type ToolRegistry } from './agent.js';
import type { AppEnv } from './app-env.js';
import { listProfileIds } from './profile.js';
import { authMiddleware, requireSuper, requireInternal, requireFeature } from './auth/middleware.js';
import { assertAuthEnv } from './auth/token.js';
import { corsMiddleware, rateLimitMiddleware, securityHeadersMiddleware } from './security.js';

// Route modules
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import sessionRoutes from './routes/sessions.js';
import { createChatRoute } from './routes/chat.js';
import { createV1Routes } from './routes/v1/index.js';
import { createAgentRoutes } from './routes/agent-tools.js';
import { createMcpRoutes } from './routes/mcp.js';
import healthRoutes from './routes/health.js';
import uploadRoutes from './routes/upload.js';
import adminRoutes from './routes/admin.js';
import clientRoutes from './routes/admin-clients.js';
import adminGatewayRoutes from './routes/admin-llm-gateway.js';
import adminImRoutes from './routes/admin-im.js';
import imRoutes from './routes/im.js';
import featureRequestRoutes from './routes/feature-requests.js';
import projectRoutes from './routes/projects.js';
import llmKeyRoutes from './routes/llm-keys.js';
import { createLlmRelayRoutes } from './routes/llm-relay.js';
import promptRoutes from './routes/prompts.js';
import knowledgeRoutes from './routes/knowledge.js';
import skillRoutes from './routes/skills.js';
import groupRoutes from './routes/groups.js';
import shareRoutes from './routes/shares.js';
import sessionTagRoutes from './routes/session-tags.js';
import sessionGroupRoutes from './routes/session-groups.js';
import toolsRoutes from './routes/tools.js';
import { emailRoutes } from './routes/email.js';
import { initScheduler } from './scheduler/index.js';
import { initImGateway } from './im/gateway.js';
import { createTasksRoute } from './routes/tasks.js';
import { mountExtraRoutes } from './routes/extensions.js';
import { bootstrapForkExtensions } from './bootstrap.extensions.js';
import { maybeRegisterLocalStorageDriver } from './storage/local-driver.js';
import { getSkillStore } from './skills/store.js';
// ws CJS/ESM interop — use namespace import for reliable access
import * as _ws from 'ws';
const WsServer = _ws.WebSocketServer ?? (_ws as any).default?.WebSocketServer;
import wsRoutes from './ws/index.js';
import { connectionManager } from './ws/connection-manager.js';

const app = new Hono<AppEnv>();

// ─── Security Middleware ─────────────────────────────────

app.use('*', securityHeadersMiddleware);
app.use('*', corsMiddleware);
app.use('*', rateLimitMiddleware);
app.use('*', authMiddleware);

// ─── Request Logging Middleware ──────────────────────────

app.use('*', async (c, next) => {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;
  const url = new URL(c.req.url);
  const query = url.search || '';

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
app.use('/assets/*', serveStatic({ root: REPO_ROOT, rewriteRequestPath: (p) => `/public${p}` }));

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
  return c.html(html);
});

// ─── Mount Routes ────────────────────────────────────────
// One chained expression so the full route schema composes into AppType
// (consumed by hc clients via @greenhouse/contract). Registration order is
// load-bearing — do not reorder.
// Called from main() once the toolRegistry exists (needs the DB).

function mountRoutes(toolRegistry: ToolRegistry) {
  return (
    app
      .route('/api/auth', authRoutes)
      .route('/api/profiles', profileRoutes)
      .route('/api/sessions', sessionRoutes)
      .route('/health', healthRoutes)
      .route('/api/upload', uploadRoutes)
      // Super-admin-only routes
      .use('/api/admin/*', requireSuper())
      .route('/api/admin', adminRoutes)
      .route('/api/admin/clients', clientRoutes)
      .route('/api/admin/llm-gateway', adminGatewayRoutes)
      .route('/api/admin/feature-requests', featureRequestRoutes)
      .route('/api/admin/im', adminImRoutes)
      // Project management — all internal users
      .use('/api/projects/*', requireInternal())
      .route('/api/projects', projectRoutes)
      // Prompts, knowledge docs & shares — all internal users
      .use('/api/prompts/*', requireInternal())
      .route('/api/prompts', promptRoutes)
      .use('/api/knowledge/*', requireInternal())
      .route('/api/knowledge', knowledgeRoutes)
      // Skill Center — all internal users (writes owner/super-gated in skills/center.ts)
      .use('/api/skills/*', requireInternal())
      .route('/api/skills', skillRoutes)
      .use('/api/groups/*', requireInternal())
      .route('/api/groups', groupRoutes)
      .use('/api/shares/*', requireInternal())
      .route('/api/shares', shareRoutes)
      // Session tags — all internal users
      .use('/api/session-tags/*', requireInternal())
      .route('/api/session-tags', sessionTagRoutes)
      // Session groups (folders) + Pinned — all internal users
      .use('/api/session-groups/*', requireInternal())
      .route('/api/session-groups', sessionGroupRoutes)
      // IM gateway (Telegram) — internal users, feature-gated. Deep-link pairing + identity mgmt.
      .use('/api/im/*', requireInternal())
      .use('/api/im/*', requireFeature('im_gateway'))
      .route('/api/im', imRoutes)
      // Tool metadata — all users (including external for their allowed tools)
      .route('/api/tools', toolsRoutes)
      // Email account management — OAuth callbacks bypass auth (redirect from Google/Microsoft)
      // Other email routes require internal auth
      .route('/api/email', emailRoutes)
      // Team Gateway Key self-service — all internal users
      .use('/api/auth/llm-keys/*', requireInternal())
      .route('/api/auth/llm-keys', llmKeyRoutes)
      // WebSocket endpoint — internal users only (auth via query token)
      .route('/api/ws', wsRoutes)
      // ── Registry-dependent routes (need DB-backed toolRegistry) ──
      .route('/api/chat', createChatRoute(toolRegistry))
      .use('/api/tasks/*', requireInternal())
      .route('/api/tasks', createTasksRoute(toolRegistry))
      // External v1 API (independent auth + rate limiting)
      .route('/api/v1', createV1Routes(toolRegistry))
      // LLM gateway relay (independent relay-key auth + rate limiting)
      .route('/api/llm', createLlmRelayRoutes())
      // Agent tool proxy (API-key auth bound to an internal user)
      .route('/api/agent', createAgentRoutes(toolRegistry))
      .route('/api/mcp', createMcpRoutes(toolRegistry))
  );
}

/**
 * The full typed route schema — the API contract consumed by hc clients
 * (via @greenhouse/contract). Type-only: importing this never runs the server.
 * Note: /api/client-tools is mounted dynamically in main() and is deliberately
 * outside the contract (browser client-action callback surface).
 */
export type AppType = ReturnType<typeof mountRoutes>;

let dbProvider: DatabaseProvider;

// ─── Start Server ────────────────────────────────────────

const PORT = parseInt(process.env.API_PORT ?? '3000', 10);

async function main() {
  assertAuthEnv(); // fail fast: auth enabled ⇒ TOKEN_SIGNING_KEY must be set
  // Wire fork runtime extensions (providers, connectors, storage, flags,
  // summarizers) before anything uses them. No-op upstream — see bootstrap.extensions.ts.
  bootstrapForkExtensions();
  // Dev/verification: register a disk-backed object-storage driver (with presigned
  // URLs) when STORAGE_DRIVER=local — no-op otherwise, and never overrides a fork's.
  maybeRegisterLocalStorageDriver();
  // Resolve the Skill Center bundle store now: a PARTIAL SKILLS_S3_* config must
  // refuse to start (silently falling back to disk would strand new bundles).
  const skillStore = getSkillStore();
  dbProvider = await initDatabase({ type: 'pg', pgConnectionString: DATABASE_URL });

  const toolRegistry = createToolRegistry(dbProvider);

  // Mount everything (single typed chain — see mountRoutes/AppType above)
  mountRoutes(toolRegistry);

  // Mount client-tools route (client-action result endpoint; dynamic import keeps
  // this callback surface out of the static module graph and the contract)
  const { createClientToolsRoute } = await import('./routes/client-tools.js');
  app.route('/api/client-tools', createClientToolsRoute());

  // CRUD framework demo (super-only) — reference wiring of @greenhouse/crud.
  // Generic protocol, so deliberately outside the AppType contract.
  const { createCrudDemoRoutes } = await import('./routes/crud-demo.js');
  app.route('/api/crud/demo', createCrudDemoRoutes());

  // Mount fork-contributed private routes (empty upstream). Also outside the
  // AppType contract — see routes/extensions.ts.
  mountExtraRoutes(app, toolRegistry);

  // Start task scheduler
  const scheduler = initScheduler(toolRegistry);
  await scheduler.start();

  // Start IM gateway — receives inbound chat-platform messages for connected bots
  // (Telegram in M0). Dormant if PROVIDER_TOKEN_ENCRYPTION_KEY is unset.
  const imGateway = initImGateway(toolRegistry);
  await imGateway.start();

  process.on('SIGINT', async () => {
    scheduler.stop();
    await imGateway.stop();
    await dbProvider.close();
    process.exit(0);
  });
  process.on('SIGTERM', async () => {
    scheduler.stop();
    await imGateway.stop();
    await dbProvider.close();
    process.exit(0);
  });

  const wss = new WsServer({ noServer: true });

  serve({ fetch: app.fetch, port: PORT, websocket: { server: wss } }, (info) => {
    const profileIds = listProfileIds();
    logger.info(`\n🌱 ${PRODUCT_NAME} API running at http://localhost:${info.port}`);
    logger.info(`   Model: ${process.env.LLM_MODEL ?? '(set LLM_MODEL)'}`);
    logger.info(`   Database: PostgreSQL`);
    logger.info(`   Skill store: ${skillStore.backend === 's3' ? 'S3-compatible' : 'local disk (data/skills)'}`);
    logger.info(`   Profiles: ${profileIds.join(', ')}`);
    logger.info(`   WebSocket: enabled`);
  });

  // Heartbeat: ping all WS connections every 30s
  setInterval(() => connectionManager.pingAll(), 30_000);
}

main().catch((err) => {
  logger.error('Fatal:', err);
  process.exit(1);
});

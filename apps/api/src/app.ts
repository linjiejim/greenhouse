import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { API_VERSION } from '@greenhouse/contract';
import type { AppConfig } from './config/index.js';
import { requireAdmin, requireMember } from './auth/middleware.js';
import { createTokens, type Tokens } from './auth/tokens.js';
import { handleError, handleNotFound } from './http/errors.js';
import type { AppEnv } from './http/env.js';
import { cors, securityHeaders } from './security/headers.js';
import { RateLimiter } from './security/rate-limit.js';
import { requestSourceIp } from './security/request-ip.js';
import { authRoutes } from './modules/auth/routes.js';
import { createAuthService, type AuthService } from './modules/auth/service.js';
import { adminMemberRoutes, directoryRoutes, meRoutes } from './modules/members/routes.js';
import { createMembersService, type MembersService } from './modules/members/service.js';
import { bootstrapRoutes, brandingRoutes } from './modules/workspace/routes.js';
import { createWorkspaceService, type WorkspaceService } from './modules/workspace/service.js';
import { createEngine, type Engine } from './engine/engine.js';
import { askUserTool } from './engine/tools/ask-user.js';
import { readAttachmentTool } from './engine/tools/attachments.js';
import { conversationTool } from './engine/tools/conversation.js';
import { handoffTool } from './engine/tools/handoff.js';
import { memoryTool } from './engine/tools/memory.js';
import type { ToolDef } from './engine/tools/define.js';
import { runStartTool } from './engine/tools/run-start.js';
import { scheduleTools } from './engine/tools/schedules.js';
import { selfTool } from './engine/tools/self.js';
import { webTools } from './engine/tools/web.js';
import { agentRoutes } from './modules/agents/routes.js';
import { createAgentsService, type AgentsService } from './modules/agents/service.js';
import { conversationRoutes } from './modules/conversations/routes.js';
import { fileRoutes } from './modules/files/routes.js';
import { createFilesService, type FilesService } from './modules/files/service.js';
import { notificationRoutes } from './modules/notifications/routes.js';
import { createNotificationsService, type NotificationsService } from './modules/notifications/service.js';
import { requestRoutes } from './modules/requests/routes.js';
import { runRoutes } from './modules/runs/routes.js';
import { scheduleRoutes } from './modules/schedules/routes.js';
import { createSchedulesService, type SchedulesService } from './modules/schedules/service.js';
import { createRunsService, type RunsService } from './modules/runs/service.js';
import { createRequestsService, type RequestsService } from './modules/requests/service.js';
import { createConversationsService, type ConversationsService } from './modules/conversations/service.js';
import { createHub, type Hub } from './realtime/hub.js';
import { adminProviderRoutes, myProviderRoutes } from './providers/routes.js';
import { createProvidersService, type ProvidersService } from './providers/service.js';

export interface Services {
  config: AppConfig;
  tokens: Tokens;
  auth: AuthService;
  workspace: WorkspaceService;
  members: MembersService;
  providers: ProvidersService;
  agents: AgentsService;
  conversations: ConversationsService;
  files: FilesService;
  notifications: NotificationsService;
  requests: RequestsService;
  runs: RunsService;
  schedules: SchedulesService;
  hub: Hub;
  engine: Engine;
  limiter: RateLimiter;
}

export interface ServiceOptions {
  /** Replaces the network for provider calls (tests). */
  fetch?: typeof fetch;
  /** Replaces model resolution in the engine (tests). */
  languageModel?: ProvidersService['languageModel'];
  /** Tools added to the built-in ones (extensions, tests). */
  tools?: readonly ToolDef[];
}

export function createServices(config: AppConfig, options: ServiceOptions = {}): Services {
  const tokens = createTokens(config.tokenSigningKey);
  const auth = createAuthService({ tokens, publicUrl: config.PUBLIC_URL });
  const providers = createProvidersService({ config, fetch: options.fetch });
  const agents = createAgentsService({ providers });
  const conversations = createConversationsService({ agents, providers });
  const hub = createHub();
  const files = createFilesService({ providers });
  const notifications = createNotificationsService({ hub });
  const schedules = createSchedulesService({ agents, background: () => engine.background });
  const requests = createRequestsService({ hub, notifications });
  const engine = createEngine({
    agents,
    conversations,
    providers,
    requests,
    files,
    notifications,
    hub,
    tools: ({ background, handOff }) => [
      memoryTool(agents),
      askUserTool(),
      selfTool(agents),
      conversationTool(),
      readAttachmentTool(files),
      runStartTool(background),
      handoffTool(handOff),
      ...scheduleTools(schedules),
      ...webTools(providers, options.fetch ? { fetch: options.fetch } : {}),
      ...(options.tools ?? []),
    ],
    ...(options.languageModel ? { languageModel: options.languageModel } : {}),
  });
  const runs = createRunsService({ background: () => engine.background });
  return {
    config,
    tokens,
    auth,
    workspace: createWorkspaceService(),
    members: createMembersService({ auth }),
    providers,
    agents,
    conversations,
    files,
    notifications,
    requests,
    runs,
    schedules,
    hub,
    engine,
    limiter: new RateLimiter(10, 60_000),
  };
}

/**
 * The HTTP surface. Public: /health, /api/bootstrap, /api/auth/*. Everything else under
 * /api requires a member; /api/admin/* also requires an admin.
 */
export function createApp(services: Services) {
  const { config } = services;
  const member = requireMember(services.tokens);
  const trust = { trustedProxies: config.trustedProxyIps, proxyHops: config.TRUSTED_PROXY_HOPS };

  const app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound(handleNotFound);
  app.use('*', securityHeaders, cors(config.corsAllowedOrigins), async (c, next) => {
    c.set('requestId', c.req.header('x-request-id')?.slice(0, 64) || randomUUID());
    await next();
  });

  app.get('/health', async (c) => {
    try {
      return c.json({ ok: true, api_version: API_VERSION, services: await services.providers.status() });
    } catch {
      return c.json({ ok: false, api_version: API_VERSION }, 503);
    }
  });
  app.route('/api/bootstrap', bootstrapRoutes(services.workspace));
  app.route(
    '/api/auth',
    authRoutes({ auth: services.auth, limiter: services.limiter, clientIp: (c) => requestSourceIp(c as never, trust) }),
  );

  const signedIn = new Hono<AppEnv>();
  signedIn.use('*', member);
  signedIn.route('/me/providers', myProviderRoutes(services.providers));
  signedIn.route('/me', meRoutes(services.members));
  signedIn.route('/members', directoryRoutes(services.members));
  signedIn.route('/agents', agentRoutes(services.agents));
  signedIn.route('/conversations', conversationRoutes(services.conversations, services.engine));
  signedIn.route('/requests', requestRoutes(services.requests, services.engine));
  signedIn.route('/runs', runRoutes(services.runs));
  signedIn.route('/files', fileRoutes(services.files, services.conversations));
  signedIn.route('/schedules', scheduleRoutes(services.schedules));
  signedIn.route('/notifications', notificationRoutes(services.notifications));
  signedIn.use('/admin/*', requireAdmin);
  signedIn.route('/admin', adminMemberRoutes(services.members));
  signedIn.route('/admin/branding', brandingRoutes(services.workspace));
  signedIn.route('/admin', adminProviderRoutes(services.providers));
  app.route('/api', signedIn);

  return app;
}

export type App = ReturnType<typeof createApp>;

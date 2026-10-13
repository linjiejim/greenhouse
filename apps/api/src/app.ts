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
import { adminProviderRoutes, myProviderRoutes } from './providers/routes.js';
import { createProvidersService, type ProvidersService } from './providers/service.js';

export interface Services {
  config: AppConfig;
  tokens: Tokens;
  auth: AuthService;
  workspace: WorkspaceService;
  members: MembersService;
  providers: ProvidersService;
  limiter: RateLimiter;
}

export interface ServiceOptions {
  /** Replaces the network for provider calls (tests). */
  fetch?: typeof fetch;
}

export function createServices(config: AppConfig, options: ServiceOptions = {}): Services {
  const tokens = createTokens(config.tokenSigningKey);
  const auth = createAuthService({ tokens, publicUrl: config.PUBLIC_URL });
  return {
    config,
    tokens,
    auth,
    workspace: createWorkspaceService(),
    members: createMembersService({ auth }),
    providers: createProvidersService({ config, fetch: options.fetch }),
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
  signedIn.use('/admin/*', requireAdmin);
  signedIn.route('/admin', adminMemberRoutes(services.members));
  signedIn.route('/admin/branding', brandingRoutes(services.workspace));
  signedIn.route('/admin', adminProviderRoutes(services.providers));
  app.route('/api', signedIn);

  return app;
}

export type App = ReturnType<typeof createApp>;

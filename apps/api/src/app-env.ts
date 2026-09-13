/**
 * Shared Hono environment — types what auth middleware puts on the context.
 *
 * Route files instantiate `new Hono<AppEnv>()` so `c.get('user')` is typed
 * and the chained route definitions compose into the exported `AppType`
 * consumed by hc clients (packages/contract).
 */

import type { AuthUser } from './auth/token.js';
import type { AgentIdentity } from './agent-runtime/api-auth.js';
import type { OAuthScope } from './platform/oauth.js';

export type AppEnv = {
  Variables: {
    /** Set by authMiddleware for authenticated requests. */
    user: AuthUser;
    /** Set by Agent/MCP credential middleware. */
    agentIdentity: AgentIdentity;
    /** Set by the OAuth-only MCP credential middleware. */
    oauthClientId: string;
    oauthScopes: OAuthScope[];
    /** 'oauth' = authorization-code (human consent); 'oauth-client' = client_credentials (machine). */
    oauthAuthMethod: 'oauth' | 'oauth-client';
  };
};

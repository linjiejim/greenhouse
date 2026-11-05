/**
 * Shared Hono environment — types what auth middleware puts on the context.
 *
 * Route files instantiate `new Hono<AppEnv>()` so `c.get('user')` is typed
 * and the chained route definitions compose into the exported `AppType`
 * (the typed route schema).
 */

import type { AuthUser } from './auth/token.js';
import type { AgentIdentity } from './agent-runtime/api-auth.js';
import type { OAuthScope } from './agent-access/oauth.js';

export interface PluginUiSources {
  media: readonly string[];
  connect: readonly string[];
}

export type AppEnv = {
  Variables: {
    /**
     * Set only by the host static-plugin mount; permits same-origin embedding. `media` are the
     * extra img/media sources (the object store's direct origin, then the plugin's `uiMedia`),
     * `connect` the extra connect sources (the object store's direct origin, for uploads).
     */
    extensionUi?: PluginUiSources;
    /** Set by authMiddleware for authenticated requests. */
    user: AuthUser;
    /** Set by authMiddleware when the request carries a plugin embed token: that plugin's id. */
    embedPlugin?: string;
    /** Set by Agent/MCP credential middleware. */
    agentIdentity: AgentIdentity;
    /** Set by the OAuth-only MCP credential middleware. */
    oauthClientId: string;
    oauthScopes: OAuthScope[];
    /** 'oauth' = authorization-code (human consent); 'oauth-client' = client_credentials (machine). */
    oauthAuthMethod: 'oauth' | 'oauth-client';
  };
};

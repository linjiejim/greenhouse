// VENDORED from packages/types/src/client-routes.ts — verbatim below this header.
// Change the canonical file, re-copy it, and run src/shared/vendor.parity.test.ts.
// apps/client cannot import workspace packages (see apps/client/AGENTS.md).

/**
 * Universal client routes the server sends a browser to (emails, OAuth returns, IM messages).
 *
 * One table so the server's links and the client's routes cannot drift: apps/client keeps a
 * verbatim copy in src/shared/client-routes.ts, checked by its vendor parity test.
 *
 * A secret (an activation token, a one-shot sign-in code, a provider's authorization code) rides
 * in the fragment: browsers never send it to a server, so it stays out of access logs and
 * Referer headers. The client reads it once and removes it from the address bar.
 */

export const CLIENT_ROUTES = {
  /** One-time account setup or password reset: `#token=`. */
  activate: '/activate',
  /** MCP OAuth consent: the authorization request's query, unchanged. */
  oauthConsent: '/oauth-consent',
  /** A connector's OAuth return in the browser: `#code=&state=`, or `#error=&connector_id=`. */
  connectorFinish: '/connectors/oauth-finish',
  /** Sign-in. An identity provider returns here with `#<provider>_code=` or `#<provider>=error&reason=`. */
  login: '/login',
  /** Where an account binding returns: `?<provider>=ok`, or `?<provider>=error&reason=`. */
  bindings: '/bindings',
  /** Me → Connections: account bindings and connectors. */
  connections: '/me/connectors',
} as const;

export type ClientRoute = (typeof CLIENT_ROUTES)[keyof typeof CLIENT_ROUTES];

/** Client routes whose parameters ride in the fragment. */
export const FRAGMENT_ROUTES: readonly ClientRoute[] = [
  CLIENT_ROUTES.activate,
  CLIENT_ROUTES.connectorFinish,
  CLIENT_ROUTES.login,
];

/** A plugin page of the universal client (`/p/<plugin>/<page>`). */
export function pluginPagePath(plugin: string, page: string): string {
  return `/p/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}`;
}

/** An absolute link to a client route on `base` (an origin; a trailing slash is ignored). */
export function clientRouteUrl(
  base: string,
  route: ClientRoute,
  parts: { query?: Record<string, string>; fragment?: Record<string, string> } = {},
): string {
  const query = parts.query && Object.keys(parts.query).length ? `?${new URLSearchParams(parts.query)}` : '';
  const fragment =
    parts.fragment && Object.keys(parts.fragment).length ? `#${new URLSearchParams(parts.fragment)}` : '';
  return `${base.replace(/\/+$/, '')}${route}${query}${fragment}`;
}

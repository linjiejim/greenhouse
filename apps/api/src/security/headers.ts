import type { MiddlewareHandler } from 'hono';

/** Conservative headers for API responses; the web app's own CSP is set where it is served. */
export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  c.header('X-Frame-Options', 'DENY');
  // API answers are not cached, unless the route chose otherwise (signed file content).
  if (c.req.path.startsWith('/api/') && !c.res.headers.has('Cache-Control')) c.header('Cache-Control', 'no-store');
};

/** Only configured origins may call the API from a browser. */
export function cors(allowedOrigins: string[]): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    const origin = c.req.header('origin');
    const permitted = origin !== undefined && allowed.has(origin);
    if (c.req.method === 'OPTIONS' && permitted) {
      return c.body(null, 204, {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers':
          'Authorization, Content-Type, Idempotency-Key, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
        'Access-Control-Max-Age': '600',
        Vary: 'Origin',
      });
    }
    await next();
    if (permitted) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Vary', 'Origin');
    }
  };
}

const PROTOCOL_EXPOSED = 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version';

/**
 * The OAuth and MCP protocol endpoints (`/.well-known/*`, `/oauth/register|token|revoke`,
 * `/api/mcp`) answer any origin, because browser-based MCP clients (MCP Inspector) call them
 * directly. Safe: none of them reads a cookie; every credential travels in a header or the body.
 * A preflight from a configured origin is answered by `cors` above, before this runs.
 */
export const openCors: MiddlewareHandler = async (c, next) => {
  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID',
      'Access-Control-Expose-Headers': PROTOCOL_EXPOSED,
      'Access-Control-Max-Age': '600',
    });
  }
  await next();
  c.header('Access-Control-Allow-Origin', '*');
  c.header('Access-Control-Expose-Headers', PROTOCOL_EXPOSED);
};

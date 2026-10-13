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
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key',
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

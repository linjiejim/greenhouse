import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { securityHeadersMiddleware } from './security.js';

/**
 * The CSP only applies in deployed environments (the API serves the built SPA);
 * under `pnpm dev` the document comes from Vite with no CSP, so a directive that
 * blocks a real download is invisible locally. These assertions are the guard.
 */
async function csp(): Promise<string> {
  const app = new Hono().use('*', securityHeadersMiddleware).get('/', (c) => c.text('ok'));
  const response = await app.request('/');
  return response.headers.get('Content-Security-Policy') ?? '';
}

describe('Content-Security-Policy', () => {
  it('lets the page fetch presigned COS objects', async () => {
    // Chat file + Drive downloads 302 from /api/**/content to the COS host; the
    // redirect target is matched against connect-src, not the 'self' origin.
    expect(await csp()).toContain("connect-src 'self' https://unpkg.com https://*.myqcloud.com");
  });

  it('keeps active content same-origin', async () => {
    const policy = await csp();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toMatch(/script-src[^;]*myqcloud/);
  });
});

describe('a route with policies of its own', () => {
  it('keeps the route’s CSP and adds the global one beside it (both are enforced), and its referrer policy', async () => {
    const app = new Hono().use('*', securityHeadersMiddleware).get('/preview', (c) => {
      c.header('Content-Security-Policy', 'sandbox allow-scripts');
      c.header('Referrer-Policy', 'no-referrer');
      return c.text('a page that must never run as Greenhouse');
    });
    const response = await app.request('/preview');
    const policies = response.headers.get('Content-Security-Policy') ?? '';
    expect(policies.startsWith('sandbox allow-scripts')).toBe(true);
    expect(policies).toContain("default-src 'self'");
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('a route without its own policies gets exactly the global ones', async () => {
    const app = new Hono().use('*', securityHeadersMiddleware).get('/', (c) => c.text('ok'));
    const response = await app.request('/');
    expect(response.headers.get('Content-Security-Policy')).not.toContain('sandbox');
    expect(response.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
  });
});

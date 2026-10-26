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

it('allows same-origin and desktop frames only for host-mounted plugin UI with a strict CSP', async () => {
  const app = new Hono<{ Variables: { extensionUi: boolean } }>()
    .use('*', securityHeadersMiddleware)
    .get('/plugin', (c) => {
      c.set('extensionUi', true);
      return c.text('plugin');
    })
    .get('/other', (c) => c.text('other'));
  const plugin = await app.request('/plugin');
  expect(plugin.headers.get('X-Frame-Options')).toBeNull();
  expect(plugin.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self' tauri://localhost");
  expect(plugin.headers.get('Content-Security-Policy')).not.toContain('unsafe-eval');
  expect((await app.request('/other')).headers.get('X-Frame-Options')).toBe('DENY');
});

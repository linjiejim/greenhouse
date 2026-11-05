import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PluginUiSources } from '../app-env.js';
import { securityHeadersMiddleware } from './security.js';

const NO_EXTRA_SOURCES: PluginUiSources = { media: [], connect: [] };

/**
 * The CSP only applies in deployed environments (the API serves the built SPA);
 * under `pnpm dev` the document comes from the Expo dev server with no CSP, so a directive that
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
    expect(await csp()).toMatch(/connect-src [^;]*https:\/\/\*\.myqcloud\.com/);
  });

  it('lets uploads read the files the web pickers return', async () => {
    // Drive, chat attachments and skill uploads fetch() the picker's blob:/data: URI for the bytes.
    expect(await csp()).toContain("connect-src 'self' blob: data:");
  });

  it('keeps active content same-origin', async () => {
    const policy = await csp();
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toMatch(/script-src[^;]*myqcloud/);
  });
});

function pluginApp() {
  return new Hono<{ Variables: { extensionUi: PluginUiSources } }>()
    .use('*', securityHeadersMiddleware)
    .get('/plugin', (c) => {
      c.set('extensionUi', NO_EXTRA_SOURCES);
      return c.text('plugin');
    });
}

async function pluginFrameAncestors(): Promise<string> {
  const policy = (await pluginApp().request('/plugin')).headers.get('Content-Security-Policy') ?? '';
  return /frame-ancestors ([^;]*)/.exec(policy)?.[1] ?? '';
}

describe('plugin UI frame-ancestors', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('in production stays the API itself and the desktop shell, whatever CORS allows', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:19041');
    expect(await pluginFrameAncestors()).toBe("'self' tauri://localhost");
  });

  it('outside production also lets the CORS allowed origins frame plugin pages', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('CORS_ALLOWED_ORIGINS', 'http://localhost:19041, https://dev.example.test, bad origin;script-src *');
    const sources = (await pluginFrameAncestors()).split(' ');
    expect(sources.slice(0, 2)).toEqual(["'self'", 'tauri://localhost']);
    expect(sources).toContain('http://localhost:19041');
    expect(sources).toContain('https://dev.example.test');
    // The Expo web dev server's default port is a built-in CORS origin.
    expect(sources).toContain('http://localhost:3100');
    expect(sources.join(' ')).not.toContain('script-src');
    expect(sources.filter((source) => source === 'tauri://localhost')).toHaveLength(1);
  });
});

it('allows same-origin and desktop frames only for host-mounted plugin UI with a strict CSP', async () => {
  const app = new Hono<{ Variables: { extensionUi: PluginUiSources } }>()
    .use('*', securityHeadersMiddleware)
    .get('/plugin', (c) => {
      c.set('extensionUi', NO_EXTRA_SOURCES);
      return c.text('plugin');
    })
    .get('/other', (c) => c.text('other'));
  const plugin = await app.request('/plugin');
  expect(plugin.headers.get('X-Frame-Options')).toBeNull();
  expect(plugin.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'self' tauri://localhost");
  expect(plugin.headers.get('Content-Security-Policy')).not.toContain('unsafe-eval');
  expect((await app.request('/other')).headers.get('X-Frame-Options')).toBe('DENY');
});

describe('plugin UI media sources', () => {
  async function policyFor(sources: PluginUiSources): Promise<string> {
    const app = new Hono<{ Variables: { extensionUi: PluginUiSources } }>()
      .use('*', securityHeadersMiddleware)
      .get('/plugin', (c) => {
        c.set('extensionUi', sources);
        return c.text('plugin');
      });
    return (await app.request('/plugin')).headers.get('Content-Security-Policy') ?? '';
  }

  it('lets plugin frames show local previews and keeps everything else same-origin', async () => {
    const policy = await policyFor(NO_EXTRA_SOURCES);
    expect(policy).toContain("img-src 'self' data: blob:;");
    expect(policy).toContain("media-src 'self' blob:;");
    expect(policy).toContain("connect-src 'self';");
    expect(policy).toContain("script-src 'self';");
  });

  it('adds the object store origin and declared media origins, never to scripts', async () => {
    const policy = await policyFor({
      media: ['https://bucket.cos.ap-guangzhou.myqcloud.com', 'https://*.cdn.example.com'],
      connect: ['https://bucket.cos.ap-guangzhou.myqcloud.com'],
    });
    expect(policy).toMatch(
      /img-src [^;]*https:\/\/bucket\.cos\.ap-guangzhou\.myqcloud\.com [^;]*https:\/\/\*\.cdn\.example\.com/,
    );
    expect(policy).toMatch(/media-src [^;]*https:\/\/\*\.cdn\.example\.com/);
    expect(policy).toMatch(/connect-src 'self' https:\/\/bucket\.cos\.ap-guangzhou\.myqcloud\.com;/);
    expect(policy).not.toMatch(/connect-src[^;]*cdn\.example/);
    expect(policy).not.toMatch(/script-src[^;]*https/);
  });

  it('drops a source that would break out of its directive', async () => {
    const policy = await policyFor({ media: ['https://ok.example.com; script-src *'], connect: [] });
    expect(policy).not.toContain('script-src *');
  });
});

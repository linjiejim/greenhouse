/**
 * The options page's "is there a Greenhouse server at this address?" probe
 * (`checkServer` in apps/browser/src/lib/auth.ts), run before a station is saved.
 *
 * The probe must ask a route the server answers WITHOUT a token. It once asked
 * GET /api/auth/status after the server had dropped that route: the auth guard
 * answered 401, and every new station was reported unreachable. The contract
 * half holds the probe to the server's own public-path list and its real
 * /api/bootstrap handler; the rest pins what counts as reachable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceBranding } from '@greenhouse/types/workspace-settings';
import { isPublicPath } from '../../apps/api/src/auth/middleware';
import bootstrapRoutes from '../../apps/api/src/routes/bootstrap';
import { checkServer, SERVER_PROBE_TIMEOUT_MS } from '../../apps/browser/src/lib/auth';

// The real bootstrap handler, minus its two database reads.
const branding = vi.hoisted((): { current: WorkspaceBranding } => ({
  current: { product_name: null, logo: null, theme_tokens: null },
}));

vi.mock('../../apps/api/src/settings/workspace-config', () => ({
  getWorkspaceBranding: async () => branding.current,
}));

vi.mock('../../apps/api/src/security/first-admin', () => ({
  isFirstRunSetupPending: async () => false,
}));

const BASE = 'https://gh.example.com';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  branding.current = { product_name: null, logo: null, theme_tokens: null };
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** What fetch hands back for a body that stops arriving: a stream that only ends when the request is cancelled. */
function stalledBody(signal: AbortSignal): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"product_name":'));
      signal.addEventListener('abort', () => controller.error(signal.reason));
    },
  });
}

/** A request that never answers; like fetch, it rejects once its signal aborts. */
function neverAnswers(_url: string, init: RequestInit): Promise<Response> {
  const signal = init.signal!;
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
}

/**
 * A signed-out request to a Greenhouse server, built from the real pieces it
 * meets: the auth guard's public-path list (anything else is a 401 without a
 * token) and the bootstrap handler, mounted at /api/bootstrap in apps/api/src/index.ts.
 */
async function greenhouseServer(url: string): Promise<Response> {
  const { pathname } = new URL(url);
  if (!isPublicPath(pathname)) return Response.json({ error: 'Unauthorized' }, { status: 401 });
  if (pathname === '/api/bootstrap') return bootstrapRoutes.request('/');
  return new Response('Not found', { status: 404 });
}

describe('server contract', () => {
  it.each([
    ['an unbranded workspace', null],
    ['a branded workspace', 'Acme Brain'],
  ])('recognizes a Greenhouse server before sign-in (%s)', async (_name, productName) => {
    branding.current = { product_name: productName, logo: null, theme_tokens: null };
    fetchMock.mockImplementation(greenhouseServer);

    expect(await checkServer(BASE)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new URL(fetchMock.mock.calls[0][0] as string).origin).toBe(BASE);
  });
});

describe('unreachable', () => {
  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await checkServer(BASE)).toBe(false);
  });

  it.each([401, 404, 500, 502])('reports HTTP %i, whatever the body, without trying another route', async (status) => {
    fetchMock.mockResolvedValue(new Response('{"product_name":null}', { status }));
    expect(await checkServer(BASE)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after SERVER_PROBE_TIMEOUT_MS when the server never answers', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(neverAnswers);
    let settled = false;
    const probe = checkServer(BASE).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(SERVER_PROBE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await probe).toBe(false);
  });

  it('gives up when the body stops arriving, within the same budget', async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementation(async (_url: string, init: RequestInit) => new Response(stalledBody(init.signal!)));
    const probe = checkServer(BASE);

    await vi.advanceTimersByTimeAsync(SERVER_PROBE_TIMEOUT_MS);
    expect(await probe).toBe(false);
  });
});

describe('not a Greenhouse server', () => {
  it.each([
    ['an HTML page', '<!doctype html><title>Welcome to nginx!</title>', 'text/html'],
    ['JSON from some other API', '{"status":"ok"}', 'application/json'],
    ['a JSON array', '[]', 'application/json'],
    ['JSON null', 'null', 'application/json'],
    ['an empty body', '', 'text/plain'],
  ])('rejects %s', async (_name, body, contentType) => {
    fetchMock.mockResolvedValue(new Response(body, { headers: { 'Content-Type': contentType } }));
    expect(await checkServer(BASE)).toBe(false);
  });
});

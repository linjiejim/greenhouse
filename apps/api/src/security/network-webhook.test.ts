/**
 * `postPublicWebhook` — the egress guard of Tables automation webhooks: refused
 * targets never produce a request, redirects are re-validated, only 307 / 308
 * keep a POST, and the result says whether a retry can help.
 */

import { describe, expect, it, vi } from 'vitest';

// Same seams as network.test.ts: undici's own fetch is mocked per test (Agent
// stays real), and one DNS name answers with loopback (rebinding).
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = ((hostname: string, options: unknown, callback: unknown) => {
    if (hostname === 'rebind.greenhouse.test') {
      (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        { address: '10.0.0.7', family: 4 },
      ]);
      return;
    }
    return (actual.lookup as (...args: unknown[]) => unknown)(hostname, options, callback);
  }) as typeof actual.lookup;
  return { ...actual, lookup };
});

import { fetch as undiciFetch } from 'undici';
import { assertSafeWebhookUrl, postPublicWebhook } from './network.js';

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;
const asUndici = (response: Response) => response as unknown as UndiciResponse;

describe('webhook target policy', () => {
  it.each([
    'ftp://example.com/hook',
    'file:///etc/passwd',
    'http://localhost:3000/api',
    'https://api.localhost/hook',
    'http://127.0.0.1/hook',
    'http://[::1]:8080/hook',
    'http://10.1.2.3/hook',
    'http://169.254.169.254/latest/meta-data',
    'http://192.168.0.10/hook',
    'https://user:pass@hooks.example.com/hook',
    'not a url',
  ])('refuses %s without sending anything', async (url) => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    expect(() => assertSafeWebhookUrl(url)).toThrow();
    const result = await postPublicWebhook(url, '{}');
    expect(result).toMatchObject({ ok: false, status: null, retryable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts public http(s) targets on any port', () => {
    expect(assertSafeWebhookUrl('https://hooks.example.com:8443/in?x=1').hostname).toBe('hooks.example.com');
  });

  it('posts JSON with the caller headers, manual redirects and the guarded dispatcher', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(asUndici(new Response('accepted', { status: 202 })));
    const result = await postPublicWebhook('https://1.1.1.1/in', '{"a":1}', {
      headers: { 'x-greenhouse-signature': 'sha256=x' },
    });
    expect(result).toEqual({ ok: true, status: 202, retryable: false, responseSnippet: 'accepted' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://1.1.1.1/in',
      expect.objectContaining({
        method: 'POST',
        body: '{"a":1}',
        redirect: 'manual',
        dispatcher: expect.anything(),
        headers: expect.objectContaining({ 'content-type': 'application/json', 'x-greenhouse-signature': 'sha256=x' }),
      }),
    );
  });

  it('refuses a redirect into a private network without following it', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      asUndici(new Response(null, { status: 307, headers: { location: 'http://127.0.0.1:3000/api/admin' } })),
    );
    const result = await postPublicWebhook('https://1.1.1.1/in', '{}');
    expect(result).toMatchObject({ ok: false, retryable: false, error: expect.stringMatching(/not public/) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('follows a public 308 with the same POST, and does not turn a 302 into a GET', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(asUndici(new Response(null, { status: 308, headers: { location: '/v2/in' } })))
      .mockResolvedValueOnce(asUndici(new Response(null, { status: 204 })));
    expect(await postPublicWebhook('https://1.1.1.1/in', '{"b":2}')).toMatchObject({ ok: true, status: 204 });
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://1.1.1.1/v2/in',
      expect.objectContaining({ method: 'POST', body: '{"b":2}' }),
    );

    fetchMock.mockResolvedValueOnce(asUndici(new Response(null, { status: 302, headers: { location: '/elsewhere' } })));
    expect(await postPublicWebhook('https://1.1.1.1/in', '{}')).toMatchObject({
      ok: false,
      status: 302,
      retryable: false,
    });
  });

  it('marks 5xx and 429 retryable, 4xx not', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockResolvedValueOnce(asUndici(new Response('down', { status: 503 })));
    expect(await postPublicWebhook('https://1.1.1.1/in', '{}')).toMatchObject({
      ok: false,
      status: 503,
      retryable: true,
    });
    fetchMock.mockResolvedValueOnce(asUndici(new Response('slow down', { status: 429 })));
    expect(await postPublicWebhook('https://1.1.1.1/in', '{}')).toMatchObject({ retryable: true });
    fetchMock.mockResolvedValueOnce(asUndici(new Response('nope', { status: 404 })));
    expect(await postPublicWebhook('https://1.1.1.1/in', '{}')).toMatchObject({
      ok: false,
      status: 404,
      retryable: false,
    });
  });

  it('refuses a hostname that resolves to a private address at connect time, as not retryable', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    const actual = (await vi.importActual<typeof import('undici')>('undici')).fetch;
    fetchMock.mockImplementationOnce(actual as never);
    const result = await postPublicWebhook('http://rebind.greenhouse.test/hook', '{}', { timeoutMs: 5_000 });
    expect(result).toMatchObject({ ok: false, status: null, retryable: false, error: 'Webhook host is not public' });
  });
});

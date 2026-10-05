import { describe, expect, it, vi } from 'vitest';

// The downloader calls undici's own `fetch` (not the global one) so its dispatcher is
// always version-matched. Mock that binding — `Agent` must stay real because the
// module constructs one at import time.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

// DNS answers for the rebinding case: `rebind.greenhouse.test` resolves to
// loopback, everything else goes to the real resolver.
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  const lookup = ((hostname: string, options: unknown, callback: unknown) => {
    if (hostname === 'rebind.greenhouse.test') {
      (callback as (e: null, a: Array<{ address: string; family: number }>) => void)(null, [
        { address: '127.0.0.1', family: 4 },
      ]);
      return;
    }
    return (actual.lookup as (...args: unknown[]) => unknown)(hostname, options, callback);
  }) as typeof actual.lookup;
  return { ...actual, lookup };
});

import { fetch as undiciFetch } from 'undici';
import {
  assertSafePublicImageUrl,
  assertSafePublicPageUrl,
  fetchPublicImage,
  fetchPublicPage,
  isPublicNetworkAddress,
} from './network.js';

type UndiciResponse = Awaited<ReturnType<typeof undiciFetch>>;
const asUndici = (response: Response) => response as unknown as UndiciResponse;

describe('public image network policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.169.254',
    '172.16.0.1',
    '192.168.1.1',
    '224.0.0.1',
    '::1',
    '::7f00:1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '3fff::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPublicNetworkAddress(address)).toBe(true);
  });

  it.each([
    'http://example.com/image.png',
    'https://localhost/image.png',
    'https://127.0.0.1/image.png',
    'https://[::127.0.0.1]/image.png',
    'https://169.254.169.254/latest/meta-data',
    'https://user:pass@example.com/image.png',
    'https://example.com:8443/image.png',
  ])('rejects unsafe URL %s', (url) => {
    expect(() => assertSafePublicImageUrl(url)).toThrow();
  });

  it('accepts a credential-free public HTTPS URL', () => {
    expect(assertSafePublicImageUrl('https://cdn.example.com/image.png?sig=abc').hostname).toBe('cdn.example.com');
  });

  it('requests identity encoding and rejects compressed responses before reading the body', async () => {
    const body = new Uint8Array([0x1f, 0x8b, 0x08]);
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockResolvedValueOnce(
      new Response(body, {
        status: 200,
        headers: { 'content-type': 'image/png', 'content-encoding': 'gzip' },
      }) as unknown as Awaited<ReturnType<typeof undiciFetch>>,
    );

    await expect(fetchPublicImage('https://1.1.1.1/image.png')).rejects.toThrow(/Compressed remote image/);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://1.1.1.1/image.png',
      expect.objectContaining({
        headers: expect.objectContaining({ 'accept-encoding': 'identity' }),
      }),
    );
  });

  // Regression: the downloader used to hand its undici Agent to Node's *global* fetch.
  // Node embeds its own pinned undici and validates dispatchers against that build's
  // handler interface, so every download died before reaching the network with
  // `UND_ERR_INVALID_ARG: invalid onRequestStart method` — reported only as the opaque
  // `TypeError: fetch failed`. That broke all image generation, since the upstream
  // image APIs return a URL to download rather than inline base64.
  //
  // A reserved `.invalid` host can never resolve, so a correctly wired stack fails at
  // DNS — i.e. *after* dispatcher validation. Any UND_ERR_INVALID_ARG in the cause
  // chain means fetch and dispatcher came from mismatched undici builds again.
  //
  // Timeout: this is the only case in the file that performs real I/O — every
  // other one is pure logic that finishes in single-digit milliseconds and
  // keeps the tight 5s default. Reaching DNS is the whole point (it proves the
  // dispatcher was accepted), so the case inherits the system resolver's
  // latency, which is not CPU-bound and queues badly when the machine is
  // saturated. It normally returns in ~250ms; the explicit bound only exists so
  // a loaded machine cannot turn a passing assertion into a false red, while
  // still failing a genuinely hung resolver rather than hanging forever.
  it('pairs its dispatcher with a version-matched fetch implementation', async () => {
    const error = await fetchPublicImage('https://greenhouse-does-not-exist.invalid/image.png').catch(
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    const codes: unknown[] = [];
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
      codes.push((cause as { code?: unknown }).code);
    }
    expect(codes).not.toContain('UND_ERR_INVALID_ARG');
  }, 15_000);
});

describe('public page fetch (search-result extraction)', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/x',
    'http://localhost:3000/',
    'http://api.localhost/',
    'http://127.0.0.1:3111/',
    'http://[::1]/',
    'http://10.0.0.5/admin',
    'http://169.254.169.254/latest/meta-data',
    'http://user:pass@example.com/',
  ])('rejects unsafe page URL %s', (url) => {
    expect(() => assertSafePublicPageUrl(url)).toThrow();
  });

  it.each(['http://example.com/a', 'https://example.com:8443/b?q=1'])('accepts public page URL %s', (url) => {
    expect(assertSafePublicPageUrl(url).toString()).toBe(url);
  });

  it('refuses a public page that redirects to a loopback address, without requesting it', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      asUndici(new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:3111/api/admin' } })),
    );

    await expect(fetchPublicPage('https://1.1.1.1/start')).rejects.toThrow(/not public/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://1.1.1.1/start',
      expect.objectContaining({ redirect: 'manual', dispatcher: expect.anything() }),
    );
  });

  it('follows a public redirect and returns the page text', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockClear();
    fetchMock
      .mockResolvedValueOnce(asUndici(new Response(null, { status: 301, headers: { location: '/docs' } })))
      .mockResolvedValueOnce(
        asUndici(new Response('<title>Docs</title><p>hello</p>', { headers: { 'content-type': 'text/html' } })),
      );

    const page = await fetchPublicPage('https://1.1.1.1/');
    expect(page).toMatchObject({ text: '<title>Docs</title><p>hello</p>', finalUrl: 'https://1.1.1.1/docs' });
    expect(page.truncated).toBe(false);
  });

  it('stops reading at the decoded-size cap', async () => {
    const fetchMock = vi.mocked(undiciFetch);
    fetchMock.mockResolvedValueOnce(asUndici(new Response('x'.repeat(5000))));

    const page = await fetchPublicPage('https://1.1.1.1/big', { maxBytes: 1024 });
    expect(page.text).toHaveLength(1024);
    expect(page.truncated).toBe(true);
  });

  // The connect-time guard, end to end through undici: a hostname whose DNS
  // answer is loopback (rebinding) is refused when the socket would open, so a
  // name that passed the URL check can still never reach the API host.
  it('refuses a hostname that resolves to a private address at connect time', async () => {
    const error = await fetchPublicPage('http://rebind.greenhouse.test/').catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    const messages: string[] = [];
    for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) messages.push(cause.message);
    expect(messages.join(' | ')).toMatch(/non-public address/);
  });
});

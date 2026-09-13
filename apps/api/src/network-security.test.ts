import { describe, expect, it, vi } from 'vitest';

// The downloader calls undici's own `fetch` (not the global one) so its dispatcher is
// always version-matched. Mock that binding — `Agent` must stay real because the
// module constructs one at import time.
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(actual.fetch) };
});

import { fetch as undiciFetch } from 'undici';
import { assertSafePublicImageUrl, fetchPublicImage, isPublicNetworkAddress } from './network-security.js';

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

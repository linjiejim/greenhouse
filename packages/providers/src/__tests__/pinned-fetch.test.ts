import { describe, expect, it, vi } from 'vitest';
import { EndpointViolation, pinnedFetch } from '../pinned-fetch.js';

describe('pinnedFetch', () => {
  it('sends requests only to the configured origin', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const guarded = pinnedFetch(['https://api.deepseek.com/v1'], inner as unknown as typeof fetch);
    await guarded('https://api.deepseek.com/chat/completions', { headers: { authorization: 'Bearer k' } });
    expect(inner).toHaveBeenCalledOnce();
    await expect(guarded('https://evil.example.com/steal')).rejects.toBeInstanceOf(EndpointViolation);
    expect(inner).toHaveBeenCalledOnce();
  });

  it('never follows a redirect to another origin with the credential', async () => {
    const inner = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('/start')
        ? new Response(null, { status: 302, headers: { location: 'https://other.example.com/x' } })
        : new Response('done'),
    );
    const guarded = pinnedFetch(['https://api.example.com'], inner as unknown as typeof fetch);
    await expect(guarded('https://api.example.com/start')).rejects.toThrow('other.example.com');
  });

  it('follows a same-origin redirect', async () => {
    const inner = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/a')
        ? new Response(null, { status: 307, headers: { location: '/b' } })
        : new Response('b'),
    );
    const guarded = pinnedFetch(['https://api.example.com'], inner as unknown as typeof fetch);
    expect(await (await guarded('https://api.example.com/a')).text()).toBe('b');
  });

  it('stops a same-origin redirect loop', async () => {
    const inner = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
    const guarded = pinnedFetch(['https://api.example.com'], inner as unknown as typeof fetch);
    await expect(guarded('https://api.example.com/start')).rejects.toThrow('Too many redirects');
    expect(inner).toHaveBeenCalledTimes(6);
  });

  it('continues a 303 as a GET without the body', async () => {
    const inner = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).endsWith('/a')
        ? new Response(null, { status: 303, headers: { location: '/b' } })
        : new Response('b'),
    );
    const guarded = pinnedFetch(['https://api.example.com'], inner as unknown as typeof fetch);
    await guarded('https://api.example.com/a', { method: 'POST', body: 'x' });
    expect(inner.mock.calls[1]![1]).toMatchObject({ method: 'GET', body: undefined });
  });

  it('allows no network at all for adapters without endpoints', async () => {
    await expect(pinnedFetch(null)('https://example.com')).rejects.toBeInstanceOf(EndpointViolation);
  });
});

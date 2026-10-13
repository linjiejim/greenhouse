import { describe, expect, it, vi } from 'vitest';
import { EndpointViolation, assertPinned, isPinned, pinnedFetch } from '../pinned-fetch.js';

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

  it('lets a `*.` entry reach every name under its domain, and nothing that only looks like one', async () => {
    const inner = vi.fn(async () => new Response('ok'));
    const guarded = pinnedFetch(['https://api.e2b.app', 'https://*.e2b.app'], inner as unknown as typeof fetch);
    await guarded('https://49983-abc123.e2b.app/process.Process/Start');
    await guarded('https://7681-abc123.eu.e2b.app/');
    expect(inner).toHaveBeenCalledTimes(2);
    for (const url of [
      'https://e2b.app/',
      'https://evil-e2b.app/',
      'https://49983-abc.e2b.app.evil.com/',
      'http://49983-abc.e2b.app/',
      'https://49983-abc.e2b.app:8443/',
    ]) {
      await expect(guarded(url)).rejects.toBeInstanceOf(EndpointViolation);
    }
    expect(inner).toHaveBeenCalledTimes(2);
    expect(isPinned(['https://*.e2b.app'], 'https://7682-x.e2b.app/exec')).toBe(true);
    expect(() => assertPinned(['https://*.e2b.app'], 'https://7682-x.evil.example/exec')).toThrow(
      'may only call https://*.e2b.app',
    );
  });
});

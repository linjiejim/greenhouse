import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLIENT_API_LEVEL as MOBILE_API } from '../shared/plugins';

vi.mock('zustand', () => ({ create: () => ({}) }));
vi.mock('../config', () => ({ DEFAULT_API_BASE: '', IS_SINGLE_STATION: false, STATIONS: { defaults: [] } }));
vi.mock('../api/token-storage', () => ({}));
vi.mock('../data/disk-cache', () => ({ forgetMember: () => {} }));
const { probeStation } = await import('./stations');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (body: unknown) => new Response(JSON.stringify(body));

describe('station preflight', () => {
  it('recognizes a server that speaks this API by its bootstrap, and names it', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ product_name: 'My station', logo: null, theme_tokens: null, mobile_api: MOBILE_API }));
    vi.stubGlobal('fetch', fetch);
    expect(await probeStation('https://station.example')).toEqual({ ok: true, productName: 'My station' });
    expect(fetch.mock.calls[0][0]).toBe('https://station.example/api/bootstrap');
    fetch.mockResolvedValueOnce(json({ product_name: '  ', logo: null, theme_tokens: null, mobile_api: MOBILE_API }));
    expect(await probeStation('https://station.example')).toEqual({ ok: true, productName: undefined });
  });

  it('says why a Greenhouse on another API cannot be used, and refuses anything else', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ product_name: 'Old station', logo: null, mobile_api: 3 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(json({ hello: 'world' }));
    vi.stubGlobal('fetch', fetch);
    expect(await probeStation('https://v3.example')).toEqual({ ok: false, mismatch: 'server_outdated' });
    expect(await probeStation('https://nothing.example')).toEqual({ ok: false });
    expect(await probeStation('https://other.example')).toEqual({ ok: false });
  });

  it('uses one 10-second budget for the request and its body', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn().mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetch);
    const probe = probeStation('https://slow.example');
    await vi.advanceTimersByTimeAsync(10000);
    expect(await probe).toEqual({ ok: false });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it('settles even if native fetch ignores cancellation', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal('fetch', fetch);
    const probe = probeStation('https://offline.example');
    await vi.advanceTimersByTimeAsync(10000);
    expect(await probe).toEqual({ ok: false });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

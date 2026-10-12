import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('zustand', () => ({ create: () => ({}) }));
vi.mock('../config', () => ({ DEFAULT_API_BASE: '', IS_SINGLE_STATION: false, STATIONS: { defaults: [] } }));
vi.mock('../api/token-storage', () => ({}));
const { probeStation } = await import('./stations');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('station preflight', () => {
  it('recognizes current servers and retains legacy compatibility', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response('{"product_name":"My station"}'));
    vi.stubGlobal('fetch', fetch);
    expect(await probeStation('https://station.example')).toEqual({
      ok: true,
      authEnabled: true,
      productName: 'My station',
    });
    fetch
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response('{"authEnabled":false}'));
    expect(await probeStation('https://old.example')).toEqual({ ok: true, authEnabled: false });
  });

  it('uses one 10-second budget across bootstrap and legacy probes, including body reads', async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 6000));
        return new Response(null, { status: 404 });
      })
      .mockResolvedValueOnce({ ok: true, json: () => new Promise(() => {}) });
    vi.stubGlobal('fetch', fetch);
    const probe = probeStation('https://slow.example');
    await vi.advanceTimersByTimeAsync(10000);
    expect(await probe).toEqual({ ok: false });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][1].signal.aborted).toBe(true);
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

import { afterEach, expect, it, vi } from 'vitest';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});
function install(call = vi.fn().mockResolvedValue(null)) {
  const storage = new Map<string, string>();
  vi.stubGlobal('window', { __TAURI__: { core: { invoke: call } }, dispatchEvent: vi.fn() });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  });
  return { storage, call };
}
it('stores tokens exclusively in the native Keychain plugin; preferences stay non-secret', async () => {
  const { call, storage } = install();
  const { persistSet, persistGet, flushCredentials } = await import('../api/persistence.desktop');
  persistSet('greenhouse_access_token__station', 'test-token');
  persistSet('greenhouse_pref_stations', '[{"id":"station"}]');
  await flushCredentials();
  expect(call).toHaveBeenCalledWith('plugin:credentials|write', {
    key: 'greenhouse_access_token__station',
    value: 'test-token',
  });
  expect([...storage.values()].join('')).not.toContain('test-token');
  expect(await persistGet('greenhouse_pref_stations')).toBe('[{"id":"station"}]');
});
it('does not hide a Keychain read failure or fall back to browser token storage', async () => {
  const { storage } = install(vi.fn().mockRejectedValue(new Error('Keychain access refused')));
  const { persistGet } = await import('../api/persistence.desktop');
  await expect(persistGet('greenhouse_refresh_token__station')).rejects.toThrow('Keychain access refused');
  expect(storage.size).toBe(0);
});
it('serializes a save then sign-out for the same key', async () => {
  let release!: () => void;
  const call = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    )
    .mockResolvedValue(null);
  install(call);
  const { persistSet, flushCredentials } = await import('../api/persistence.desktop');
  persistSet('greenhouse_access_token__station', 'test-token');
  persistSet('greenhouse_access_token__station', null);
  await Promise.resolve();
  await Promise.resolve();
  expect(call).toHaveBeenCalledTimes(1);
  release();
  await flushCredentials();
  expect(call.mock.calls.map(([, args]) => args.value)).toEqual(['test-token', null]);
});

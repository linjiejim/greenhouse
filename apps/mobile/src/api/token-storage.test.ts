/**
 * The token mirror (./token-storage.ts) across station switches: it must never hand out one
 * station's token while it is labelled (and so paired, by every read site, with the address of)
 * another. Runs in the ROOT vitest unit project: `react-native` and `expo-secure-store` are
 * mocked (virtual — the app's own install is absent in CI), and the secure store's reads are
 * held open per key so the test decides when each station's pair "comes back from the Keychain".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = new Map<string, string>();
/** Answers parked until `release()` — the Keychain's async gap. */
let parked: Array<() => void> = [];
let parkReads = false;
const deleted: string[] = [];

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-secure-store', () => ({
  // The value is read when asked and handed back later: a parked read is a stale read.
  getItemAsync: (key: string) =>
    new Promise<string | null>((resolve) => {
      const value = store.get(key) ?? null;
      if (parkReads) parked.push(() => resolve(value));
      else resolve(value);
    }),
  setItemAsync: async (key: string, value: string) => {
    store.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    deleted.push(key);
    store.delete(key);
  },
}));

type Mirror = typeof import('./token-storage');

/** A fresh module (the mirror is module state) per test. */
async function load(): Promise<Mirror> {
  vi.resetModules();
  return import('./token-storage');
}

function seed(sid: string, access: string, refresh: string): void {
  store.set(`greenhouse_access_token__${sid}`, access);
  store.set(`greenhouse_refresh_token__${sid}`, refresh);
}

/** Let parked reads answer, then let the awaiting hydrate continue. */
async function release(): Promise<void> {
  const answers = parked;
  parked = [];
  for (const answer of answers) answer();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  store.clear();
  parked = [];
  parkReads = false;
  deleted.length = 0;
  seed('A', 'access-A', 'refresh-A');
  seed('B', 'access-B', 'refresh-B');
});

describe('token mirror across a station switch', () => {
  it('detachTokens empties and relabels the mirror in the same step', async () => {
    const m = await load();
    await m.hydrateTokens('A');
    expect(m.getAccessToken()).toBe('access-A');

    m.detachTokens('B');
    expect(m.getTokenStationId()).toBe('B');
    expect(m.getAccessToken()).toBeNull();
    expect(m.getRefreshToken()).toBeNull();
  });

  it("hydrateTokens never shows the new station's label with the old station's token", async () => {
    const m = await load();
    await m.hydrateTokens('A');

    parkReads = true;
    const done = m.hydrateTokens('B');
    // Synchronously, before the Keychain answers: labelled B, holding nothing.
    expect(m.getTokenStationId()).toBe('B');
    expect(m.getAccessToken()).toBeNull();
    expect(m.getRefreshToken()).toBeNull();

    await release();
    await done;
    expect(m.getTokenStationId()).toBe('B');
    expect(m.getAccessToken()).toBe('access-B');
    expect(m.getRefreshToken()).toBe('refresh-B');
  });

  it('detaching to the station the mirror already holds keeps its session', async () => {
    const m = await load();
    await m.hydrateTokens('A');
    m.detachTokens('A');
    expect(m.getAccessToken()).toBe('access-A');
  });

  it('a hydrate overtaken by a newer switch is dropped', async () => {
    const m = await load();
    await m.hydrateTokens('A');

    parkReads = true;
    const toB = m.hydrateTokens('B');
    m.detachTokens('C'); // switched on before B's pair came back
    await release();
    await toB;
    expect(m.getTokenStationId()).toBe('C');
    expect(m.getAccessToken()).toBeNull();
  });

  it('switching to null empties the mirror', async () => {
    const m = await load();
    await m.hydrateTokens('A');
    await m.hydrateTokens(null);
    expect(m.getTokenStationId()).toBeNull();
    expect(m.getAccessToken()).toBeNull();
  });
});

describe('writes during a pending hydrate', () => {
  it('a session written mid-hydrate (sign-in) wins over the stale read', async () => {
    const m = await load();
    parkReads = true;
    const done = m.hydrateTokens('B');
    m.setTokens('fresh-access', 'fresh-refresh');
    await release();
    await done;
    expect(m.getAccessToken()).toBe('fresh-access');
    expect(m.getRefreshToken()).toBe('fresh-refresh');
  });

  it("clearTokens between stations doesn't sign the new station out, and its pair still lands", async () => {
    const m = await load();
    await m.hydrateTokens('A');

    parkReads = true;
    const done = m.hydrateTokens('B');
    // A 401 for a request that could only have carried A's token (or none) arrives now.
    m.clearTokens();
    expect(deleted).toEqual([]);

    await release();
    await done;
    expect(m.getAccessToken()).toBe('access-B');
    expect(store.get('greenhouse_access_token__B')).toBe('access-B');
  });

  it('clearTokens on a loaded station purges its pair and beats a re-read in flight', async () => {
    const m = await load();
    await m.hydrateTokens('A');

    parkReads = true;
    const reread = m.hydrateTokens('A'); // same station: the mirror keeps its pair meanwhile
    expect(m.getAccessToken()).toBe('access-A');
    m.clearTokens();
    expect(m.getAccessToken()).toBeNull();
    expect(deleted).toContain('greenhouse_access_token__A');

    await release();
    await reread;
    expect(m.getAccessToken()).toBeNull();
  });
});

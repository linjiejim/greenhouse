import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '@greenhouse/types/apps';
import type { AppCatalog } from '../lib/api/apps';
import { catalogApps, sidebarApps, useAppsStore } from './apps-store';

const api = vi.hoisted(() => ({
  listApps: vi.fn<() => Promise<AppCatalog>>(),
  getAppPins: vi.fn<() => Promise<number[]>>(),
  setAppPins: vi.fn<(ids: readonly number[]) => Promise<void>>(),
}));
vi.mock('../lib/api/apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/api/apps')>()),
  ...api,
}));

function summary(id: number, patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    baseId: 1,
    name: `App ${id}`,
    description: null,
    icon: 'app',
    accent: 'brand',
    ownerId: 'u1',
    status: 'published',
    publishedVersion: 1,
    featured: false,
    updatedAt: '2026-10-11T00:00:00.000Z',
    canManage: false,
    canPublish: false,
    pinned: false,
    ...patch,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

beforeEach(() => {
  useAppsStore.getState().clear();
  api.getAppPins.mockResolvedValue([]);
  api.setAppPins.mockResolvedValue();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('catalog helpers', () => {
  it('lists every app once across shelves', () => {
    const shared = summary(2);
    const catalog = { managed: [summary(1)], shared: [shared], featured: [shared, summary(3)] };
    expect(catalogApps(catalog).map((app) => app.id)).toEqual([1, 2, 3]);
    expect(catalogApps(null)).toEqual([]);
  });

  it('puts pins first in their order, then featured apps not already pinned, never archived ones', () => {
    const catalog = {
      managed: [summary(1), summary(4, { status: 'archived' })],
      shared: [summary(2), summary(3, { featured: true })],
      featured: [summary(3, { featured: true }), summary(5, { featured: true }), summary(6, { status: 'archived' })],
    };
    const { pinned, featured } = sidebarApps(catalog, [2, 9, 1, 4, 2]);
    // 9 is on no shelf any more (unshared) and 4 is archived: both drop out.
    expect(pinned.map((app) => app.id)).toEqual([2, 1]);
    expect(featured.map((app) => app.id)).toEqual([3, 5]);
    expect(sidebarApps(catalog, [3]).featured.map((app) => app.id)).toEqual([5]);
  });
});

describe('apps store', () => {
  it('shares one request between concurrent loads and keeps the server pin order', async () => {
    const gate = deferred<AppCatalog>();
    api.listApps.mockReturnValue(gate.promise);
    api.getAppPins.mockResolvedValue([2, 1]);
    const first = useAppsStore.getState().load();
    const second = useAppsStore.getState().load();
    expect(useAppsStore.getState().status).toBe('loading');
    gate.resolve({ managed: [summary(1, { pinned: true })], shared: [summary(2, { pinned: true })], featured: [] });
    await Promise.all([first, second]);
    expect(api.listApps).toHaveBeenCalledTimes(1);
    expect(useAppsStore.getState()).toMatchObject({ status: 'ready', pinnedIds: [2, 1], error: null });
    // Loaded: a plain load is a no-op, a forced one asks again.
    await useAppsStore.getState().load();
    expect(api.listApps).toHaveBeenCalledTimes(1);
  });

  it('falls back to the pinned flags when the pin list cannot be read', async () => {
    api.listApps.mockResolvedValue({ managed: [summary(1)], shared: [summary(2, { pinned: true })], featured: [] });
    api.getAppPins.mockRejectedValue(new Error('down'));
    await useAppsStore.getState().load();
    expect(useAppsStore.getState().pinnedIds).toEqual([2]);
  });

  it('reports a failed load and lets the next load retry', async () => {
    api.listApps.mockRejectedValueOnce(new Error('apps are off'));
    await useAppsStore.getState().load();
    expect(useAppsStore.getState()).toMatchObject({ status: 'error', error: 'apps are off', catalog: null });
    api.listApps.mockResolvedValue({ managed: [], shared: [], featured: [] });
    await useAppsStore.getState().load();
    expect(useAppsStore.getState().status).toBe('ready');
  });

  it('drops an answer that arrives for the member who signed out', async () => {
    const gate = deferred<AppCatalog>();
    api.listApps.mockReturnValue(gate.promise);
    const pending = useAppsStore.getState().load();
    useAppsStore.getState().clear();
    gate.resolve({ managed: [summary(1)], shared: [], featured: [] });
    await pending;
    expect(useAppsStore.getState()).toMatchObject({ catalog: null, status: 'idle', pinnedIds: [] });
  });

  it('pins optimistically, appends last, then refetches; a refused pin rolls back', async () => {
    api.listApps.mockResolvedValue({ managed: [summary(1)], shared: [summary(2)], featured: [] });
    api.getAppPins.mockResolvedValue([1]);
    await useAppsStore.getState().load();

    api.getAppPins.mockResolvedValue([1, 2]);
    await useAppsStore.getState().setPinned(2, true);
    expect(api.setAppPins).toHaveBeenLastCalledWith([1, 2]);
    expect(useAppsStore.getState().pinnedIds).toEqual([1, 2]);

    api.setAppPins.mockRejectedValueOnce(new Error('no'));
    await expect(useAppsStore.getState().setPinned(1, false)).rejects.toThrow('no');
    expect(useAppsStore.getState().pinnedIds).toEqual([1, 2]);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_WORKBENCH_PREFERENCES, type PlatformApplication } from '../platform/catalog.js';
import { usePlatformStore } from './platform-store.js';

function application(id: string): PlatformApplication {
  return {
    id,
    version: '1.0.0',
    title: id,
    modules: {},
    actions: {},
    navigation: [],
    capabilities: [],
  };
}

const originalFetch = globalThis.fetch;

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await usePlatformStore.getState().load(false);
  vi.restoreAllMocks();
});

describe('Platform store', () => {
  // Application visibility is filtered by the server on read (see the platform
  // route tests); the store keeps whatever it is given and only normalizes shape.
  it('loads the permission-filtered catalog and normalizes preference shape', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/platform/apps') {
        return Response.json({
          applications: [application('projects'), application('knowledge')],
        });
      }
      return Response.json({
        preferences: {
          ...DEFAULT_WORKBENCH_PREFERENCES,
          appOrder: ['missing', 'knowledge'],
          pinnedAppIds: ['missing', 'projects'],
          hiddenAppIds: ['projects'],
          defaultAppId: 'missing',
          density: 'compact',
        },
      });
    }) as typeof globalThis.fetch;

    await usePlatformStore.getState().load(true);

    expect(usePlatformStore.getState()).toMatchObject({
      enabled: true,
      loading: false,
      error: null,
      applications: [{ id: 'projects' }, { id: 'knowledge' }],
      preferences: {
        version: 2,
        appOrder: ['missing', 'knowledge'],
        // Hidden still wins over pinned — that rule is shape, not permission.
        pinnedAppIds: ['missing'],
        hiddenAppIds: ['projects'],
        defaultAppId: 'missing',
        density: 'compact',
        tabs: [],
        widgets: [],
      },
    });
  });

  it('rolls back an optimistic preference update when persistence fails', async () => {
    usePlatformStore.setState({
      enabled: true,
      applications: [application('projects')],
      preferences: DEFAULT_WORKBENCH_PREFERENCES,
    });
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'storage unavailable' }, { status: 503 }),
    ) as typeof globalThis.fetch;

    await expect(
      usePlatformStore.getState().savePreferences({
        ...DEFAULT_WORKBENCH_PREFERENCES,
        pinnedAppIds: ['projects'],
      }),
    ).rejects.toThrow('storage unavailable');

    expect(usePlatformStore.getState()).toMatchObject({
      saving: false,
      preferences: DEFAULT_WORKBENCH_PREFERENCES,
    });
  });

  it('reloads the server version when another writer wins', async () => {
    const serverPreferences = {
      ...DEFAULT_WORKBENCH_PREFERENCES,
      pinnedAppIds: ['knowledge'],
    };
    usePlatformStore.setState({
      enabled: true,
      applications: [application('projects'), application('knowledge')],
      preferences: DEFAULT_WORKBENCH_PREFERENCES,
    });
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') return Response.json({ error: 'Workbench changed' }, { status: 409 });
      if (url === '/api/platform/apps') {
        return Response.json({ applications: [application('projects'), application('knowledge')] });
      }
      return Response.json({ preferences: serverPreferences });
    }) as typeof globalThis.fetch;

    await expect(
      usePlatformStore.getState().savePreferences({
        ...DEFAULT_WORKBENCH_PREFERENCES,
        pinnedAppIds: ['projects'],
      }),
    ).rejects.toThrow('Workbench changed');

    expect(usePlatformStore.getState()).toMatchObject({
      saving: false,
      preferences: serverPreferences,
    });
  });
});

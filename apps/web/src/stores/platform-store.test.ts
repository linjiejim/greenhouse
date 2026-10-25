import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformApplication } from '../platform/catalog.js';
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
  // route tests); the store keeps whatever it is given.
  it('loads the permission-filtered catalog with one request', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/platform/apps') {
        return Response.json({ applications: [application('projects'), application('knowledge')] });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await usePlatformStore.getState().load(true);

    expect(usePlatformStore.getState()).toMatchObject({
      enabled: true,
      loading: false,
      error: null,
      applications: [{ id: 'projects' }, { id: 'knowledge' }],
    });
    // The retired workbench preferences are no longer requested, so their 404 cannot fail the catalog.
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/platform/apps']);
  });

  it('reports a failed catalog instead of showing an empty one silently', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json({ error: 'unavailable' }, { status: 503 }),
    ) as typeof globalThis.fetch;
    await usePlatformStore.getState().load(true);
    expect(usePlatformStore.getState()).toMatchObject({ applications: [], loading: false });
    expect(usePlatformStore.getState().error).toBeTruthy();
  });
});

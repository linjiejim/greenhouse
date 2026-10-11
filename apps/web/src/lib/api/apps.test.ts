import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '@greenhouse/types/apps';
import { getAppPins, listApps, normalizeAppCatalog, setAppPins } from './apps';
import { TablesRequestError } from './tables';

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

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('normalizeAppCatalog', () => {
  it('takes the three shelves as given', () => {
    const catalog = { managed: [summary(1)], shared: [summary(2)], featured: [summary(2)] };
    expect(normalizeAppCatalog(catalog)).toEqual(catalog);
  });

  it('splits one flat list by the caller relation each summary carries', () => {
    const managedDraft = summary(1, { canManage: true, status: 'draft', publishedVersion: null });
    const shared = summary(2);
    const featured = summary(3, { featured: true });
    const archivedShared = summary(4, { status: 'archived' });
    expect(normalizeAppCatalog({ apps: [managedDraft, shared, featured, archivedShared] })).toEqual({
      managed: [managedDraft],
      shared: [shared, featured],
      featured: [featured],
    });
  });

  it('is an empty catalog for anything else, never a throw', () => {
    for (const body of [null, 'x', 42, {}, { managed: 'nope' }]) {
      expect(normalizeAppCatalog(body)).toEqual({ managed: [], shared: [], featured: [] });
    }
  });
});

describe('apps client', () => {
  it('reads the shelves and the ordered pins, and writes pins as one ordered list', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/apps') return Response.json({ managed: [], shared: [summary(5)], featured: [] });
      if (url === '/api/apps/pins' && (!init?.method || init.method === 'GET')) {
        return Response.json({ apps: [summary(5), { id: 'x' }, summary(2)] });
      }
      return Response.json({ apps: [summary(2), summary(5)] });
    });
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    expect((await listApps()).shared.map((app) => app.id)).toEqual([5]);
    expect(await getAppPins()).toEqual([5, 2]);
    await setAppPins([2, 5]);
    const put = fetchMock.mock.calls.at(-1)!;
    expect(String(put[0])).toBe('/api/apps/pins');
    expect(put[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ appIds: [2, 5] }) });
  });

  it('throws the Tables request error with the status and the server message', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'apps are off' }, { status: 403 })) as typeof fetch;
    const error = await listApps().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TablesRequestError);
    expect(error).toMatchObject({ status: 403, message: 'apps are off' });
  });
});

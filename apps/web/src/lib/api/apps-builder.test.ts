import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSpec, AppUsageView } from '@greenhouse/types/apps';
import {
  isOwnerOnly,
  isRevisionConflict,
  publishApp,
  readAppUsage,
  restoreAppVersion,
  saveAppDraft,
  specErrorsOf,
} from './apps-builder';
import { TablesRequestError } from './tables';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const spec: AppSpec = {
  version: 1,
  pages: [
    {
      id: 'home',
      title: 'Home',
      cards: [{ id: 't', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, markdown: '' }],
    },
  ],
  roles: [{ key: 'member', name: 'Member', pages: 'all', tables: [] }],
};

/** What the client sent: method, path and JSON body of the last call. */
async function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [input, init] = fetchMock.mock.calls.at(-1)! as [RequestInfo | URL, RequestInit | undefined];
  const request = input instanceof Request ? input : new Request(new URL(String(input), 'http://x'), init);
  return {
    method: request.method,
    path: new URL(request.url, 'http://x').pathname,
    body: await request
      .clone()
      .json()
      .catch(() => undefined),
  };
}

describe('apps builder client', () => {
  it('saves the draft, publishes and restores with the revision it was given', async () => {
    const fetchMock = vi.fn(async () => Response.json({ app: {}, spec, draftRevision: 6, errors: [] }));
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    await saveAppDraft(4, spec, 5);
    expect(await lastCall(fetchMock)).toEqual({
      method: 'PUT',
      path: '/api/apps/4/draft',
      body: { spec, draftRevision: 5 },
    });

    await publishApp(4, { draftRevision: 6, notes: 'First' });
    expect(await lastCall(fetchMock)).toEqual({
      method: 'POST',
      path: '/api/apps/4/publish',
      body: { draftRevision: 6, notes: 'First' },
    });

    await restoreAppVersion(4, 1, 7);
    expect(await lastCall(fetchMock)).toEqual({
      method: 'POST',
      path: '/api/apps/4/versions/1/restore',
      body: { draftRevision: 7 },
    });
  });

  it('reads the server’s refusals: problems, a lost race, owner only', async () => {
    globalThis.fetch = vi.fn(async () =>
      Response.json(
        { error: 'spec_invalid', details: { reason: 'spec_invalid', errors: [{ path: 'pages', message: 'x' }] } },
        { status: 400 },
      ),
    ) as typeof fetch;
    const invalid = await saveAppDraft(4, spec, 5).catch((error: unknown) => error);
    expect(specErrorsOf(invalid)).toEqual([{ path: 'pages', message: 'x' }]);
    expect(isRevisionConflict(invalid)).toBe(false);

    const conflict = new TablesRequestError('stale', 409, { reason: 'draft_conflict', currentRevision: 9 });
    expect(isRevisionConflict(conflict)).toBe(true);
    expect(specErrorsOf(conflict)).toBeUndefined();
    expect(isOwnerOnly(new TablesRequestError('no', 403, { reason: 'owner_only' }))).toBe(true);
    // A 400 that is not about the spec carries no problems.
    expect(specErrorsOf(new TablesRequestError('bad', 400, { reason: 'other' }))).toBeUndefined();
  });

  it('reads usage defensively: a missing count is zero, never undefined', () => {
    expect(readAppUsage({ users7d: 3, actions30d: { approve: 4, $submit: 'x' } })).toEqual({
      users7d: 3,
      users30d: 0,
      actions30d: { approve: 4, $submit: 0 },
      lastUsedAt: null,
    });
    // The gateway's AppUsageView (slice G) reads back as it is.
    const served: AppUsageView = {
      users7d: 2,
      users30d: 7,
      actions30d: { $submit: 5, $move: 1, approve: 3 },
      lastUsedAt: '2026-10-10T09:00:00.000Z',
    };
    expect(readAppUsage({ ...served })).toEqual(served);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '@greenhouse/types/apps';
import {
  appActionRefusal,
  appFilePath,
  getApp,
  getAppPins,
  listApps,
  listAppTemplates,
  normalizeAppCatalog,
  queryAppCard,
  runAppActionWithReplay,
  setAppPins,
  uploadAppFile,
} from './apps';
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

describe('apps gateway client', () => {
  function recordView(revision: number, values: Record<string, unknown>, actionIds: string[] = []) {
    return {
      record: {
        id: 9,
        revision,
        values,
        createdBy: 'u1',
        createdAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z',
        actionIds,
      },
      refs: { users: {}, records: {}, files: {} },
      fieldIds: [1, 2],
      systemFields: [],
      editableFieldIds: [],
      canComment: false,
    };
  }

  it('posts card queries to the app’s gateway as JSON, a cleared filter as null', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ kind: 'kpi', value: 3 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;

    expect(await queryAppCard(5, { pageId: 'home', cardId: 'total', filterValues: { status: null } })).toEqual({
      kind: 'kpi',
      value: 3,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/apps/5/cards/query');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({ pageId: 'home', cardId: 'total', filterValues: { status: null } });
  });

  it('replays a stale $edit when the fields it writes did not change meanwhile', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      calls.push({ url, body });
      if (url.endsWith('/records/get')) return Response.json(recordView(4, { '1': 'old', '2': 'changed by someone' }));
      if (calls.filter((call) => call.url.endsWith('/actions')).length === 1) {
        return Response.json({ error: 'stale', details: { reason: 'conflict', currentRevision: 4 } }, { status: 409 });
      }
      return Response.json({ outcome: 'updated', recordId: 9 });
    }) as typeof fetch;

    const result = await runAppActionWithReplay(
      5,
      {
        pageId: 'p',
        cardId: 'c',
        actionId: '$edit',
        recordId: 9,
        revision: 3,
        values: [{ fieldId: 1, value: 'new' }],
        requestId: 'first-request',
      },
      { values: { '1': 'old', '2': 'before' } },
    );
    expect(result.outcome).toBe('updated');
    const actions = calls.filter((call) => call.url.endsWith('/actions'));
    expect(actions.map((call) => call.body.revision)).toEqual([3, 4]);
    expect(actions[0]!.body.requestId).toBe('first-request');
    expect(actions[1]!.body.requestId).not.toBe('first-request');
  });

  it('does not replay over a change to the same field, nor an action no longer offered', async () => {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/records/get')
        ? Response.json(recordView(4, { '1': 'theirs' }, []))
        : Response.json({ error: 'stale', details: { reason: 'conflict' } }, { status: 409 }),
    ) as typeof fetch;

    const edit = await runAppActionWithReplay(
      5,
      {
        pageId: 'p',
        cardId: 'c',
        actionId: '$edit',
        recordId: 9,
        revision: 3,
        values: [{ fieldId: 1, value: 'mine' }],
        requestId: 'r-1',
      },
      { values: { '1': 'old' } },
    ).catch((error: unknown) => error);
    expect(edit).toMatchObject({ status: 409 });
    const approve = await runAppActionWithReplay(5, {
      pageId: 'p',
      cardId: 'c',
      actionId: 'approve',
      recordId: 9,
      revision: 3,
      requestId: 'r-2',
    }).catch((error: unknown) => error);
    expect(approve).toMatchObject({ status: 409 });
    expect(appActionRefusal(approve)).toBe('conflict');
  });

  it('never replays a refused precondition', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ error: 'no', details: { reason: 'precondition' } }, { status: 409 }),
    );
    globalThis.fetch = fetchMock as typeof fetch;
    const error = await runAppActionWithReplay(5, {
      pageId: 'p',
      cardId: 'c',
      actionId: 'approve',
      recordId: 9,
      revision: 3,
      requestId: 'r-3',
    }).catch((caught: unknown) => caught);
    expect(appActionRefusal(error)).toBe('precondition');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('hides templates when the server has no templates route, and reads the list when it has one', async () => {
    globalThis.fetch = vi.fn(async () => Response.json({ error: 'App not found' }, { status: 404 })) as typeof fetch;
    expect(await listAppTemplates()).toBeNull();
    globalThis.fetch = vi.fn(async () =>
      Response.json({ templates: [{ key: 'it', name: 'IT', description: 'd', icon: 'ticket', accent: 'blue' }] }),
    ) as typeof fetch;
    expect((await listAppTemplates())?.map((template) => template.key)).toEqual(['it']);
  });

  it('asks for the draft and the previewed role in the query', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) =>
      String(input).includes('/actions') ? Response.json({ outcome: 'updated', recordId: 9 }) : Response.json({}),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    await getApp(5, { previewRole: 'approver', draft: true });
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/apps/5?previewRole=approver&draft=1');
    await getApp(5);
    expect(String(fetchMock.mock.calls[1]![0])).toBe('/api/apps/5');
  });

  it('uploads attachments as multipart for one card field, and addresses downloads by card, record and field', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ file: { id: 31, name: 'a.pdf', size: 3 } }, { status: 201 }),
    );
    globalThis.fetch = fetchMock as typeof globalThis.fetch;
    const file = new File(['abc'], 'a.pdf', { type: 'application/pdf' });
    expect(await uploadAppFile(5, { pageId: 'p', cardId: 'apply', fieldId: 4, file })).toEqual({
      id: 31,
      name: 'a.pdf',
      size: 3,
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('/api/apps/5/uploads');
    const form = init?.body as FormData;
    expect([form.get('pageId'), form.get('cardId'), form.get('fieldId')]).toEqual(['p', 'apply', '4']);
    expect(form.has('draft')).toBe(false);
    expect(appFilePath(5, 31, { pageId: 'p', cardId: 'mine', recordId: 9, fieldId: 4 })).toBe(
      '/api/apps/5/files/31?pageId=p&cardId=mine&recordId=9&fieldId=4',
    );

    // A manager's draft preview reaches the gateway on uploads and downloads too.
    await uploadAppFile(5, { pageId: 'p', cardId: 'apply', fieldId: 4, file, previewRole: 'approver', draft: true });
    const previewForm = fetchMock.mock.calls[1]![1]?.body as FormData;
    expect([previewForm.get('previewRole'), previewForm.get('draft')]).toEqual(['approver', '1']);
    expect(
      appFilePath(5, 31, {
        pageId: 'p',
        cardId: 'mine',
        recordId: 9,
        fieldId: 4,
        previewRole: 'approver',
        draft: true,
      }),
    ).toBe('/api/apps/5/files/31?pageId=p&cardId=mine&recordId=9&fieldId=4&previewRole=approver&draft=1');
  });
});

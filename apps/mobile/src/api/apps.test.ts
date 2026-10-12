/**
 * The app gateway client (./apps.ts): every write carries the viewer's time
 * zone, as the web does — `$today` / `$now` in an action's values or a form's
 * defaults are resolved by the server in that zone, never UTC by default.
 * Root vitest unit project; `api()` is faked, so no React Native loads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>();
vi.mock('./client', () => ({ api: (path: string, init?: RequestInit) => apiMock(path, init) }));

import { installTemplate, listTemplates, queryCard, runAction } from './apps';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const zone = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions');

beforeEach(() => {
  apiMock.mockReset();
  zone.mockReturnValue({ timeZone: 'Asia/Shanghai' } as Intl.ResolvedDateTimeFormatOptions);
});
afterEach(() => zone.mockReset());

const sent = () => JSON.parse(String(apiMock.mock.calls.at(-1)![1]!.body)) as Record<string, unknown>;

describe('the viewer’s time zone', () => {
  it('goes with every write (actions, $submit, $create, $move, $edit)', async () => {
    apiMock.mockResolvedValueOnce(json(200, { outcome: 'updated', recordId: 11 }));
    const result = await runAction(5, {
      pageId: 'apply',
      cardId: 'mine',
      actionId: 'approve',
      recordId: 11,
      revision: 3,
      requestId: 'r-1',
    });
    expect(result).toEqual({ ok: true, value: { outcome: 'updated', recordId: 11 } });
    expect(apiMock).toHaveBeenCalledWith('/api/apps/5/actions', expect.objectContaining({ method: 'POST' }));
    expect(sent()).toMatchObject({ actionId: 'approve', recordId: 11, timezone: 'Asia/Shanghai' });

    apiMock.mockResolvedValueOnce(json(200, { outcome: 'created', recordId: 40 }));
    await runAction(5, { pageId: 'apply', cardId: 'new', actionId: '$submit', values: [], requestId: 'r-2' });
    expect(sent()).toMatchObject({ actionId: '$submit', timezone: 'Asia/Shanghai' });
  });

  it('goes with card queries too, and an explicit zone wins', async () => {
    apiMock.mockResolvedValueOnce(json(200, { kind: 'kpi', value: 1 }));
    await queryCard(5, { pageId: 'apply', cardId: 'total' });
    expect(sent()).toMatchObject({ timezone: 'Asia/Shanghai' });

    apiMock.mockResolvedValueOnce(json(200, { outcome: 'updated', recordId: 11 }));
    await runAction(5, {
      pageId: 'apply',
      cardId: 'mine',
      actionId: '$edit',
      timezone: 'Europe/Paris',
      requestId: 'r-3',
    });
    expect(sent()).toMatchObject({ timezone: 'Europe/Paris' });
  });
});

describe('template installation', () => {
  it('reads the catalog and sends only the chosen name to the saved-template endpoint', async () => {
    apiMock.mockResolvedValueOnce(json(200, { templates: [{ key: 'purchase', version: '1.0.0' }] }));
    expect(await listTemplates()).toEqual({ ok: true, value: [{ key: 'purchase', version: '1.0.0' }] });
    apiMock.mockResolvedValueOnce(json(201, { app: { id: 17, name: 'Procurement' }, baseId: 9 }));
    expect(await installTemplate('team/purchase', 'Procurement')).toEqual({
      ok: true,
      value: { app: { id: 17, name: 'Procurement' }, baseId: 9 },
    });
    expect(apiMock).toHaveBeenLastCalledWith(
      '/api/apps/templates/team%2Fpurchase/install',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(sent()).toEqual({ name: 'Procurement' });
  });

  it('reports review refusals without retrying a creation', async () => {
    apiMock.mockResolvedValueOnce(
      json(409, { error: 'Template review is required', details: { reason: 'review_required' } }),
    );
    expect(await installTemplate('purchase')).toMatchObject({
      ok: false,
      status: 409,
      message: 'Template review is required',
    });
    expect(apiMock).toHaveBeenCalledTimes(1);
  });
});

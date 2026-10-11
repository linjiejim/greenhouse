/**
 * The client half of acceptance 12: after an automation bumps a record's
 * revision, a follow-up single-field write is replayed only when the server did
 * not change the fields it writes — otherwise the conflict surfaces.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const patch = vi.fn();
const get = vi.fn();

vi.mock('../client', () => ({
  rpc: {
    api: {
      tables: {
        tables: {
          ':tableId': {
            records: {
              ':recordId': {
                $patch: (...args: unknown[]) => patch(...args),
                $get: (...args: unknown[]) => get(...args),
              },
            },
          },
        },
      },
    },
  },
}));
vi.mock('../../auth', () => ({ authFetch: vi.fn() }));

const { updateTableRecordWithReplay } = await import('./records');
const { TablesRequestError } = await import('./shared');

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const base = { id: 7, revision: 3, values: { '1': 'open', '2': 'Jim', '3': 10 } };

beforeEach(() => {
  patch.mockReset();
  get.mockReset();
});

describe('updateTableRecordWithReplay', () => {
  it('replays on the new revision when only untouched fields changed', async () => {
    patch
      .mockResolvedValueOnce(response(409, { error: 'Record was changed', details: { currentRevision: 4 } }))
      .mockResolvedValueOnce(
        response(200, { record: { ...base, revision: 5, values: { ...base.values, '1': 'done' } } }),
      );
    get.mockResolvedValueOnce(response(200, { record: { ...base, revision: 4, values: { ...base.values, '3': 11 } } }));

    const saved = await updateTableRecordWithReplay(9, base, { '1': 'done' });

    expect(saved.revision).toBe(5);
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1]![0]).toMatchObject({ json: { revision: 4, values: { '1': 'done' } } });
  });

  it('rethrows the conflict without a second write when a touched field changed', async () => {
    patch.mockResolvedValueOnce(response(409, { error: 'Record was changed', details: { currentRevision: 4 } }));
    get.mockResolvedValueOnce(
      response(200, { record: { ...base, revision: 4, values: { ...base.values, '1': 'blocked' } } }),
    );

    await expect(updateTableRecordWithReplay(9, base, { '1': 'done' })).rejects.toBeInstanceOf(TablesRequestError);
    expect(patch).toHaveBeenCalledTimes(1);
  });

  it('rethrows other errors without re-reading the record', async () => {
    patch.mockResolvedValueOnce(response(403, { error: 'Field is not editable' }));

    await expect(updateTableRecordWithReplay(9, base, { '1': 'done' })).rejects.toMatchObject({ status: 403 });
    expect(get).not.toHaveBeenCalled();
  });
});

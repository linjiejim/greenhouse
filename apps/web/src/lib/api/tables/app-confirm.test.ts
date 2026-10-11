/**
 * The structure changes apps depend on (Phase 1 D6) resend with `confirm`:
 * archives and field updates in the JSON body, the automation delete as
 * `?confirm=1`. Unconfirmed writes carry no confirm at all.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteTableAutomation } from './automations';
import { archiveTableDefinition, archiveTableField, updateTableField } from './schema';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function capture(body: unknown) {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json(body));
  globalThis.fetch = fetchMock as typeof globalThis.fetch;
  return (index: number) => {
    const [url, init] = fetchMock.mock.calls[index]!;
    return { url: String(url), method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined };
  };
}

describe('confirming a change apps use', () => {
  it('sends confirm only when asked', async () => {
    const call = capture({ table: { id: 7 }, field: { id: 2 }, deleted: true });
    await archiveTableDefinition(7);
    await archiveTableDefinition(7, { confirm: true });
    await archiveTableField(2);
    await archiveTableField(2, { confirm: true });
    await updateTableField(2, { name: 'Status' });
    await updateTableField(2, { name: 'Status' }, { confirm: true });
    await deleteTableAutomation(11);
    await deleteTableAutomation(11, { confirm: true });

    expect(call(0)).toMatchObject({ url: '/api/tables/tables/7/archive', method: 'POST', body: {} });
    expect(call(1)).toMatchObject({ url: '/api/tables/tables/7/archive', body: { confirm: true } });
    expect(call(2)).toMatchObject({ url: '/api/tables/fields/2/archive', body: {} });
    expect(call(3)).toMatchObject({ url: '/api/tables/fields/2/archive', body: { confirm: true } });
    expect(call(4)).toMatchObject({ url: '/api/tables/fields/2', method: 'PATCH', body: { name: 'Status' } });
    expect(call(5).body).toEqual({ name: 'Status', confirm: true });
    expect(call(6)).toMatchObject({ url: '/api/tables/automations/11', method: 'DELETE' });
    expect(call(7)).toMatchObject({ url: '/api/tables/automations/11?confirm=1', method: 'DELETE' });
  });
});

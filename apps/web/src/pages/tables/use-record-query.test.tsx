/** @vitest-environment happy-dom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { TableQuery } from '@greenhouse/types/tables';
import type { TableRecord, TableRecordPage } from '../../lib/api/tables';
import { TablesRequestError } from '../../lib/api/tables/shared';
import { useRecordQuery } from './use-record-query';

const api = vi.hoisted(() => ({ queryTableRecords: vi.fn(), translate: (key: string) => key }));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  queryTableRecords: api.queryTableRecords,
}));
vi.mock('../../lib/i18n', () => ({ useT: () => api.translate }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let current: ReturnType<typeof useRecordQuery>;
const onError = vi.fn();
let requests: Array<{ query: TableQuery; resolve: (page: TableRecordPage) => void; reject: (error: Error) => void }>;

function Harness() {
  current = useRecordQuery(7, onError);
  return <div aria-busy={current.loading}>{current.records.map((row) => row.id).join(',')}</div>;
}

function page(offset: number, nextCursor: string | null = offset < 180 ? String(offset + 20) : null): TableRecordPage {
  return {
    records: [{ id: 231 - offset, table_id: 7, values: {}, computed_values: {}, revision: 1 } as TableRecord],
    total: 200,
    nextCursor,
  };
}

async function respond(index: number, result: TableRecordPage) {
  await act(async () => requests[index]!.resolve(result));
}

beforeEach(async () => {
  localStorage.clear();
  requests = [];
  api.queryTableRecords.mockImplementation(
    (_tableId: number, query: TableQuery) =>
      new Promise<TableRecordPage>((resolve, reject) => requests.push({ query, resolve, reject })),
  );
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Harness />));
  await respond(0, page(0));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

it('jumps through the remaining cursors and hides the previous page while loading', async () => {
  expect(container.textContent).toBe('231');
  await act(async () => current.setPage(9));
  expect(current.records).toEqual([]);
  expect(current.loading).toBe(true);
  expect(container.textContent).toBe('');
  for (let index = 1; index <= 9; index++) {
    expect(requests[index]!.query.cursor).toBe(String(index * 20));
    await respond(index, page(index * 20));
  }
  expect(current.page).toBe(9);
  expect(container.textContent).toBe('51');
  expect(current.loading).toBe(false);
  await act(async () => current.setPage(8));
  expect(requests[10]!.query.cursor).toBe('160');
  await respond(10, page(160));
  expect(container.textContent).toBe('71');
});

it('lets the selected page land under repeated refreshes and performs one trailing refresh', async () => {
  await act(async () => current.setPage(9));
  for (let index = 1; index <= 9; index++) {
    await act(async () => {
      void current.reload();
    });
    expect(requests).toHaveLength(index + 1);
    await respond(index, page(index * 20));
  }
  // The selected page is usable before a refresh queued during its load finishes.
  expect(current.records[0]!.id).toBe(51);
  expect(current.page).toBe(9);
  expect(requests).toHaveLength(11);
  expect(requests[10]!.query.cursor).toBe('180');
  await respond(10, page(180));
  expect(current.loading).toBe(false);
});

it('invalidates cached cursors on filter and page-size changes and stops obsolete chains', async () => {
  await act(async () => current.setPage(9));
  await act(async () => current.setQuery({ search: 'updated' }));
  expect(current.page).toBe(0);
  expect(requests[2]!.query).toMatchObject({ search: 'updated', cursor: undefined });
  await respond(1, page(20, 'obsolete-40'));
  expect(requests).toHaveLength(3);
  await respond(2, page(0, 'updated-20'));
  await act(async () => current.setPage(1));
  expect(requests[3]!.query.cursor).toBe('updated-20');
  await respond(3, page(20, 'updated-40'));
  await act(async () => current.setPageSize(50));
  expect(current.page).toBe(0);
  expect(requests[4]!.query).toMatchObject({ search: 'updated', limit: 50, cursor: undefined });
  await respond(4, page(0, 'updated-50'));
});

it('rebuilds a scope-invalidated cursor once and reports a repeated rejection without looping', async () => {
  await act(async () => current.setPage(1));
  await act(async () =>
    requests[1]!.reject(new TablesRequestError('cursor is invalid for this query', 400, undefined)),
  );
  expect(requests[2]!.query.cursor).toBeUndefined();
  await respond(2, page(0, 'new-scope-20'));
  expect(requests[3]!.query.cursor).toBe('new-scope-20');
  await act(async () =>
    requests[3]!.reject(new TablesRequestError('cursor is invalid for this query', 400, undefined)),
  );
  expect(requests).toHaveLength(4);
  expect(current.loading).toBe(false);
  expect(onError).toHaveBeenLastCalledWith('cursor is invalid for this query');
});

it('lands the selected page after rebuilding a scope-invalidated cursor', async () => {
  await act(async () => current.setPage(1));
  await act(async () =>
    requests[1]!.reject(new TablesRequestError('cursor is invalid for this query', 400, undefined)),
  );
  await respond(2, page(0, 'new-scope-20'));
  await respond(3, page(20));
  expect(current.page).toBe(1);
  expect(current.records[0]!.id).toBe(211);
  expect(current.loading).toBe(false);
  expect(onError).not.toHaveBeenCalledWith('cursor is invalid for this query');
});

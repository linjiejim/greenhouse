/**
 * 表格 data: bases, a view's records (every page up to MAX_VIEW_RECORDS, so grids and timelines
 * can scroll through all of them), one record, its activity, the recycle bin and shares. Writes
 * patch the cached records with what the server returns; `records.changed` refetches only when
 * a cached record is older than the revision it names.
 */

import { useQuery, type QueryClient } from '@tanstack/react-query';
import {
  MAX_QUERY_LIMIT,
  MAX_VIEW_RECORDS,
  type Base,
  type BulkResult,
  type LinkedRecord,
  type RealtimeEvent,
  type RecordDetail,
  type RecordFile,
  type RecordsQuery,
  type TableRecord,
  type View,
  type ViewConfig,
} from '@greenhouse/contract';
import { api } from '../lib/api';
import { queryClient } from './query';

export const tablesKeys = {
  all: ['tables'] as const,
  bases: (archived = false) => ['tables', 'bases', archived] as const,
  base: (id: string) => ['tables', 'base', id] as const,
  records: (tableId: string) => ['tables', 'records', tableId] as const,
  view: (tableId: string, query: ViewQuery) => ['tables', 'records', tableId, query] as const,
  record: (id: string) => ['tables', 'record', id] as const,
  activity: (id: string) => ['tables', 'activity', id] as const,
  trash: (baseId: string) => ['tables', 'trash', baseId] as const,
  roles: (baseId: string) => ['tables', 'roles', baseId] as const,
  shares: (baseId: string) => ['tables', 'shares', baseId] as const,
  titles: (tableId: string) => ['tables', 'titles', tableId] as const,
};

/** What a view asks the server for: its filter, sorts and group, and the toolbar search. */
export type ViewQuery = Pick<RecordsQuery, 'filter' | 'sorts' | 'group' | 'search'>;

export interface ViewRecords {
  items: TableRecord[];
  linked: Record<string, LinkedRecord>;
  files: Record<string, RecordFile>;
  /** More matched than MAX_VIEW_RECORDS. */
  truncated: boolean;
}

export const queryOf = (config: ViewConfig, search: string): ViewQuery => ({
  ...(config.filter?.clauses.length ? { filter: config.filter } : {}),
  ...(config.sorts?.length ? { sorts: config.sorts } : {}),
  ...(config.group ? { group: config.group } : {}),
  ...(search.trim() ? { search: search.trim() } : {}),
});

export function useBases(archived = false, enabled = true) {
  const result = useQuery({
    queryKey: tablesKeys.bases(archived),
    queryFn: () => api.tables.bases.listAll({ archived }),
    staleTime: 30_000,
    enabled,
  });
  return { ...result, items: result.data?.items ?? [] };
}

export function useBase(id: string) {
  return useQuery({ queryKey: tablesKeys.base(id), queryFn: () => api.tables.bases.get(id) });
}

/** Every record a view shows, page by page up to MAX_VIEW_RECORDS. */
export function useViewRecords(tableId: string, query: ViewQuery, enabled = true) {
  return useQuery({
    queryKey: tablesKeys.view(tableId, query),
    enabled,
    staleTime: 15_000,
    // A new filter or sort keeps the records on screen until the new ones come; another table does not.
    placeholderData: (previous, previousQuery) => (previousQuery?.queryKey[2] === tableId ? previous : undefined),
    queryFn: async (): Promise<ViewRecords> => {
      const all: ViewRecords = { items: [], linked: {}, files: {}, truncated: false };
      let cursor: string | undefined;
      do {
        const page = await api.tables.tables.query(tableId, { ...query, cursor, limit: MAX_QUERY_LIMIT });
        all.items.push(...page.items);
        Object.assign(all.linked, page.linked);
        Object.assign(all.files, page.files);
        cursor = page.next_cursor ?? undefined;
        if (cursor && all.items.length >= MAX_VIEW_RECORDS) {
          all.truncated = true;
          break;
        }
      } while (cursor);
      return all;
    },
  });
}

export function useRecord(id: string | undefined) {
  return useQuery({
    queryKey: tablesKeys.record(id ?? ''),
    queryFn: () => api.tables.records.get(id!),
    enabled: !!id,
  });
}

export function useActivity(id: string | undefined) {
  return useQuery({
    queryKey: tablesKeys.activity(id ?? ''),
    queryFn: () => api.tables.records.activity(id!, { limit: 100 }),
    enabled: !!id,
  });
}

export function useTitles(tableId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: tablesKeys.titles(tableId ?? ''),
    queryFn: () => api.tables.tables.titles(tableId!, { limit: 1000 }),
    enabled: !!tableId && enabled,
    staleTime: 30_000,
  });
}

// ── Writing records into the cache ──────────────────────

/** Puts records the server returned into every cached view of their table (new ones at the end). */
export function putRecords(
  tableId: string,
  records: readonly TableRecord[],
  extra: { linked?: Record<string, LinkedRecord>; files?: Record<string, RecordFile> } = {},
  client: QueryClient = queryClient,
) {
  client.setQueriesData<ViewRecords>({ queryKey: tablesKeys.records(tableId) }, (data) => {
    if (!data) return data;
    const byId = new Map(records.map((record) => [record.id, record]));
    const items = data.items.map((item) => {
      const next = byId.get(item.id);
      if (!next) return item;
      byId.delete(item.id);
      return next.revision >= item.revision && next.computed_revision >= item.computed_revision ? next : item;
    });
    return {
      ...data,
      items: [...items, ...byId.values()],
      linked: { ...data.linked, ...extra.linked },
      files: { ...data.files, ...extra.files },
    };
  });
  for (const record of records) {
    client.setQueryData<RecordDetail>(tablesKeys.record(record.id), (data) =>
      data && record.revision >= data.record.revision && record.computed_revision >= data.record.computed_revision
        ? { ...data, record, linked: { ...data.linked, ...extra.linked }, files: { ...data.files, ...extra.files } }
        : data,
    );
  }
}

/** Takes records out of every cached view of their table. */
export function dropRecords(tableId: string, ids: readonly string[], client: QueryClient = queryClient) {
  const gone = new Set(ids);
  client.setQueriesData<ViewRecords>({ queryKey: tablesKeys.records(tableId) }, (data) =>
    data ? { ...data, items: data.items.filter((item) => !gone.has(item.id)) } : data,
  );
}

/** Changes a record's values: shown at once, then saved; on failure the cache is reloaded. */
export async function saveRecord(record: TableRecord, values: TableRecord['values']): Promise<RecordDetail> {
  putRecords(record.table_id, [{ ...record, values: { ...record.values, ...values } }]);
  try {
    const saved = await api.tables.records.update(record.id, record.revision, values);
    putRecords(record.table_id, [saved.record], saved);
    return saved;
  } catch (error) {
    void queryClient.invalidateQueries({ queryKey: tablesKeys.records(record.table_id) });
    throw error;
  }
}

export async function createRecord(tableId: string, values: TableRecord['values']): Promise<RecordDetail> {
  const made = await api.tables.tables.createRecord(tableId, { values });
  putRecords(tableId, [made.record], made);
  return made;
}

export async function bulkRecords(
  tableId: string,
  items: Parameters<typeof api.tables.tables.bulk>[1]['items'],
): Promise<BulkResult> {
  const result = await api.tables.tables.bulk(tableId, { items });
  putRecords(
    tableId,
    result.items.flatMap((item) => (item.record ? [item.record] : [])),
    result,
  );
  return result;
}

export async function deleteRecords(tableId: string, ids: readonly string[]) {
  dropRecords(tableId, ids);
  try {
    if (ids.length === 1) await api.tables.records.remove(ids[0]!);
    else await api.tables.tables.deleteRecords(tableId, [...ids]);
  } finally {
    void queryClient.invalidateQueries({ queryKey: tablesKeys.records(tableId) });
  }
}

export async function restoreRecord(tableId: string, id: string) {
  const record = await api.tables.records.restore(id);
  void queryClient.invalidateQueries({ queryKey: tablesKeys.records(tableId) });
  return record;
}

// ── Base, views and the rest ────────────────────────────

/** Puts a changed view into the cached base at once (a toolbar change shows before it saves). */
export function putView(baseId: string, view: View) {
  queryClient.setQueryData<Base>(tablesKeys.base(baseId), (data) =>
    data
      ? {
          ...data,
          views: data.views.some((item) => item.id === view.id)
            ? data.views.map((item) => (item.id === view.id ? view : item))
            : [...data.views, view],
        }
      : data,
  );
}

export const refreshBase = (baseId: string) =>
  Promise.all([
    queryClient.invalidateQueries({ queryKey: tablesKeys.base(baseId) }),
    queryClient.invalidateQueries({ queryKey: ['tables', 'bases'] }),
  ]);

// ── Realtime ────────────────────────────────────────────

const timers = new Map<string, ReturnType<typeof setTimeout>>();
function soon(client: QueryClient, queryKey: readonly unknown[], delay = 400) {
  const id = JSON.stringify(queryKey);
  if (timers.has(id)) return;
  timers.set(
    id,
    setTimeout(() => {
      timers.delete(id);
      void client.invalidateQueries({ queryKey });
    }, delay),
  );
}

/** Applies a tables event to the cache; false when the event is not about tables. */
export function applyTablesEvent(client: QueryClient, event: Exclude<RealtimeEvent, { type: 'ready' }>): boolean {
  switch (event.type) {
    case 'records.changed': {
      const { table_id: tableId, records } = event.data;
      const views = client.getQueriesData<ViewRecords>({ queryKey: tablesKeys.records(tableId) });
      for (const [key, data] of views) {
        if (!data) continue;
        const cached = new Map(data.items.map((item) => [item.id, item]));
        const behind =
          !records.length ||
          records.some(
            (record) =>
              !cached.has(record.id) ||
              cached.get(record.id)!.revision < record.revision ||
              cached.get(record.id)!.computed_revision < (record.computed_revision ?? 0),
          );
        if (behind) soon(client, key);
      }
      for (const record of records) {
        const detail = client.getQueryData<RecordDetail>(tablesKeys.record(record.id));
        if (
          detail &&
          (detail.record.revision < record.revision ||
            detail.record.computed_revision < (record.computed_revision ?? 0))
        )
          soon(client, tablesKeys.record(record.id));
        soon(client, tablesKeys.activity(record.id));
      }
      soon(client, tablesKeys.titles(tableId));
      soon(client, ['tables', 'cards', event.data.base_id]);
      return true;
    }
    case 'base.updated':
      soon(client, tablesKeys.base(event.data.base_id), 200);
      soon(client, ['tables', 'bases'], 200);
      soon(client, tablesKeys.trash(event.data.base_id));
      soon(client, tablesKeys.shares(event.data.base_id));
      soon(client, tablesKeys.roles(event.data.base_id));
      // Shares and row/column rules can revoke access without changing record revisions.
      void client.resetQueries({ queryKey: ['tables', 'records'] });
      void client.resetQueries({ queryKey: ['tables', 'record'] });
      void client.resetQueries({ queryKey: ['tables', 'titles'] });
      void client.resetQueries({ queryKey: ['tables', 'activity'] });
      void client.resetQueries({ queryKey: ['tables', 'cards'] });
      void client.resetQueries({ queryKey: ['search'] });
      return true;
    case 'comments.updated':
      if (event.data.target_type !== 'record') return false;
      soon(client, tablesKeys.activity(event.data.target_id), 100);
      return true;
    default:
      return false;
  }
}

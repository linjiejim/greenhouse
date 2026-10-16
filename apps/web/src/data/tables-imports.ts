/**
 * 表格 CSV imports: my recent imports into a table, and one import, asked for again every second
 * while it writes. When one finishes, the table's views load the records it made.
 */

import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isImportActive, type BaseImport, type UpdateImportInput } from '@greenhouse/contract';
import { api } from '../lib/api';
import { queryClient } from './query';
import { tablesKeys } from './tables';

export const importsKeys = {
  list: (tableId: string) => ['tables', 'imports', 'list', tableId] as const,
  one: (id: string) => ['tables', 'imports', 'one', id] as const,
};

/** Recent imports shown before a file is chosen. */
const RECENT = 5;
const POLL_MS = 1_000;

export function useImports(tableId: string) {
  return useQuery({
    queryKey: importsKeys.list(tableId),
    queryFn: () => api.tables.imports.list(tableId, { limit: RECENT }),
  });
}

export function useImport(id: string | null) {
  const query = useQuery({
    queryKey: importsKeys.one(id ?? ''),
    queryFn: () => api.tables.imports.get(id!),
    enabled: !!id,
    refetchInterval: (current) => (current.state.data && isImportActive(current.state.data.status) ? POLL_MS : false),
  });
  const status = query.data?.status;
  const tableId = query.data?.table_id;
  const before = useRef(status);
  useEffect(() => {
    // Batches tell the views as they land; the end reloads them once more, and the list.
    if (tableId && status && before.current && isImportActive(before.current) && !isImportActive(status)) {
      void queryClient.invalidateQueries({ queryKey: tablesKeys.records(tableId) });
      void queryClient.invalidateQueries({ queryKey: importsKeys.list(tableId) });
    }
    before.current = status;
  }, [status, tableId]);
  return query;
}

function put(item: BaseImport) {
  queryClient.setQueryData(importsKeys.one(item.id), item);
  void queryClient.invalidateQueries({ queryKey: importsKeys.list(item.table_id) });
  return item;
}

export async function uploadImport(tableId: string, file: File): Promise<BaseImport> {
  return put(await api.tables.imports.upload(tableId, file));
}

/** A draft's choices: where its columns go and whether its first row is the header. */
export async function saveImport(id: string, input: UpdateImportInput): Promise<BaseImport> {
  return put(await api.tables.imports.update(id, input));
}

/** Saves the choices, then queues the draft. */
export async function startImport(id: string, input: UpdateImportInput): Promise<BaseImport> {
  await saveImport(id, input);
  return put(await api.tables.imports.start(id));
}

export async function cancelImport(id: string): Promise<BaseImport> {
  return put(await api.tables.imports.cancel(id));
}

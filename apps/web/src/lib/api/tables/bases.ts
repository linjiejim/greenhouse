/**
 * Tables client · Bases (list, create, read the workspace, rename, archive),
 * the internal user directory and the Base audit log.
 */

import type { TableBaseVisibility } from '@greenhouse/types/tables';
import type {
  TableAuditEvent,
  TableBase,
  TableBaseWithRole,
  TableBaseWorkspace,
  TableSchema,
  TableUser,
} from '@greenhouse/types/tables-wire';
import { authFetch } from '../../auth';
import { rpc } from '../client';
import { responseError } from './shared';

// The response shapes live in `@greenhouse/types/tables-wire` (one copy for web and mobile).
export type {
  TableAuditEvent,
  TableBase,
  TableBaseMember,
  TableBaseWithRole,
  TableBaseWorkspace,
  TableUser,
  TableUserOption,
} from '@greenhouse/types/tables-wire';

export async function listTableBases(search?: string): Promise<TableBaseWithRole[]> {
  const response = await rpc.api.tables.bases.$get({ query: search ? { search } : {} });
  if (!response.ok) throw await responseError(response, 'Unable to load Tables');
  return (await response.json()).bases;
}

export async function createTableBase(input: {
  name: string;
  description?: string;
  visibility: TableBaseVisibility;
  defaultTableName?: string;
}): Promise<{ base: TableBase; role: 'owner'; schema: TableSchema }> {
  const response = await rpc.api.tables.bases.$post({ json: input });
  if (!response.ok) throw await responseError(response, 'Unable to create Base');
  return response.json();
}

export async function getTableBase(baseId: number): Promise<TableBaseWorkspace> {
  const response = await rpc.api.tables.bases[':baseId'].$get({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load Base');
  return response.json();
}

export async function listTableUsers(): Promise<TableUser[]> {
  const response = await rpc.api.tables.meta.users.$get();
  if (!response.ok) throw await responseError(response, 'Unable to load users');
  return (await response.json()).users;
}

export async function updateTableBase(
  baseId: number,
  input: { name?: string; description?: string | null; visibility?: TableBaseVisibility },
): Promise<TableBase> {
  const args = { param: { baseId: String(baseId) }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update Base');
  return (await response.json()).base;
}

export async function archiveTableBase(baseId: number): Promise<TableBase> {
  const response = await rpc.api.tables.bases[':baseId'].archive.$post({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to delete Base');
  return (await response.json()).base;
}

export async function listTableBaseAudit(baseId: number, limit = 100): Promise<TableAuditEvent[]> {
  const response = await authFetch(`/api/tables/bases/${baseId}/audit?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load Base audit');
  return ((await response.json()) as { events: TableAuditEvent[] }).events;
}

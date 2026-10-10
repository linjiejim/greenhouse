/**
 * Tables client · Bases (list, create, read the workspace, rename, archive),
 * the internal user directory and the Base audit log.
 */

import type { TableBaseRole, TableBaseVisibility } from '@greenhouse/types/tables';
import { authFetch } from '../../auth';
import { rpc } from '../client';
import { responseError } from './shared';
import type { TableDashboard } from './dashboards';
import type { TableDefinition, TableSchema } from './schema';

export interface TableBase {
  id: number;
  name: string;
  description: string | null;
  visibility: TableBaseVisibility;
  owner_id: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface TableBaseWithRole extends TableBase {
  role: TableBaseRole;
}

export interface TableBaseMember {
  id: number;
  base_id: number;
  user_id: string;
  role: TableBaseRole;
  added_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableBaseWorkspace {
  base: TableBase;
  role: TableBaseRole;
  tables: TableDefinition[];
  dashboards: TableDashboard[];
  members: TableBaseMember[];
}

/** One internal account from the Tables user directory. */
export interface TableUser {
  id: string;
  nickname: string;
  email: string;
  role: 'team' | 'super';
}

/** What editors, filters and renderers need from a user. */
export type TableUserOption = Pick<TableUser, 'id' | 'nickname' | 'email'>;

export interface TableAuditEvent {
  id: string;
  org_id: string;
  actor_id: string;
  actor_type: 'human' | 'agent' | 'service' | 'system' | 'migration';
  on_behalf_of_user_id: string | null;
  client_id: string | null;
  request_id: string;
  app_id: string;
  module_id: string | null;
  entity_id: string | null;
  record_id: string | null;
  action_id: string;
  capability: string;
  result: 'success' | 'denied' | 'error';
  summary: string;
  created_at: string;
}

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

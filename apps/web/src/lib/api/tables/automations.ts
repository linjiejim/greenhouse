/**
 * Tables client · automation rules and their run log.
 */

import type {
  TableAutomationActionInput,
  TableAutomationConfig,
  TableAutomationTrigger,
} from '@greenhouse/types/tables';
import { authFetch } from '../../auth';
import { responseError } from './shared';

export interface TableAutomation {
  id: number;
  base_id: number;
  table_id: number;
  name: string;
  status: 'disabled' | 'enabled';
  trigger: TableAutomationTrigger;
  config: TableAutomationConfig;
  execution_user_id: string;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: string;
  updated_at: string;
}

export interface TableAutomationRun {
  id: number;
  rule_id: number;
  outbox_id: number | null;
  status: 'running' | 'succeeded' | 'failed';
  actions_completed: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** What a client sends: action ids are optional — the server assigns them and never regenerates one. */
export type TableAutomationConfigInput = Omit<TableAutomationConfig, 'actions'> & {
  actions: TableAutomationActionInput[];
};

export async function listTableAutomations(baseId: number): Promise<TableAutomation[]> {
  const response = await authFetch(`/api/tables/bases/${baseId}/automations`);
  if (!response.ok) throw await responseError(response, 'Unable to load automations');
  return ((await response.json()) as { automations: TableAutomation[] }).automations;
}

export async function createTableAutomation(
  baseId: number,
  input: {
    tableId: number;
    name: string;
    status?: 'disabled' | 'enabled';
    trigger: TableAutomationTrigger;
    config: TableAutomationConfigInput;
  },
): Promise<TableAutomation> {
  const response = await authFetch(`/api/tables/bases/${baseId}/automations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to create automation');
  return ((await response.json()) as { automation: TableAutomation }).automation;
}

export async function updateTableAutomation(
  automationId: number,
  input: {
    revision: number;
    name?: string;
    status?: 'disabled' | 'enabled';
    trigger?: TableAutomationTrigger;
    config?: TableAutomationConfigInput;
  },
): Promise<TableAutomation> {
  const response = await authFetch(`/api/tables/automations/${automationId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!response.ok) throw await responseError(response, 'Unable to update automation');
  return ((await response.json()) as { automation: TableAutomation }).automation;
}

export async function listTableAutomationRuns(automationId: number, limit = 20): Promise<TableAutomationRun[]> {
  const response = await authFetch(`/api/tables/automations/${automationId}/runs?limit=${limit}`);
  if (!response.ok) throw await responseError(response, 'Unable to load automation runs');
  return ((await response.json()) as { runs: TableAutomationRun[] }).runs;
}

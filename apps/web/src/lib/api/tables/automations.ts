/**
 * Tables client · automation rules, their run log, and record buttons.
 *
 * The editor is the only place a webhook action is added or its secret set /
 * cleared (`secret: string | null` on the action input); reads only ever carry
 * `hasSecret`.
 */

import type {
  TableAutomationActionInput,
  TableAutomationConfig,
  TableAutomationTrigger,
  TableRecordButton,
} from '@greenhouse/types/tables';
import type { TableAutomation, TableAutomationRun } from '@greenhouse/types/tables-wire';
import { rpc } from '../client';
import { responseError } from './shared';

// The response shapes live in `@greenhouse/types/tables-wire` (one copy for web and mobile).
export type { TableAutomation, TableAutomationRun } from '@greenhouse/types/tables-wire';

/** What a client sends: action ids are optional — the server assigns them and never regenerates one. */
export type TableAutomationConfigInput = Omit<TableAutomationConfig, 'actions'> & {
  actions: TableAutomationActionInput[];
};

export async function listTableAutomations(baseId: number): Promise<TableAutomation[]> {
  const response = await rpc.api.tables.bases[':baseId'].automations.$get({ param: { baseId: String(baseId) } });
  if (!response.ok) throw await responseError(response, 'Unable to load automations');
  return (await response.json()).automations;
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
  const args = { param: { baseId: String(baseId) }, json: input };
  const response = await rpc.api.tables.bases[':baseId'].automations.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to create automation');
  return (await response.json()).automation;
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
  const args = { param: { automationId: String(automationId) }, json: input };
  const response = await rpc.api.tables.automations[':automationId'].$patch(args);
  if (!response.ok) throw await responseError(response, 'Unable to update automation');
  return (await response.json()).automation;
}

export async function deleteTableAutomation(automationId: number): Promise<void> {
  const response = await rpc.api.tables.automations[':automationId'].$delete({
    param: { automationId: String(automationId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to delete automation');
}

export async function listTableAutomationRuns(automationId: number, limit = 20): Promise<TableAutomationRun[]> {
  const args = { param: { automationId: String(automationId) }, query: { limit: String(limit) } };
  const response = await rpc.api.tables.automations[':automationId'].runs.$get(args);
  if (!response.ok) throw await responseError(response, 'Unable to load automation runs');
  return (await response.json()).runs;
}

/** The automation buttons the viewer may press on a record (empty when they cannot update it). */
export async function listTableRecordButtons(tableId: number, recordId: number): Promise<TableRecordButton[]> {
  const response = await rpc.api.tables.tables[':tableId'].records[':recordId'].buttons.$get({
    param: { tableId: String(tableId), recordId: String(recordId) },
  });
  if (!response.ok) throw await responseError(response, 'Unable to load buttons');
  return (await response.json()).buttons;
}

/** Press a button: queues one run per `requestId` (a double click is one run). */
export async function triggerTableAutomation(
  ruleId: number,
  recordId: number,
  requestId: string,
): Promise<{ queued: true; duplicate: boolean }> {
  const args = { param: { automationId: String(ruleId) }, json: { recordId, requestId } };
  const response = await rpc.api.tables.automations[':automationId'].trigger.$post(args);
  if (!response.ok) throw await responseError(response, 'Unable to run the automation');
  return response.json();
}

/**
 * Tables client · conversational schema plans (the `tables_schema_plan` card).
 */

import type { SchemaPlanApplyResult, SchemaPlanOperation } from '@greenhouse/types/tables';
import { rpc } from '../client';
import { responseError } from './shared';

/**
 * Applies a schema plan the model drafted and the user confirmed. This is the
 * only way a `tables_schema_plan` card becomes real — the tool itself writes
 * nothing, and the server re-authorizes every operation on its own. `retry`
 * re-runs only the operations of an applied plan that did not apply.
 */
export async function applyTableSchemaPlan(
  operations: SchemaPlanOperation[],
  receipt: { actionId: string; sessionId: string },
  options: { retry?: boolean } = {},
): Promise<SchemaPlanApplyResult> {
  const response = await rpc.api.tables['schema-plan'].apply.$post({
    json: {
      operations,
      action_id: receipt.actionId,
      session_id: receipt.sessionId,
      ...(options.retry ? { retry: true } : {}),
    },
  });
  if (!response.ok) throw await responseError(response, 'Unable to apply the schema plan');
  return await response.json();
}

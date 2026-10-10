/**
 * Tables · tables, fields, schema versions and the confirmed schema plan —
 * mounted at /api/tables (endpoint list in ./index.ts).
 */

import { Hono } from 'hono';
import {
  getDb,
  type TableDefinitionRow,
  type TableFieldRow,
  type TableSchemaResult,
  type TableSchemaVersionRow,
} from '@greenhouse/db';
import type { SchemaPlanApplyResult, SchemaPlanOperation } from '@greenhouse/types/tables';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { AppEnv } from '../../app-env.js';
import { getAuthUser } from '../../auth/middleware.js';
import { artifactReceiptResult, claimArtifactAction } from '../../chat/artifact-actions.js';
import { analyzeSchemaPlan, applySchemaPlan, schemaPlanApplySchema } from '../../platform/tables/schema-plan.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const schemaRoutes = new Hono<AppEnv>()
  .get('/bases/:baseId/tables', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listTables', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { tables: TableDefinitionRow[] });
  })
  .post('/bases/:baseId/tables', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createTable', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableSchemaResult, 201);
  })
  .patch('/tables/:tableId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'updateTable', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { table: TableDefinitionRow });
  })
  .post('/tables/:tableId/archive', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'archiveTable', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { table: TableDefinitionRow });
  })
  .get('/tables/:tableId/schema', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'getSchema', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableSchemaResult);
  })
  .get('/tables/:tableId/schema/versions', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'listSchemaVersions', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { versions: TableSchemaVersionRow[] });
  })
  .get('/tables/:tableId/schema/versions/:version', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const version = numberParam(c, 'version');
    const result = await dispatch(c, 'getSchemaVersion', { tableId, version }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { version: TableSchemaVersionRow });
  })
  .post('/tables/:tableId/fields', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createField', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow }, 201);
  })
  .patch('/fields/:fieldId', async (c) => {
    const fieldId = numberParam(c, 'fieldId');
    const result = await dispatch(c, 'updateField', { ...(await jsonBody(c)), fieldId }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow });
  })
  .post('/fields/:fieldId/archive', async (c) => {
    const fieldId = numberParam(c, 'fieldId');
    const result = await dispatch(c, 'archiveField', { fieldId }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow });
  })
  /**
   * The confirm gate behind `tables_schema_plan`. The tool only drafts; this is
   * where a plan becomes real, and it is reachable only with the user's own
   * bearer token — no model-facing surface can call it. Each operation is
   * re-authorized by its own runtime action, so a tampered plan can never
   * exceed what its sender could already do through the UI.
   */
  .post('/schema-plan/apply', async (c) => {
    const raw = await jsonBody(c);
    const parsed = schemaPlanApplySchema.safeParse(raw);
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid schema plan' }, 400);
    }
    const actionId = typeof raw.action_id === 'string' ? raw.action_id : '';
    const sessionId = typeof raw.session_id === 'string' ? raw.session_id : '';
    if (!actionId || !sessionId) return c.json({ error: 'action_id and session_id are required' }, 400);
    const operations = parsed.data.operations as SchemaPlanOperation[];
    const shape = analyzeSchemaPlan(operations);
    if ('error' in shape) return c.json({ error: shape.error }, 400);
    const claim = await claimArtifactAction({
      actionId,
      sessionId,
      user: getAuthUser(c),
      kind: 'tables_schema_plan',
      payload: operations,
    });
    if (!claim.ok) return c.json({ error: claim.error }, claim.status);
    if (!claim.claimed) {
      const prior = artifactReceiptResult<SchemaPlanApplyResult>(claim.receipt);
      if (prior) return c.json(prior);
      return c.json(
        { error: claim.receipt.error ?? 'This schema plan is already being applied; refresh to check its receipt' },
        409,
      );
    }
    try {
      const applied = await applySchemaPlan(operations, (planActionId, payload, ids) =>
        dispatch(c, planActionId, payload, ids),
      );
      await getDb().chatArtifactReceipts.succeed(actionId, getAuthUser(c).id, applied);
      return c.json(applied);
    } catch (error) {
      const message = toErrorMessage(error);
      await getDb().chatArtifactReceipts.fail(actionId, getAuthUser(c).id, message);
      return c.json({ error: message }, 500);
    }
  });

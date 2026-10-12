/**
 * Tables · tables, fields, schema versions and the confirmed schema plan —
 * mounted at /api/tables (endpoint list in ./index.ts).
 */

import { Hono } from 'hono';
import { validator } from 'hono/validator';
import { z } from 'zod';
import {
  getDb,
  type TableDefinitionRow,
  type TableFieldRow,
  type TableSchemaResult,
  type TableSchemaVersionRow,
} from '@greenhouse/db';
import type { SchemaPlanApplyResult, TableAiFieldRunResult, TableAiFieldStatusView } from '@greenhouse/types/tables';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { AppEnv } from '../../app-env.js';
import { getAuthUser } from '../../auth/middleware.js';
import { artifactReceiptResult, artifactRequestHash, claimArtifactAction } from '../../chat/artifact-actions.js';
import {
  analyzeSchemaPlan,
  applySchemaPlan,
  planTouchesApps,
  schemaPlanApplySchema,
} from '../../platform/tables/schema-plan.js';
import { userHasFeature } from '../../auth/features.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

const aiStatusQuery = z.object({
  recordIds: z
    .string()
    .max(4000)
    .refine((value) => {
      if (value === '') return true;
      const ids = value.split(',');
      return (
        ids.length <= 200 && ids.every((id) => /^\d+$/.test(id) && Number.isSafeInteger(Number(id)) && Number(id) > 0)
      );
    }, 'recordIds must contain at most 200 positive IDs')
    .optional(),
});

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
    const confirm = (await jsonBody(c)).confirm === true;
    const result = await dispatch(c, 'archiveTable', { tableId, confirm }, { tableId });
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
    const confirm = (await jsonBody(c)).confirm === true;
    const result = await dispatch(c, 'archiveField', { fieldId, confirm }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { field: TableFieldRow });
  })
  // ─── AI fields (Phase 2 §2; queue-only writes) ───
  .post('/fields/:fieldId/ai/fill', async (c) => {
    const fieldId = numberParam(c, 'fieldId');
    const result = await dispatch(c, 'fillAiField', { fieldId }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableAiFieldRunResult);
  })
  .post('/fields/:fieldId/ai/regenerate', async (c) => {
    const fieldId = numberParam(c, 'fieldId');
    const result = await dispatch(c, 'regenerateAiField', { ...(await jsonBody(c)), fieldId }, { fieldId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableAiFieldRunResult);
  })
  .get(
    '/fields/:fieldId/ai/status',
    validator('query', (value, c) => {
      const parsed = aiStatusQuery.safeParse(value);
      return parsed.success ? parsed.data : c.json({ error: 'Invalid AI status query' }, 400);
    }),
    async (c) => {
      const fieldId = numberParam(c, 'fieldId');
      const ids = c.req.valid('query').recordIds;
      const recordIds = ids ? ids.split(',').map(Number) : [];
      const result = await dispatch(c, 'getAiFieldStatus', { fieldId, recordIds }, { fieldId });
      if (!result.ok) return actionError(c, result);
      return c.json(result.data as TableAiFieldStatusView);
    },
  )
  /**
   * The confirm gate behind `tables_schema_plan`. The tool only drafts; this is
   * where a plan becomes real, and it is reachable only with the user's own
   * bearer token — no model-facing surface can call it. Each operation is
   * re-authorized by its own runtime action, so a tampered plan can never
   * exceed what its sender could already do through the UI.
   *
   * `retry: true` re-runs only the operations of an applied plan that did not
   * apply (same action id, same operations), reusing the stored ref → id map:
   * nothing that applied is created twice. The receipt is re-armed with a CAS,
   * so two retries cannot run at once.
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
    const { operations, retry } = parsed.data;
    const shape = analyzeSchemaPlan(operations);
    if ('error' in shape) return c.json({ error: shape.error }, 400);
    const user = getAuthUser(c);
    // App operations are the Apps module's: this route sits behind the `tables` switch only.
    if (planTouchesApps(operations) && !(await userHasFeature(user.id, user.role, 'apps'))) {
      return c.json({ error: 'Apps are turned off for you — the plan was not applied' }, 403);
    }
    // A retry needs an applied plan; never claim a fresh id for one (that would strand the real apply).
    if (retry && !(await getDb().chatArtifactReceipts.getForUser(actionId, user.id))) {
      return c.json({ error: 'This plan has not been applied yet' }, 409);
    }
    const claim = await claimArtifactAction({
      actionId,
      sessionId,
      user,
      kind: 'tables_schema_plan',
      payload: operations,
    });
    if (!claim.ok) return c.json({ error: claim.error }, claim.status);

    let prior: SchemaPlanApplyResult | undefined;
    if (retry && !claim.claimed) {
      if (claim.receipt.status === 'processing') {
        return c.json({ error: 'This schema plan is already being applied; refresh to check it' }, 409);
      }
      const stored = artifactReceiptResult<SchemaPlanApplyResult>(claim.receipt);
      if (!stored?.refs) {
        return c.json({ error: 'This plan cannot be retried; ask for a new draft' }, 409);
      }
      if (stored.results.every((entry) => entry.status === 'applied')) return c.json(stored);
      const rearmed = await getDb().chatArtifactReceipts.claimRetry(actionId, user.id, artifactRequestHash(operations));
      if (!rearmed) return c.json({ error: 'This schema plan is already being applied; refresh to check it' }, 409);
      prior = stored;
    } else if (!claim.claimed) {
      const stored = artifactReceiptResult<SchemaPlanApplyResult>(claim.receipt);
      if (stored) return c.json(stored);
      return c.json(
        { error: claim.receipt.error ?? 'This schema plan is already being applied; refresh to check its receipt' },
        409,
      );
    }

    try {
      const applied = await applySchemaPlan(
        operations,
        (planActionId, payload, ids) => dispatch(c, planActionId, payload, ids),
        prior,
      );
      await getDb().chatArtifactReceipts.succeed(actionId, user.id, applied);
      return c.json(applied);
    } catch (error) {
      const message = toErrorMessage(error);
      if (prior) {
        // The stored result stays the truth about what applied; only this attempt failed.
        await getDb().chatArtifactReceipts.succeed(actionId, user.id, prior);
      } else {
        await getDb().chatArtifactReceipts.fail(actionId, user.id, message);
      }
      return c.json({ error: message }, 500);
    }
  });

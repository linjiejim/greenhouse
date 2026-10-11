/**
 * Tables · automation rules, runs and record buttons — mounted at /api/tables
 * (endpoint list in ./index.ts).
 *
 * This is the editor's route: the only place a person adds a webhook action or
 * sets / clears its secret (`secret: string | null` on the action; D16). Plan
 * operations and agent tools reach the same actions without that power.
 */

import { Hono } from 'hono';
import type { TableAutomationRuleView, TableAutomationRunRow } from '@greenhouse/db';
import type { TableRecordButton } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const automationRoutes = new Hono<AppEnv>()
  .get('/bases/:baseId/automations', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listAutomations', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automations: TableAutomationRuleView[] });
  })
  .post('/bases/:baseId/automations', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createAutomation', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automation: TableAutomationRuleView }, 201);
  })
  .patch('/automations/:automationId', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const result = await dispatch(c, 'updateAutomation', { ...(await jsonBody(c)), automationId }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automation: TableAutomationRuleView });
  })
  .delete('/automations/:automationId', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const result = await dispatch(c, 'deleteAutomation', { automationId }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { deleted: true });
  })
  .get('/automations/:automationId/runs', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listAutomationRuns', { automationId, limit }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { runs: TableAutomationRunRow[] });
  })
  .get('/tables/:tableId/records/:recordId/buttons', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(c, 'listRecordButtons', { tableId, recordId }, { recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { buttons: TableRecordButton[] });
  })
  .post('/automations/:automationId/trigger', async (c) => {
    const ruleId = numberParam(c, 'automationId');
    const body = await jsonBody(c);
    const recordId = typeof body.recordId === 'number' ? body.recordId : undefined;
    const result = await dispatch(c, 'triggerAutomation', { ...body, ruleId }, { recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { queued: true; duplicate: boolean }, 202);
  });

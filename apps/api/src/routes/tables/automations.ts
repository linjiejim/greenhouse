/**
 * Tables · automation rules and runs — mounted at /api/tables (endpoint list in ./index.ts).
 */

import { Hono } from 'hono';
import type { TableAutomationRuleRow, TableAutomationRunRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const automationRoutes = new Hono<AppEnv>()
  .get('/bases/:baseId/automations', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listAutomations', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automations: TableAutomationRuleRow[] });
  })
  .post('/bases/:baseId/automations', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createAutomation', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automation: TableAutomationRuleRow }, 201);
  })
  .patch('/automations/:automationId', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const result = await dispatch(c, 'updateAutomation', { ...(await jsonBody(c)), automationId }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { automation: TableAutomationRuleRow });
  })
  .get('/automations/:automationId/runs', async (c) => {
    const automationId = numberParam(c, 'automationId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listAutomationRuns', { automationId, limit }, { automationId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { runs: TableAutomationRunRow[] });
  });

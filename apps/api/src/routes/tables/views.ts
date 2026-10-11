/**
 * Tables · saved views — mounted at /api/tables (endpoint list in ./index.ts).
 */

import { Hono } from 'hono';
import type { TableViewRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const viewRoutes = new Hono<AppEnv>()
  .get('/tables/:tableId/views', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'listViews', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { views: TableViewRow[] });
  })
  .post('/tables/:tableId/views', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createView', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { view: TableViewRow }, 201);
  })
  .patch('/views/:viewId', async (c) => {
    const viewId = numberParam(c, 'viewId');
    const result = await dispatch(c, 'updateView', { ...(await jsonBody(c)), viewId }, { viewId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { view: TableViewRow });
  })
  .delete('/views/:viewId', async (c) => {
    const viewId = numberParam(c, 'viewId');
    const result = await dispatch(c, 'deleteView', { viewId }, { viewId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { view: TableViewRow });
  });

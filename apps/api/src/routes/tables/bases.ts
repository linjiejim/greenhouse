/**
 * Tables · Bases and members — mounted at /api/tables (endpoint list in ./index.ts).
 */

import { Hono } from 'hono';
import type {
  PlatformAuditEventRow,
  TableBaseMemberRow,
  TableBaseRow,
  TableDashboardRow,
  TableDefinitionRow,
  TableSchemaResult,
} from '@greenhouse/db';
import type { TableBaseAccessView } from '@greenhouse/types/table-access';
import type { TableBaseRole } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const baseRoutes = new Hono<AppEnv>()
  .get('/meta/users', async (c) => {
    const result = await dispatch(c, 'listAssignableUsers', {});
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        users: Array<{ id: string; nickname: string; email: string; role: 'team' | 'super' }>;
      },
    );
  })
  .get('/bases', async (c) => {
    const result = await dispatch(c, 'listBases', { search: c.req.query('search') || undefined });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        bases: Array<TableBaseRow & { role: TableBaseRole }>;
      },
    );
  })
  .post('/bases', async (c) => {
    const body = await jsonBody(c);
    const result = await dispatch(c, 'createBase', body);
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        base: TableBaseRow;
        role: 'owner';
        schema: TableSchemaResult;
      },
      201,
    );
  })
  .get('/bases/:baseId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'getBase', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        base: TableBaseRow;
        role: TableBaseRole;
        access: TableBaseAccessView;
        tables: TableDefinitionRow[];
        dashboards: TableDashboardRow[];
        members: TableBaseMemberRow[];
      },
    );
  })
  .patch('/bases/:baseId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'updateBase', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { base: TableBaseRow });
  })
  .post('/bases/:baseId/archive', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'archiveBase', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { base: TableBaseRow });
  })
  .get('/bases/:baseId/members', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listMembers', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { members: TableBaseMemberRow[] });
  })
  .get('/bases/:baseId/audit', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listBaseAudit', { baseId, limit }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { events: PlatformAuditEventRow[] });
  })
  .put('/bases/:baseId/members/:userId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const userId = c.req.param('userId');
    const result = await dispatch(
      c,
      'manageMembers',
      { ...(await jsonBody(c)), operation: 'upsert', baseId, userId },
      { baseId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { member: TableBaseMemberRow });
  })
  .delete('/bases/:baseId/members/:userId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const userId = c.req.param('userId');
    const result = await dispatch(c, 'manageMembers', { operation: 'remove', baseId, userId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  });

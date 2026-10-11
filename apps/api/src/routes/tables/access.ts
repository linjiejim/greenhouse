/**
 * Tables · Base access beyond people — mounted at /api/tables (endpoint list in ./index.ts):
 * custom roles, group grants and owner transfer. Person grants stay in ./bases.ts.
 */

import { Hono } from 'hono';
import type { TableBaseRow } from '@greenhouse/db';
import type {
  TableAccessSchemaFacts,
  TableBaseGroupMemberView,
  TableBaseRoleView,
  TableRoleReferences,
} from '@greenhouse/types/table-access';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const accessRoutes = new Hono<AppEnv>()
  .get('/bases/:baseId/roles', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'listRoles', { baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        roles: TableBaseRoleView[];
        references: Array<TableRoleReferences & { roleId: number }>;
        facts: TableAccessSchemaFacts;
      },
    );
  })
  .post('/bases/:baseId/roles', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'createRole', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { role: TableBaseRoleView }, 201);
  })
  .patch('/roles/:roleId', async (c) => {
    const roleId = numberParam(c, 'roleId');
    const result = await dispatch(c, 'updateRole', { ...(await jsonBody(c)), roleId }, { roleId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { role: TableBaseRoleView });
  })
  .delete('/roles/:roleId', async (c) => {
    const roleId = numberParam(c, 'roleId');
    const result = await dispatch(c, 'deleteRole', { roleId }, { roleId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  .put('/bases/:baseId/groups/:groupId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const groupId = numberParam(c, 'groupId');
    const result = await dispatch(
      c,
      'manageMembers',
      { ...(await jsonBody(c)), principal: 'group', operation: 'upsert', baseId, groupId },
      { baseId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { group: TableBaseGroupMemberView });
  })
  .delete('/bases/:baseId/groups/:groupId', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const groupId = numberParam(c, 'groupId');
    const result = await dispatch(
      c,
      'manageMembers',
      { principal: 'group', operation: 'remove', baseId, groupId },
      { baseId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { success: true });
  })
  .post('/bases/:baseId/transfer', async (c) => {
    const baseId = numberParam(c, 'baseId');
    const result = await dispatch(c, 'transferBaseOwner', { ...(await jsonBody(c)), baseId }, { baseId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { base: TableBaseRow });
  });

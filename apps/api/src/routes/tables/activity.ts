/**
 * Tables · a record's activity (history + comments) — mounted at /api/tables
 * (endpoint list in ./index.ts). Every endpoint dispatches; access, scopes and
 * mention notifications live in `platform/tables/handlers/activity.ts`.
 */

import { Hono } from 'hono';
import type { TableRecordActivityPage, TableRecordCommentView } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const activityRoutes = new Hono<AppEnv>()
  .get('/tables/:tableId/records/:recordId/activity', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const cursor = c.req.query('cursor') || undefined;
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listRecordActivity', { tableId, recordId, cursor, limit }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableRecordActivityPage);
  })
  .post('/tables/:tableId/records/:recordId/comments', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const { body } = await jsonBody(c);
    const result = await dispatch(c, 'createComment', { tableId, recordId, body }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { comment: TableRecordCommentView }, 201);
  })
  .patch('/comments/:commentId', async (c) => {
    const commentId = numberParam(c, 'commentId');
    const { body } = await jsonBody(c);
    const result = await dispatch(c, 'updateComment', { commentId, body }, { commentId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { comment: TableRecordCommentView });
  })
  .delete('/comments/:commentId', async (c) => {
    const commentId = numberParam(c, 'commentId');
    const result = await dispatch(c, 'deleteComment', { commentId }, { commentId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { deleted: true; commentId: number });
  });

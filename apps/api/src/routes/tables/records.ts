/**
 * Tables · records — mounted at /api/tables (endpoint list in ./index.ts).
 *
 * Order matters: `/records/deleted` is registered before `/records/:recordId`,
 * otherwise `deleted` is read as a record id.
 */

import { Hono } from 'hono';
import type { TableRecordQueryResult, TableRecordRow } from '@greenhouse/db';
import type { TableAggregateRow, TableBatchValidationResult } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const recordRoutes = new Hono<AppEnv>()
  .post('/tables/:tableId/records/query', async (c) => {
    const tableId = numberParam(c, 'tableId');
    // The body is the query plus the viewer's `timezone` (date tokens and days resolve there).
    const { timezone, ...query } = await jsonBody(c);
    const result = await dispatch(c, 'queryRecords', { tableId, query, timezone }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableRecordQueryResult);
  })
  .post('/tables/:tableId/records/aggregate', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'aggregateRecords', { tableId, input: await jsonBody(c) }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { rows: TableAggregateRow[] });
  })
  .post('/tables/:tableId/records', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createRecord', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow }, 201);
  })
  .get('/tables/:tableId/records/deleted', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const limit = Number(c.req.query('limit')) || undefined;
    const result = await dispatch(c, 'listDeletedRecords', { tableId, limit }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { records: TableRecordRow[] });
  })
  .post('/tables/:tableId/records/:recordId/restore', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(c, 'restoreRecord', { tableId, recordId }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .get('/tables/:tableId/records/:recordId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(c, 'getRecord', { tableId, recordId }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .patch('/tables/:tableId/records/:recordId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const result = await dispatch(
      c,
      'updateRecord',
      { ...(await jsonBody(c)), tableId, recordId },
      { tableId, recordId },
    );
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  })
  .post('/tables/:tableId/records/batch-upsert', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'batchUpsertRecords', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(
      result.data as {
        results: Array<
          | { index: number; ok: true; record: TableRecordRow }
          | {
              index: number;
              ok: false;
              reason: 'not_found' | 'conflict' | 'invalid';
              message?: string;
              current?: number;
            }
        >;
      },
    );
  })
  .post('/tables/:tableId/records/batch-validate', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'validateBatchRecords', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { results: TableBatchValidationResult[] });
  })
  .delete('/tables/:tableId/records/:recordId', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const recordId = numberParam(c, 'recordId');
    const revision = Number(c.req.query('revision'));
    const result = await dispatch(c, 'deleteRecord', { tableId, recordId, revision }, { tableId, recordId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow });
  });

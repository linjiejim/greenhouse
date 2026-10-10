/**
 * Tables · forms as Base members build and submit them — mounted at /api/tables
 * (endpoint list in ./index.ts). The submit-only surface for audiences outside
 * the Base is `/api/forms` (routes/forms.ts), not behind the `tables` flag.
 */

import { Hono } from 'hono';
import type { TableFieldRow, TableFormRow, TableRecordRow } from '@greenhouse/db';
import type { AppEnv } from '../../app-env.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

export const formRoutes = new Hono<AppEnv>()
  .get('/tables/:tableId/forms', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'listForms', { tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { forms: TableFormRow[] });
  })
  .post('/tables/:tableId/forms', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const result = await dispatch(c, 'createForm', { ...(await jsonBody(c)), tableId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormRow }, 201);
  })
  .get('/forms/:formId', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'getForm', { formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormRow; fields: TableFieldRow[] });
  })
  .patch('/forms/:formId', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'updateForm', { ...(await jsonBody(c)), formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { form: TableFormRow });
  })
  .post('/forms/:formId/submit', async (c) => {
    const formId = numberParam(c, 'formId');
    const result = await dispatch(c, 'submitForm', { ...(await jsonBody(c)), formId }, { formId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as { record: TableRecordRow }, 201);
  });

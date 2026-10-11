/**
 * Tables · CSV / Excel import — mounted at /api/tables (endpoint list in ./index.ts).
 *
 * The upload is multipart (field `file`, ≤ 10 MB, cut at the socket by
 * `bodyLimit`); the dry run and the commit are JSON. All three dispatch the
 * `previewImport` / `commitImport` actions; nothing here decides access.
 */

import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { TableImportPreview, TableImportProgress, TableImportValidation } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import { IMPORT_FILE_MAX_BYTES } from '../../platform/tables/import-file.js';
import { actionError, dispatch, jsonBody, numberParam } from './shared.js';

const TOO_LARGE = 'The file is larger than 10 MB';

export const importRoutes = new Hono<AppEnv>()
  .post(
    '/tables/:tableId/imports',
    // Headroom for the multipart framing around the file itself.
    bodyLimit({ maxSize: IMPORT_FILE_MAX_BYTES + 256 * 1024, onError: (c) => c.json({ error: TOO_LARGE }, 413) }),
    async (c) => {
      const tableId = numberParam(c, 'tableId');
      const form = await c.req.parseBody().catch(() => null);
      const file = form?.['file'];
      if (!(file instanceof File)) return c.json({ error: 'multipart field "file" is required' }, 400);
      if (file.size > IMPORT_FILE_MAX_BYTES) return c.json({ error: TOO_LARGE }, 413);
      const result = await dispatch(
        c,
        'previewImport',
        {
          tableId,
          file: {
            name: file.name || 'import',
            contentType: file.type,
            bytes: new Uint8Array(await file.arrayBuffer()),
          },
        },
        { tableId },
      );
      if (!result.ok) return actionError(c, result);
      return c.json(result.data as TableImportPreview, 201);
    },
  )
  .post('/tables/:tableId/imports/:importId/validate', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const importId = c.req.param('importId');
    const result = await dispatch(c, 'previewImport', { ...(await jsonBody(c)), tableId, importId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableImportValidation);
  })
  .post('/tables/:tableId/imports/:importId/commit', async (c) => {
    const tableId = numberParam(c, 'tableId');
    const importId = c.req.param('importId');
    const result = await dispatch(c, 'commitImport', { ...(await jsonBody(c)), tableId, importId }, { tableId });
    if (!result.ok) return actionError(c, result);
    return c.json(result.data as TableImportProgress);
  });

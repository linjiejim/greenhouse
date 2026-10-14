/**
 * POST   /api/tables/tables/:id/imports              a CSV file for the table (multipart `file`, up to 20 MB; editors): a draft
 * GET    /api/tables/tables/:id/imports?cursor=&limit=   my imports into the table, newest first
 * GET    /api/tables/imports/:id                     one of my imports: mapping, progress, result
 * PATCH  /api/tables/imports/:id                     a draft's mapping and whether its first row is the header
 * POST   /api/tables/imports/:id/start               queue a draft
 * POST   /api/tables/imports/:id/cancel              stop it at its next batch (the rows written stay)
 */

import { Hono } from 'hono';
import { MAX_IMPORT_BYTES, idParamSchema, pageQuerySchema, updateImportInputSchema } from '@greenhouse/contract';
import { invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import { uploadLimit } from '../files/routes.js';
import { tooLarge, type ImportsPart } from './imports.js';

/** Multipart overhead on top of the file itself. */
const FORM_SLACK_BYTES = 64 * 1024;

export function importsRoutes(part: ImportsPart) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  return new Hono<AppEnv>()
    .post(
      '/tables/:id/imports',
      // Who may import is settled before any of the body is read.
      async (c, next) => {
        await part.canImport(c.get('member').id, id(c));
        await next();
      },
      uploadLimit,
      async (c) => {
        if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
          throw invalidInput('Upload the file as multipart/form-data.');
        }
        if (Number(c.req.header('content-length') ?? 0) > MAX_IMPORT_BYTES + FORM_SLACK_BYTES) throw tooLarge();
        const form = await c.req.parseBody();
        const file = form.file;
        if (!(file instanceof File)) throw invalidInput('Add the file in the `file` field.');
        if (file.size > MAX_IMPORT_BYTES) throw tooLarge();
        const made = await part.upload(c.get('member').id, id(c), {
          name: file.name,
          bytes: new Uint8Array(await file.arrayBuffer()),
        });
        return c.json(made, 201);
      },
    )
    .get('/tables/:id/imports', async (c) =>
      c.json(await part.list(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .get('/imports/:id', async (c) => c.json(await part.get(c.get('member').id, id(c))))
    .patch('/imports/:id', async (c) =>
      c.json(await part.update(c.get('member').id, id(c), await readJson(c, updateImportInputSchema))),
    )
    .post('/imports/:id/start', async (c) => c.json(await part.start(c.get('member').id, id(c))))
    .post('/imports/:id/cancel', async (c) => c.json(await part.cancel(c.get('member').id, id(c))));
}

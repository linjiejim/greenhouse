/**
 * Routes of forms.ts, mounted at /api/tables:
 * GET    /api/tables/tables/:id/forms                       the data table's forms (builders)
 * POST   /api/tables/tables/:id/forms                       a draft form; without settings it asks for the table's fields (builders)
 * GET    /api/tables/forms/:id                              the form with its fields and settings (builders)
 * PATCH  /api/tables/forms/:id                              rename, describe, fields and settings, with its revision (builders)
 * DELETE /api/tables/forms/:id                              delete it with its submissions; the records stay (builders)
 * POST   /api/tables/forms/:id/publish                      start taking submissions (builders)
 * POST   /api/tables/forms/:id/unpublish                    stop taking submissions (builders)
 * GET    /api/tables/forms/:id/share                        who may submit (builders)
 * PUT    /api/tables/forms/:id/share                        replace who may submit: members, groups, everyone (builders)
 * GET    /api/tables/forms/:id/submissions?cursor=&limit=   submissions, newest first (editors)
 * GET    /api/tables/forms/:id/fill                         what I fill in (who may submit; builders also a draft)
 * POST   /api/tables/forms/:id/files                        a file for an attachment field (multipart `file`, who may submit)
 * POST   /api/tables/forms/:id/submissions                  submit: one record from the form's fields (who may submit)
 */

import { Hono, type MiddlewareHandler } from 'hono';
import {
  createFormInputSchema,
  formShareInputSchema,
  idParamSchema,
  pageQuerySchema,
  submitFormInputSchema,
  updateFormInputSchema,
} from '@greenhouse/contract';
import { invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import { uploadLimit } from '../files/routes.js';
import type { FormsPart } from './forms.js';

type UploadEnv = AppEnv & { Variables: { store: Awaited<ReturnType<FormsPart['uploader']>> } };

export function formsRoutes(part: FormsPart) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  /**
   * Who may submit is settled before uploadLimit reads the body (without a length it reads it
   * all first): nobody else gets to send 50 MB here.
   */
  const mayUpload: MiddlewareHandler<UploadEnv> = async (c, next) => {
    c.set('store', await part.uploader(c.get('member').id, id(c)));
    await next();
  };
  return new Hono<AppEnv>()
    .get('/tables/:id/forms', async (c) => c.json(await part.list(c.get('member').id, id(c))))
    .post('/tables/:id/forms', async (c) =>
      c.json(await part.create(c.get('member').id, id(c), await readJson(c, createFormInputSchema)), 201),
    )
    .get('/forms/:id', async (c) => c.json(await part.get(c.get('member').id, id(c))))
    .patch('/forms/:id', async (c) =>
      c.json(await part.update(c.get('member').id, id(c), await readJson(c, updateFormInputSchema))),
    )
    .delete('/forms/:id', async (c) => {
      await part.remove(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/forms/:id/publish', async (c) => c.json(await part.publish(c.get('member').id, id(c))))
    .post('/forms/:id/unpublish', async (c) => c.json(await part.unpublish(c.get('member').id, id(c))))
    .get('/forms/:id/share', async (c) => c.json(await part.shares(c.get('member').id, id(c))))
    .put('/forms/:id/share', async (c) =>
      c.json(await part.share(c.get('member').id, id(c), await readJson(c, formShareInputSchema))),
    )
    .get('/forms/:id/submissions', async (c) =>
      c.json(await part.submissions(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .get('/forms/:id/fill', async (c) => c.json(await part.fill(c.get('member').id, id(c))))
    .post('/forms/:id/files', mayUpload, uploadLimit, async (c) => {
      if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
        throw invalidInput('Upload the file as multipart/form-data.');
      }
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw invalidInput('Add the file in the `file` field.');
      const stored = await c.get('store')({
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return c.json(stored, 201);
    })
    .post('/forms/:id/submissions', async (c) => {
      const { values } = await readJson(c, submitFormInputSchema);
      return c.json(await part.submit(c.get('member').id, id(c), values), 201);
    });
}

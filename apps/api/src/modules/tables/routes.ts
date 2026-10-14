/**
 * GET    /api/tables/bases?archived=                       my bases and those shared with me (archived: the ones I own)
 * POST   /api/tables/bases                                 a blank base, or one from a template (`project`)
 * GET    /api/tables/bases/:id                             the base: data tables, fields, the views I see, my access
 * PATCH  /api/tables/bases/:id                             rename, describe (builders); pin for me (anyone)
 * POST   /api/tables/bases/:id/archive                     archive (owners)
 * POST   /api/tables/bases/:id/restore                     restore (owners)
 * POST   /api/tables/bases/:id/delete                      delete for good: `{ name }` typed again (owners)
 * GET    /api/tables/bases/:id/share                       its owner and shares
 * PUT    /api/tables/bases/:id/share                       replace its shares (owners)
 * GET    /api/tables/bases/:id/trash?cursor=&limit=        deleted records, fields and data tables (editors)
 * GET    /api/tables/bases/:id/audit?cursor=&limit=        shares, archives, deletions (owners)
 * POST   /api/tables/bases/:id/files                       upload for an attachment field (multipart `file`, editors)
 * POST   /api/tables/bases/:id/tables                      a data table with its primary field and a grid (builders)
 * PATCH  /api/tables/tables/:id                            rename, describe, reorder (builders)
 * DELETE /api/tables/tables/:id                            to the recycle bin (builders)
 * POST   /api/tables/tables/:id/restore                    back from the recycle bin (builders)
 * POST   /api/tables/tables/:id/purge                      delete for good, with its records (builders)
 * GET    /api/tables/tables/:id/titles?q=&limit=           record titles for pickers
 * GET    /api/tables/tables/:id/export?view_id=            CSV of a view, or of the whole table
 * POST   /api/tables/tables/:id/fields                     a field (builders)
 * POST   /api/tables/tables/:id/views                      a personal view, or a shared one (builders)
 * POST   /api/tables/tables/:id/records/query              records that match a filter, in order (cursor pages)
 * POST   /api/tables/tables/:id/records                    a record (editors)
 * POST   /api/tables/tables/:id/records/bulk               many changes and new records at once: a paste (editors)
 * POST   /api/tables/tables/:id/records/delete             records to the recycle bin (editors)
 * PATCH  /api/tables/fields/:id                            rename, settings, required, place, type (builders)
 * DELETE /api/tables/fields/:id                            to the recycle bin (builders)
 * POST   /api/tables/fields/:id/restore                    back from the recycle bin (builders)
 * POST   /api/tables/fields/:id/purge                      delete for good, with its values (builders)
 * PATCH  /api/tables/views/:id                             rename, settings, place (my personal view; builders for shared)
 * DELETE /api/tables/views/:id                             delete a view (same)
 * GET    /api/tables/records/:id                           a record with its links, files and children
 * PATCH  /api/tables/records/:id                           change it, with the revision it is based on (editors)
 * DELETE /api/tables/records/:id                           to the recycle bin (editors)
 * POST   /api/tables/records/:id/restore                   back from the recycle bin (editors)
 * POST   /api/tables/records/:id/purge                     delete for good (builders)
 * GET    /api/tables/records/:id/activity?cursor=&limit=   comments and changes, newest first
 * POST   /api/tables/records/:id/comments                  comment (anyone who reads it); mentions are told
 * PATCH  /api/tables/records/:id/comments/:commentId       edit my comment
 * DELETE /api/tables/records/:id/comments/:commentId       delete my comment (owners: any)
 */

import { Hono } from 'hono';
import {
  baseListQuerySchema,
  baseShareInputSchema,
  bulkRecordsInputSchema,
  commentInputSchema,
  createBaseInputSchema,
  createFieldInputSchema,
  createRecordInputSchema,
  createTableInputSchema,
  createViewInputSchema,
  deleteBaseInputSchema,
  idParamSchema,
  pageQuerySchema,
  recordIdsInputSchema,
  recordsQuerySchema,
  titlesQuerySchema,
  updateBaseInputSchema,
  updateFieldInputSchema,
  updateRecordInputSchema,
  updateTableInputSchema,
  updateViewInputSchema,
} from '@greenhouse/contract';
import { z } from 'zod';
import { invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import { dispositionFor, MAX_UPLOAD_BYTES } from '../files/service.js';
import type { TablesService } from './service.js';

/** Multipart overhead on top of the file itself. */
const FORM_SLACK_BYTES = 64 * 1024;
const exportQuerySchema = z.object({ view_id: idParamSchema.optional() });

export function tablesRoutes(service: TablesService) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  const records = service.records;
  return new Hono<AppEnv>()
    .get('/bases', async (c) =>
      c.json(
        await service.list(c.get('member').id, { archived: readQuery(c, baseListQuerySchema).archived === 'true' }),
      ),
    )
    .post('/bases', async (c) =>
      c.json(await service.create(c.get('member').id, await readJson(c, createBaseInputSchema)), 201),
    )
    .get('/bases/:id', async (c) => c.json(await service.get(c.get('member').id, id(c))))
    .patch('/bases/:id', async (c) =>
      c.json(await service.update(c.get('member').id, id(c), await readJson(c, updateBaseInputSchema))),
    )
    .post('/bases/:id/archive', async (c) => c.json(await service.archive(c.get('member').id, id(c))))
    .post('/bases/:id/restore', async (c) => c.json(await service.restore(c.get('member').id, id(c))))
    .post('/bases/:id/delete', async (c) => {
      const { name } = await readJson(c, deleteBaseInputSchema);
      await service.remove(c.get('member').id, id(c), name);
      return c.body(null, 204);
    })
    .get('/bases/:id/share', async (c) => c.json(await service.shares(c.get('member').id, id(c))))
    .put('/bases/:id/share', async (c) =>
      c.json(await service.share(c.get('member').id, id(c), await readJson(c, baseShareInputSchema))),
    )
    .get('/bases/:id/trash', async (c) =>
      c.json(await service.trash(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .get('/bases/:id/audit', async (c) =>
      c.json(await service.auditLog(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .post('/bases/:id/files', async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES + FORM_SLACK_BYTES) throw invalidInput('Files can be up to 50 MB.');
      if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
        throw invalidInput('Upload the file as multipart/form-data.');
      }
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw invalidInput('Add the file in the `file` field.');
      const stored = await service.upload(c.get('member').id, id(c), {
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return c.json(stored, 201);
    })
    .post('/bases/:id/tables', async (c) => {
      const { name } = await readJson(c, createTableInputSchema);
      return c.json(await service.createTable(c.get('member').id, id(c), name), 201);
    })
    .patch('/tables/:id', async (c) =>
      c.json(await service.updateTable(c.get('member').id, id(c), await readJson(c, updateTableInputSchema))),
    )
    .delete('/tables/:id', async (c) => {
      await service.archiveTable(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/tables/:id/restore', async (c) => c.json(await service.restoreTable(c.get('member').id, id(c))))
    .post('/tables/:id/purge', async (c) => {
      await service.purgeTable(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .get('/tables/:id/titles', async (c) =>
      c.json(await records.titles(c.get('member').id, id(c), readQuery(c, titlesQuerySchema))),
    )
    .get('/tables/:id/export', async (c) => {
      const { view_id } = readQuery(c, exportQuerySchema);
      const { filename, body } = await service.exportCsv(c.get('member').id, id(c), view_id);
      return new Response(body, {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': dispositionFor({ name: filename, contentType: 'application/octet-stream' })
            .disposition,
          'cache-control': 'no-store',
        },
      });
    })
    .post('/tables/:id/fields', async (c) =>
      c.json(await service.createField(c.get('member').id, id(c), await readJson(c, createFieldInputSchema)), 201),
    )
    .post('/tables/:id/views', async (c) =>
      c.json(await service.createView(c.get('member').id, id(c), await readJson(c, createViewInputSchema)), 201),
    )
    .post('/tables/:id/records/query', async (c) =>
      c.json(await records.query(c.get('member').id, id(c), await readJson(c, recordsQuerySchema))),
    )
    .post('/tables/:id/records', async (c) => {
      const { values } = await readJson(c, createRecordInputSchema);
      return c.json(await records.create(c.get('member').id, id(c), values), 201);
    })
    .post('/tables/:id/records/bulk', async (c) =>
      c.json(await records.bulk(c.get('member').id, id(c), await readJson(c, bulkRecordsInputSchema))),
    )
    .post('/tables/:id/records/delete', async (c) => {
      const { ids } = await readJson(c, recordIdsInputSchema);
      return c.json({ deleted: await records.removeMany(c.get('member').id, id(c), ids) });
    })
    .patch('/fields/:id', async (c) =>
      c.json(await service.updateField(c.get('member').id, id(c), await readJson(c, updateFieldInputSchema))),
    )
    .delete('/fields/:id', async (c) => {
      await service.archiveField(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/fields/:id/restore', async (c) => c.json(await service.restoreField(c.get('member').id, id(c))))
    .post('/fields/:id/purge', async (c) => {
      await service.purgeField(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .patch('/views/:id', async (c) =>
      c.json(await service.updateView(c.get('member').id, id(c), await readJson(c, updateViewInputSchema))),
    )
    .delete('/views/:id', async (c) => {
      await service.removeView(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .get('/records/:id', async (c) => c.json(await records.get(c.get('member').id, id(c))))
    .patch('/records/:id', async (c) => {
      const { revision, values } = await readJson(c, updateRecordInputSchema);
      return c.json(await records.update(c.get('member').id, id(c), revision, values));
    })
    .delete('/records/:id', async (c) => {
      await records.remove(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/records/:id/restore', async (c) => c.json(await records.restore(c.get('member').id, id(c))))
    .post('/records/:id/purge', async (c) => {
      await records.purge(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .get('/records/:id/activity', async (c) =>
      c.json(await records.activity(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .post('/records/:id/comments', async (c) => {
      const { body } = await readJson(c, commentInputSchema);
      return c.json(await records.addComment(c.get('member').id, id(c), body), 201);
    })
    .patch('/records/:id/comments/:commentId', async (c) => {
      const { body } = await readJson(c, commentInputSchema);
      return c.json(
        await records.editComment(c.get('member').id, id(c), readParam(c, 'commentId', idParamSchema), body),
      );
    })
    .delete('/records/:id/comments/:commentId', async (c) => {
      await records.removeComment(c.get('member').id, id(c), readParam(c, 'commentId', idParamSchema));
      return c.body(null, 204);
    });
}

/**
 * GET    /api/knowledge/search?q=&space=&folder_id=&limit=   full text over what I may read, best first, with snippets
 * GET    /api/knowledge/archived?space=team|personal         what was archived, topmost first
 * POST   /api/knowledge/reorder                              hand order for items of one folder (or a space root)
 * GET    /api/knowledge/export?space=team|personal           a whole space as a ZIP
 * GET    /api/knowledge/folders?space=team|personal|shared   the root of a space, or the topmost items shared with me
 * POST   /api/knowledge/folders                              a folder in a folder or at the root of a space
 * GET    /api/knowledge/folders/:id                          the folder, its path and what is in it
 * PATCH  /api/knowledge/folders/:id                          rename or move (never into itself)
 * DELETE /api/knowledge/folders/:id                          archive it and everything in it
 * POST   /api/knowledge/folders/:id/restore                  bring back what was archived with it
 * GET    /api/knowledge/folders/:id/share                    its shares and those from above
 * PUT    /api/knowledge/folders/:id/share                    replace its shares (the owner of a personal folder)
 * GET    /api/knowledge/folders/:id/export                   the folder as a ZIP of Markdown and files
 * GET    /api/knowledge/docs?space=&template=&cursor=        recently updated docs I may read
 * POST   /api/knowledge/docs                                 a doc, blank or from a template
 * GET    /api/knowledge/docs/:id                             the doc; file links signed for me
 * PATCH  /api/knowledge/docs/:id                             save (with the version it is based on), retag, move
 * DELETE /api/knowledge/docs/:id                             archive
 * POST   /api/knowledge/docs/:id/restore                     restore
 * GET    /api/knowledge/docs/:id/versions                    every save, newest first
 * GET    /api/knowledge/docs/:id/versions/:version           one version with its content
 * POST   /api/knowledge/docs/:id/versions/:version/restore   a new version with that one's content
 * GET    /api/knowledge/docs/:id/diff?from=&to=&mode=        compare two versions by line or word
 * GET    /api/knowledge/docs/:id/backlinks                   docs that link here, as far as I may read them
 * GET    /api/knowledge/docs/:id/comments                    comments, oldest first
 * POST   /api/knowledge/docs/:id/comments                    comment; mentions are told
 * PATCH  /api/knowledge/docs/:id/comments/:commentId         edit my comment
 * DELETE /api/knowledge/docs/:id/comments/:commentId         delete my comment
 * GET    /api/knowledge/docs/:id/share                       its shares and those from above
 * PUT    /api/knowledge/docs/:id/share                       replace its shares (the owner of a personal doc)
 * GET    /api/knowledge/docs/:id/presence                    who has it open, who is editing
 * PUT    /api/knowledge/docs/:id/presence                    heartbeat: viewing or editing
 * DELETE /api/knowledge/docs/:id/presence                    I closed it
 * GET    /api/knowledge/docs/:id/export                      the doc as a Markdown file
 * POST   /api/knowledge/files                                upload (multipart: `file`, and `folder_id`, `space` or `doc_id`)
 * GET    /api/knowledge/files/:id                            what it is, how to preview it, a signed URL for me
 * PATCH  /api/knowledge/files/:id                            rename or move
 * DELETE /api/knowledge/files/:id                            archive
 * POST   /api/knowledge/files/:id/restore                    restore
 */

import { Hono } from 'hono';
import { z } from 'zod';
import {
  commentInputSchema,
  createDocInputSchema,
  createFolderInputSchema,
  diffQuerySchema,
  docListQuerySchema,
  idParamSchema,
  knowledgeSearchQuerySchema,
  knowledgeUploadFieldsSchema,
  pageQuerySchema,
  presenceInputSchema,
  reorderInputSchema,
  restoreVersionInputSchema,
  rootQuerySchema,
  shareInputSchema,
  spaceQuerySchema,
  updateDocInputSchema,
  updateFileInputSchema,
  updateFolderInputSchema,
} from '@greenhouse/contract';
import { invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import { dispositionFor, MAX_UPLOAD_BYTES } from '../files/service.js';
import type { KnowledgeService } from './service.js';

/** Multipart overhead on top of the file itself. */
const FORM_SLACK_BYTES = 64 * 1024;
const versionParam = z.coerce.number().int().positive();

function attachment(body: ReadableStream<Uint8Array> | string, filename: string, contentType: string) {
  return new Response(body, {
    headers: {
      'content-type': contentType,
      'content-disposition': dispositionFor({ name: filename, contentType: 'application/octet-stream' }).disposition,
      'cache-control': 'no-store',
    },
  });
}

export function knowledgeRoutes(service: KnowledgeService) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  return new Hono<AppEnv>()
    .get('/search', async (c) =>
      c.json(await service.search(c.get('member').id, readQuery(c, knowledgeSearchQuerySchema))),
    )
    .get('/archived', async (c) =>
      c.json(await service.archived(c.get('member').id, readQuery(c, spaceQuerySchema).space)),
    )
    .post('/reorder', async (c) => {
      await service.reorder(c.get('member').id, await readJson(c, reorderInputSchema));
      return c.body(null, 204);
    })
    .get('/export', async (c) => {
      const { space } = readQuery(c, spaceQuerySchema);
      const { filename, body } = await service.exportTree(c.get('member').id, { space });
      return attachment(body, filename, 'application/zip');
    })
    .get('/folders', async (c) => c.json(await service.roots(c.get('member').id, readQuery(c, rootQuerySchema).space)))
    .post('/folders', async (c) =>
      c.json(await service.createFolder(c.get('member').id, await readJson(c, createFolderInputSchema)), 201),
    )
    .get('/folders/:id', async (c) => c.json(await service.folder(c.get('member').id, id(c))))
    .patch('/folders/:id', async (c) =>
      c.json(await service.updateFolder(c.get('member').id, id(c), await readJson(c, updateFolderInputSchema))),
    )
    .delete('/folders/:id', async (c) => {
      await service.archiveFolder(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/folders/:id/restore', async (c) => c.json(await service.restoreFolder(c.get('member').id, id(c))))
    .get('/folders/:id/share', async (c) => c.json(await service.shares(c.get('member').id, 'folder', id(c))))
    .put('/folders/:id/share', async (c) =>
      c.json(await service.share(c.get('member').id, 'folder', id(c), await readJson(c, shareInputSchema))),
    )
    .get('/folders/:id/export', async (c) => {
      const { filename, body } = await service.exportTree(c.get('member').id, { folderId: id(c) });
      return attachment(body, filename, 'application/zip');
    })
    .get('/docs', async (c) => c.json(await service.listDocs(c.get('member').id, readQuery(c, docListQuerySchema))))
    .post('/docs', async (c) =>
      c.json(await service.createDoc(c.get('member').id, await readJson(c, createDocInputSchema)), 201),
    )
    .get('/docs/:id', async (c) => c.json(await service.getDoc(c.get('member').id, id(c))))
    .patch('/docs/:id', async (c) =>
      c.json(await service.updateDoc(c.get('member').id, id(c), await readJson(c, updateDocInputSchema))),
    )
    .delete('/docs/:id', async (c) => {
      await service.archiveDoc(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/docs/:id/restore', async (c) => c.json(await service.restoreDoc(c.get('member').id, id(c))))
    .get('/docs/:id/versions', async (c) =>
      c.json(await service.versions(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .get('/docs/:id/versions/:version', async (c) =>
      c.json(await service.version(c.get('member').id, id(c), readParam(c, 'version', versionParam))),
    )
    .post('/docs/:id/versions/:version/restore', async (c) => {
      const { version } = await readJson(c, restoreVersionInputSchema);
      return c.json(
        await service.restoreVersion(c.get('member').id, id(c), readParam(c, 'version', versionParam), version),
      );
    })
    .get('/docs/:id/diff', async (c) =>
      c.json(await service.diff(c.get('member').id, id(c), readQuery(c, diffQuerySchema))),
    )
    .get('/docs/:id/backlinks', async (c) => c.json(await service.backlinks(c.get('member').id, id(c))))
    .get('/docs/:id/comments', async (c) =>
      c.json(await service.comments(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .post('/docs/:id/comments', async (c) => {
      const { body } = await readJson(c, commentInputSchema);
      return c.json(await service.addComment(c.get('member').id, id(c), body), 201);
    })
    .patch('/docs/:id/comments/:commentId', async (c) => {
      const { body } = await readJson(c, commentInputSchema);
      return c.json(
        await service.editComment(c.get('member').id, id(c), readParam(c, 'commentId', idParamSchema), body),
      );
    })
    .delete('/docs/:id/comments/:commentId', async (c) => {
      await service.removeComment(c.get('member').id, id(c), readParam(c, 'commentId', idParamSchema));
      return c.body(null, 204);
    })
    .get('/docs/:id/share', async (c) => c.json(await service.shares(c.get('member').id, 'doc', id(c))))
    .put('/docs/:id/share', async (c) =>
      c.json(await service.share(c.get('member').id, 'doc', id(c), await readJson(c, shareInputSchema))),
    )
    .get('/docs/:id/presence', async (c) => c.json(await service.presence(c.get('member').id, id(c))))
    .put('/docs/:id/presence', async (c) => {
      const { state } = await readJson(c, presenceInputSchema);
      return c.json(await service.beat(c.get('member').id, id(c), state));
    })
    .delete('/docs/:id/presence', (c) => {
      service.leave(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .get('/docs/:id/export', async (c) => {
      const { filename, markdown } = await service.exportDoc(c.get('member').id, id(c));
      return attachment(markdown, filename, 'text/markdown; charset=utf-8');
    })
    .post('/files', async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES + FORM_SLACK_BYTES) throw invalidInput('Files can be up to 50 MB.');
      if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
        throw invalidInput('Upload the file as multipart/form-data.');
      }
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw invalidInput('Add the file in the `file` field.');
      const text = (name: string) => (typeof form[name] === 'string' && form[name] ? form[name] : undefined);
      const fields = knowledgeUploadFieldsSchema.safeParse({
        folder_id: text('folder_id'),
        space: text('space'),
        doc_id: text('doc_id'),
      });
      if (!fields.success) throw invalidInput('Some fields are invalid.');
      const stored = await service.upload(c.get('member').id, {
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
        folderId: fields.data.folder_id,
        space: fields.data.space,
        docId: fields.data.doc_id,
      });
      return c.json(stored, 201);
    })
    .get('/files/:id', async (c) => c.json(await service.file(c.get('member').id, id(c))))
    .patch('/files/:id', async (c) =>
      c.json(await service.updateFile(c.get('member').id, id(c), await readJson(c, updateFileInputSchema))),
    )
    .delete('/files/:id', async (c) => {
      await service.archiveFile(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .post('/files/:id/restore', async (c) => c.json(await service.restoreFile(c.get('member').id, id(c))));
}

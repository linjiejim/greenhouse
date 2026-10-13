/**
 * POST   /api/files               upload (multipart: `file`, `purpose`, optional `conversation_id`); branding is for admins
 * GET    /api/files/:id           what it is, with a fresh signed URL for me
 * DELETE /api/files/:id           delete my file
 *
 * Public, authorised by the URL's signature instead of a bearer header (fileContentRoutes):
 * GET    /api/files/:id/content?exp=&m=&sig=   the bytes; pages and SVG always download
 */

import { Hono } from 'hono';
import { fileContentQuerySchema, idParamSchema, uploadFieldsSchema } from '@greenhouse/contract';
import { forbidden, invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readParam, readQuery } from '../../http/validate.js';
import { dispositionFor, MAX_UPLOAD_BYTES, type FilesService } from './service.js';
import type { ConversationsService } from '../conversations/service.js';

/** Multipart overhead on top of the file itself. */
const FORM_SLACK_BYTES = 64 * 1024;

export function fileRoutes(service: FilesService, conversations: ConversationsService) {
  return new Hono<AppEnv>()
    .post('/', async (c) => {
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES + FORM_SLACK_BYTES) throw invalidInput('Files can be up to 50 MB.');
      if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
        throw invalidInput('Upload the file as multipart/form-data.');
      }
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw invalidInput('Add the file in the `file` field.');
      const fields = uploadFieldsSchema.safeParse({
        purpose: typeof form.purpose === 'string' ? form.purpose : undefined,
        conversation_id:
          typeof form.conversation_id === 'string' && form.conversation_id ? form.conversation_id : undefined,
      });
      if (!fields.success) throw invalidInput('Some fields are invalid.');
      const member = c.get('member');
      if (fields.data.purpose === 'branding' && member.role !== 'admin')
        throw forbidden('Only admins can upload a logo.');
      if (fields.data.conversation_id) await conversations.access(member.id, fields.data.conversation_id);
      const stored = await service.store(member.id, {
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
        purpose: fields.data.purpose,
        conversationId: fields.data.conversation_id ?? null,
      });
      return c.json(stored, 201);
    })
    .get('/:id', async (c) => c.json(await service.view(c.get('member').id, c.req.param('id'))))
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    });
}

/**
 * Mounted before sign-in is required: an `<img>` or a link cannot send a bearer header, so the
 * signature (one member, an hour or two) is the credential, and the service re-checks access.
 */
export function fileContentRoutes(service: FilesService) {
  return new Hono<AppEnv>().get('/:id/content', async (c) => {
    const id = readParam(c, 'id', idParamSchema);
    const { row, body, maxAge } = await service.signedContent(id, readQuery(c, fileContentQuerySchema));
    const { type, disposition } = dispositionFor(row);
    return new Response(body, {
      headers: {
        'content-type': type,
        'content-disposition': disposition,
        'content-length': String(row.sizeBytes),
        // The same URL always means the same bytes: private caches may keep it until it expires.
        'cache-control': `private, max-age=${maxAge}, immutable`,
        // A stored file never becomes an active page on this origin.
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });
}

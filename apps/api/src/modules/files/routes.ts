/**
 * POST   /api/files               upload (multipart: `file`, `purpose`, optional `conversation_id`)
 * GET    /api/files/:id           what it is
 * GET    /api/files/:id/content   the bytes; pages and SVG always download
 * DELETE /api/files/:id           delete my file
 */

import { Hono } from 'hono';
import { uploadFieldsSchema } from '@greenhouse/contract';
import { invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
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
      const memberId = c.get('member').id;
      if (fields.data.conversation_id) await conversations.access(memberId, fields.data.conversation_id);
      const stored = await service.store(memberId, {
        name: file.name,
        contentType: file.type || 'application/octet-stream',
        bytes: new Uint8Array(await file.arrayBuffer()),
        purpose: fields.data.purpose,
        conversationId: fields.data.conversation_id ?? null,
      });
      return c.json(stored, 201);
    })
    .get('/:id', async (c) => c.json(await service.view(c.get('member').id, c.req.param('id'))))
    .get('/:id/content', async (c) => {
      const { row, body } = await service.content(c.get('member').id, c.req.param('id'));
      const { type, disposition } = dispositionFor(row);
      return new Response(body, {
        headers: {
          'content-type': type,
          'content-disposition': disposition,
          'content-length': String(row.sizeBytes),
          // A stored file never becomes an active page on this origin.
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    })
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    });
}

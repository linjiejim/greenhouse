/**
 * My computer for an Agent: the Agent's own when it is mine, my own copy when it is a public
 * Agent whose publication grants one.
 *
 * GET    /api/agents/:id/computer                       its state
 * POST   /api/agents/:id/computer/start                 start it
 * POST   /api/agents/:id/computer/stop                  stop it (the home stays)
 * POST   /api/agents/:id/computer/restart               restart it: processes end, files stay
 * GET    /api/agents/:id/computer/processes             its background processes
 * POST   /api/agents/:id/computer/ticket                a one-time ticket for the screen or the terminal socket
 * GET    /api/agents/:id/computer/files?path=           a folder of its home (path relative to the home)
 * GET    /api/agents/:id/computer/files/content?path=   a file, always as a download
 * POST   /api/agents/:id/computer/files?path=           upload into a folder (multipart `file`)
 * DELETE /api/agents/:id/computer/files?path=           delete a file or a folder
 */

import { Hono } from 'hono';
import { computerPathQuerySchema, computerTicketInputSchema } from '@greenhouse/contract';
import { ApiError, invalidInput } from '../../http/errors.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import { dispositionFor, MAX_UPLOAD_BYTES } from '../files/service.js';
import type { ComputersService } from './service.js';

/** Multipart overhead on top of the file itself. */
const FORM_SLACK_BYTES = 64 * 1024;

export function computerRoutes(service: ComputersService) {
  return new Hono<AppEnv>()
    .get('/:id/computer', async (c) => c.json(await service.view(c.get('member').id, c.req.param('id'))))
    .post('/:id/computer/start', async (c) => c.json(await service.start(c.get('member').id, c.req.param('id'))))
    .post('/:id/computer/stop', async (c) => c.json(await service.stop(c.get('member').id, c.req.param('id'))))
    .post('/:id/computer/restart', async (c) => c.json(await service.restart(c.get('member').id, c.req.param('id'))))
    .get('/:id/computer/processes', async (c) =>
      c.json({ items: await service.jobs(c.get('member').id, c.req.param('id')) }),
    )
    .post('/:id/computer/ticket', async (c) => {
      const { purpose } = await readJson(c, computerTicketInputSchema);
      return c.json(await service.ticket(c.get('member').id, c.req.param('id'), purpose));
    })
    .get('/:id/computer/files', async (c) => {
      const { path } = readQuery(c, computerPathQuerySchema);
      return c.json(await service.files(c.get('member').id, c.req.param('id'), path));
    })
    .get('/:id/computer/files/content', async (c) => {
      const { path } = readQuery(c, computerPathQuerySchema);
      const file = await service.fileContent(c.get('member').id, c.req.param('id'), path);
      // Whatever it holds (a page, an SVG), it is saved, never shown on this origin.
      const { type, disposition } = dispositionFor({ name: file.name, contentType: 'application/octet-stream' });
      return new Response(file.body, {
        headers: {
          'content-type': type,
          'content-disposition': disposition,
          'content-length': String(file.size),
          'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; sandbox",
        },
      });
    })
    .post('/:id/computer/files', async (c) => {
      const { path } = readQuery(c, computerPathQuerySchema);
      const declared = Number(c.req.header('content-length') ?? 0);
      if (declared > MAX_UPLOAD_BYTES + FORM_SLACK_BYTES) {
        throw new ApiError(413, 'too_large', 'Files can be up to 50 MB.');
      }
      if (!c.req.header('content-type')?.startsWith('multipart/form-data')) {
        throw invalidInput('Upload the file as multipart/form-data.');
      }
      const form = await c.req.parseBody();
      const file = form.file;
      if (!(file instanceof File)) throw invalidInput('Add the file in the `file` field.');
      const saved = await service.upload(c.get('member').id, c.req.param('id'), path, {
        name: file.name,
        bytes: new Uint8Array(await file.arrayBuffer()),
      });
      return c.json(saved, 201);
    })
    .delete('/:id/computer/files', async (c) => {
      const { path } = readQuery(c, computerPathQuerySchema);
      await service.removeFile(c.get('member').id, c.req.param('id'), path);
      return c.body(null, 204);
    });
}

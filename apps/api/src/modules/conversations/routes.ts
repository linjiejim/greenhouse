/**
 * GET    /api/conversations?kind=&q=&archived=        my conversations, pinned first, newest activity next
 * POST   /api/conversations                           a chat, a room, or the thread with an Agent
 * GET    /api/conversations/:id                       one conversation with its people and Agents
 * PATCH  /api/conversations/:id                       rename, model, pin, archive, mute
 * DELETE /api/conversations/:id                       delete a chat or a room
 * GET    /api/conversations/:id/messages              newest page first, with my ratings; ?after=<seq> catches up
 * POST   /api/conversations/:id/messages              send; an Agent answers now or after the current reply
 * PATCH  /api/conversations/:id/messages/:mid         edit my last message: the replies after it go, it is answered again
 * POST   /api/conversations/:id/messages/:mid/regenerate   the last reply to me, written again
 * PUT    /api/conversations/:id/messages/:mid/feedback     👍 1 / 👎 -1 on a reply, 0 takes it back
 * POST   /api/conversations/:id/stop                  stop the reply and drop my queued messages
 * POST   /api/conversations/:id/read                  mark read up to a sequence number
 * GET    /api/conversations/:id/members               its people and Agents
 * POST   /api/conversations/:id/members               a room: add people (anyone) and my own Agents
 * DELETE /api/conversations/:id/members/:memberId     a room: the owner removes someone; my own id leaves
 * GET    /api/conversations/:id/notes                 shared notes, pinned first
 * POST   /api/conversations/:id/notes                 add a note
 * PATCH  /api/conversations/:id/notes/:noteId         change a note
 * DELETE /api/conversations/:id/notes/:noteId         delete a note
 * GET    /api/conversations/:id/export                the conversation as a Markdown file
 */

import { Hono } from 'hono';
import {
  addMembersInputSchema,
  conversationListQuerySchema,
  createConversationInputSchema,
  createNoteInputSchema,
  editMessageInputSchema,
  feedbackInputSchema,
  idParamSchema,
  messageListQuerySchema,
  pageQuerySchema,
  readInputSchema,
  sendMessageInputSchema,
  updateConversationInputSchema,
  updateNoteInputSchema,
} from '@greenhouse/contract';
import type { Engine } from '../../engine/engine.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import { dispositionFor } from '../files/service.js';
import type { ConversationsService } from './service.js';

export function conversationRoutes(service: ConversationsService, engine: Engine) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member').id, readQuery(c, conversationListQuerySchema))))
    .post('/', async (c) =>
      c.json(await service.create(c.get('member').id, await readJson(c, createConversationInputSchema)), 201),
    )
    .get('/:id', async (c) => c.json(await service.get(c.get('member').id, c.req.param('id'))))
    .patch('/:id', async (c) =>
      c.json(
        await service.update(c.get('member').id, c.req.param('id'), await readJson(c, updateConversationInputSchema)),
      ),
    )
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    })
    .get('/:id/messages', async (c) =>
      c.json(await service.messages(c.get('member').id, c.req.param('id'), readQuery(c, messageListQuerySchema))),
    )
    .post('/:id/messages', async (c) =>
      c.json(await engine.post(c.get('member').id, c.req.param('id'), await readJson(c, sendMessageInputSchema)), 201),
    )
    .patch('/:id/messages/:mid', async (c) =>
      c.json(
        await engine.edit(
          c.get('member').id,
          c.req.param('id'),
          readParam(c, 'mid', idParamSchema),
          (await readJson(c, editMessageInputSchema)).content,
        ),
      ),
    )
    .post('/:id/messages/:mid/regenerate', async (c) =>
      c.json(await engine.regenerate(c.get('member').id, c.req.param('id'), readParam(c, 'mid', idParamSchema))),
    )
    .put('/:id/messages/:mid/feedback', async (c) =>
      c.json(
        await service.rate(
          c.get('member').id,
          c.req.param('id'),
          readParam(c, 'mid', idParamSchema),
          await readJson(c, feedbackInputSchema),
        ),
      ),
    )
    .post('/:id/stop', async (c) => {
      await engine.stop(c.get('member').id, c.req.param('id'));
      return c.body(null, 202);
    })
    .post('/:id/read', async (c) => {
      await service.markRead(c.get('member').id, c.req.param('id'), (await readJson(c, readInputSchema)).seq);
      return c.body(null, 204);
    })
    .get('/:id/members', async (c) => c.json(await service.people(c.get('member').id, c.req.param('id'))))
    .post('/:id/members', async (c) =>
      c.json(await service.addMembers(c.get('member').id, c.req.param('id'), await readJson(c, addMembersInputSchema))),
    )
    .delete('/:id/members/:memberId', async (c) => {
      const conversationId = c.req.param('id');
      const target = readParam(c, 'memberId', idParamSchema);
      await service.removeMember(c.get('member').id, conversationId, target);
      await engine.release(conversationId, target);
      return c.body(null, 204);
    })
    .get('/:id/notes', async (c) =>
      c.json(await service.notes(c.get('member').id, c.req.param('id'), readQuery(c, pageQuerySchema))),
    )
    .post('/:id/notes', async (c) =>
      c.json(
        await service.addNote(c.get('member').id, c.req.param('id'), await readJson(c, createNoteInputSchema)),
        201,
      ),
    )
    .patch('/:id/notes/:noteId', async (c) =>
      c.json(
        await service.updateNote(
          c.get('member').id,
          c.req.param('id'),
          readParam(c, 'noteId', idParamSchema),
          await readJson(c, updateNoteInputSchema),
        ),
      ),
    )
    .delete('/:id/notes/:noteId', async (c) => {
      await service.removeNote(c.get('member').id, c.req.param('id'), readParam(c, 'noteId', idParamSchema));
      return c.body(null, 204);
    })
    .get('/:id/export', async (c) => {
      const { filename, markdown } = await service.exportMarkdown(c.get('member').id, c.req.param('id'));
      return c.body(markdown, 200, {
        'content-type': 'text/markdown; charset=utf-8',
        'content-disposition': dispositionFor({ name: filename, contentType: 'text/markdown' }).disposition,
        'cache-control': 'no-store',
      });
    });
}

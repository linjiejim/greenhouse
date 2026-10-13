/**
 * GET    /api/conversations?kind=&q=&archived=     my conversations, pinned first, newest activity next
 * POST   /api/conversations                        a chat, a room, or the thread with an Agent
 * GET    /api/conversations/:id                    one conversation with its people and Agents
 * PATCH  /api/conversations/:id                    rename, model, pin, archive, mute
 * DELETE /api/conversations/:id                    delete a chat or a room
 * GET    /api/conversations/:id/messages           newest page first; ?after=<seq> catches up
 * POST   /api/conversations/:id/messages           send; an Agent answers now or after the current reply
 * POST   /api/conversations/:id/stop               stop the reply and drop my queued messages
 * POST   /api/conversations/:id/read               mark read up to a sequence number
 */

import { Hono } from 'hono';
import {
  conversationListQuerySchema,
  createConversationInputSchema,
  messageListQuerySchema,
  readInputSchema,
  sendMessageInputSchema,
  updateConversationInputSchema,
} from '@greenhouse/contract';
import type { Engine } from '../../engine/engine.js';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
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
    .post('/:id/stop', async (c) => {
      await engine.stop(c.get('member').id, c.req.param('id'));
      return c.body(null, 202);
    })
    .post('/:id/read', async (c) => {
      await service.markRead(c.get('member').id, c.req.param('id'), (await readJson(c, readInputSchema)).seq);
      return c.body(null, 204);
    });
}

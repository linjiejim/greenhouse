/**
 * GET    /api/agents?scope=mine|archived        my Agents, the main one first
 * POST   /api/agents                            new Agent, from a template or blank
 * GET    /api/agents/:id                        one Agent with its current manifest (`main` works as an id)
 * PATCH  /api/agents/:id                        change it; appends a version
 * DELETE /api/agents/:id                        archive (never the main Agent)
 * POST   /api/agents/:id/restore                bring an archived Agent back
 * GET    /api/agents/:id/versions               its version history
 * GET    /api/agents/:id/memories               what it remembers about me
 * POST   /api/agents/:id/memories               teach it something
 * PATCH  /api/agents/:id/memories/:mid          edit a memory
 * DELETE /api/agents/:id/memories/:mid          forget it
 */

import { Hono } from 'hono';
import {
  agentListQuerySchema,
  createAgentInputSchema,
  memoryInputSchema,
  updateAgentInputSchema,
  updateMemoryInputSchema,
} from '@greenhouse/contract';
import { z } from 'zod';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import type { AgentsService } from './service.js';

const memoryQuerySchema = z.object({ status: z.enum(['active', 'all']).default('active') });

export function agentRoutes(service: AgentsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) =>
      c.json({ items: await service.list(c.get('member').id, readQuery(c, agentListQuerySchema).scope) }),
    )
    .post('/', async (c) =>
      c.json(await service.create(c.get('member').id, await readJson(c, createAgentInputSchema)), 201),
    )
    .get('/:id', async (c) => c.json(await service.get(c.get('member').id, c.req.param('id'))))
    .patch('/:id', async (c) =>
      c.json(await service.update(c.get('member').id, c.req.param('id'), await readJson(c, updateAgentInputSchema))),
    )
    .delete('/:id', async (c) => {
      await service.archive(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    })
    .post('/:id/restore', async (c) => c.json(await service.restore(c.get('member').id, c.req.param('id'))))
    .get('/:id/versions', async (c) => c.json({ items: await service.versions(c.get('member').id, c.req.param('id')) }))
    .get('/:id/memories', async (c) =>
      c.json({
        items: await service.memories(c.get('member').id, c.req.param('id'), readQuery(c, memoryQuerySchema).status),
      }),
    )
    .post('/:id/memories', async (c) =>
      c.json(await service.remember(c.get('member').id, c.req.param('id'), await readJson(c, memoryInputSchema)), 201),
    )
    .patch('/:id/memories/:mid', async (c) =>
      c.json(
        await service.updateMemory(
          c.get('member').id,
          c.req.param('id'),
          c.req.param('mid'),
          await readJson(c, updateMemoryInputSchema),
        ),
      ),
    )
    .delete('/:id/memories/:mid', async (c) => {
      await service.forget(c.get('member').id, c.req.param('id'), c.req.param('mid'));
      return c.body(null, 204);
    });
}

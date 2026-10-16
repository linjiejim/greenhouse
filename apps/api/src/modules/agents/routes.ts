/**
 * GET    /api/agents?scope=mine|archived        my Agents, the main one first
 * GET    /api/agents?scope=public               other members' public Agents shared with me, with their owners
 * POST   /api/agents                            new Agent, from a template or blank
 * GET    /api/agents/:id                        one Agent with its current manifest (`main` works as an id)
 * PATCH  /api/agents/:id                        change it; appends a version
 * DELETE /api/agents/:id                        archive (never the main Agent)
 * POST   /api/agents/:id/restore                bring an archived Agent back
 * GET    /api/agents/:id/versions               its version history
 * GET    /api/agents/:id/memories               what it remembers about me (also a public Agent I use)
 * POST   /api/agents/:id/memories               teach it something
 * PATCH  /api/agents/:id/memories/:mid          edit a memory
 * DELETE /api/agents/:id/memories/:mid          forget it
 * GET    /api/agents/:id/publication            its publication: version, audience, computer, daily cap
 * PUT    /api/agents/:id/publication            publish a version to an audience, or change it (never the main Agent)
 * DELETE /api/agents/:id/publication            back to private
 * GET    /api/admin/public-agents               admin: every public Agent with its owner, audience size and month
 * POST   /api/admin/public-agents/:id/pause     admin: its audience can no longer talk to it
 * POST   /api/admin/public-agents/:id/resume    admin: let them again
 */

import { Hono } from 'hono';
import {
  agentListQuerySchema,
  createAgentInputSchema,
  idParamSchema,
  memoryInputSchema,
  pageQuerySchema,
  publicationInputSchema,
  updateAgentInputSchema,
  updateMemoryInputSchema,
} from '@greenhouse/contract';
import { z } from 'zod';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { AgentsService } from './service.js';
import type { ApprovalsService } from './approvals.js';

const memoryQuerySchema = z.object({ status: z.enum(['active', 'all']).default('active') });

export function agentRoutes(service: AgentsService, approvals: ApprovalsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const { scope } = readQuery(c, agentListQuerySchema);
      const memberId = c.get('member').id;
      return c.json({
        items: scope === 'public' ? await service.listPublic(memberId) : await service.list(memberId, scope),
      });
    })
    .post('/', async (c) =>
      c.json(await service.create(c.get('member').id, await readJson(c, createAgentInputSchema)), 201),
    )
    .get('/:id', async (c) => c.json(await service.get(c.get('member').id, c.req.param('id'))))
    .get('/:id/standing-approvals', async (c) =>
      c.json(await approvals.list(c.get('member').id, c.req.param('id'), readQuery(c, pageQuerySchema))),
    )
    .delete('/:id/standing-approvals/:aid', async (c) => {
      await approvals.revoke(c.get('member').id, c.req.param('id'), c.req.param('aid'));
      return c.body(null, 204);
    })
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
    })
    .get('/:id/publication', async (c) => c.json(await service.publication(c.get('member').id, c.req.param('id'))))
    .put('/:id/publication', async (c) =>
      c.json(await service.publish(c.get('member').id, c.req.param('id'), await readJson(c, publicationInputSchema))),
    )
    .delete('/:id/publication', async (c) => {
      await service.unpublish(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    });
}

/** Mounted under /api/admin, which already requires an admin. */
export function adminPublicAgentRoutes(service: AgentsService) {
  return new Hono<AppEnv>()
    .get('/public-agents', async (c) =>
      c.json(await service.adminPublic(c.get('member').id, readQuery(c, pageQuerySchema))),
    )
    .post('/public-agents/:id/pause', async (c) =>
      c.json(await service.setPaused(c.get('member').id, readParam(c, 'id', idParamSchema), true)),
    )
    .post('/public-agents/:id/resume', async (c) =>
      c.json(await service.setPaused(c.get('member').id, readParam(c, 'id', idParamSchema), false)),
    );
}

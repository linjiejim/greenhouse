/**
 * GET  /api/agents/:id/computer             its state
 * POST /api/agents/:id/computer/start       start it
 * POST /api/agents/:id/computer/stop        stop it (the home stays)
 * POST /api/agents/:id/computer/restart     restart it: processes end, files stay
 * GET  /api/agents/:id/computer/processes   its background processes
 */

import { Hono } from 'hono';
import type { AppEnv } from '../../http/env.js';
import type { ComputersService } from './service.js';

export function computerRoutes(service: ComputersService) {
  return new Hono<AppEnv>()
    .get('/:id/computer', async (c) => c.json(await service.view(c.get('member').id, c.req.param('id'))))
    .post('/:id/computer/start', async (c) => c.json(await service.start(c.get('member').id, c.req.param('id'))))
    .post('/:id/computer/stop', async (c) => c.json(await service.stop(c.get('member').id, c.req.param('id'))))
    .post('/:id/computer/restart', async (c) => c.json(await service.restart(c.get('member').id, c.req.param('id'))))
    .get('/:id/computer/processes', async (c) =>
      c.json({ items: await service.jobs(c.get('member').id, c.req.param('id')) }),
    );
}

/**
 * GET  /api/runs?state=active|done|all&agent=&source=   my background runs, newest first
 * GET  /api/runs/:id                                      one run with its brief, report, steps and timeline
 * POST /api/runs/:id/cancel                               stop it
 * POST /api/runs/:id/retry                                run a failed or stopped run again
 */

import { Hono } from 'hono';
import { runListQuerySchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readQuery } from '../../http/validate.js';
import type { RunsService } from './service.js';
import type { Engine } from '../../engine/engine.js';

export function runRoutes(service: RunsService, engine: Engine) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member').id, readQuery(c, runListQuerySchema))))
    .get('/:id', async (c) => c.json(await service.get(c.get('member').id, c.req.param('id'))))
    .post('/steps/:id/undo', async (c) => {
      await engine.undoWrite(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    })
    .post('/:id/cancel', async (c) => c.json(await service.cancel(c.get('member').id, c.req.param('id'))))
    .post('/:id/retry', async (c) => c.json(await service.retry(c.get('member').id, c.req.param('id'))));
}

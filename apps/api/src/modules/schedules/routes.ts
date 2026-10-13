/**
 * GET    /api/schedules?agent=           my schedules, or one Agent's
 * POST   /api/schedules                  create one for an Agent
 * GET    /api/schedules/:id
 * PATCH  /api/schedules/:id              name, brief, time, zone
 * DELETE /api/schedules/:id
 * POST   /api/schedules/:id/pause
 * POST   /api/schedules/:id/resume
 * POST   /api/schedules/:id/run-now      fire once now
 */

import { Hono } from 'hono';
import { createScheduleInputSchema, scheduleListQuerySchema, updateScheduleInputSchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readQuery } from '../../http/validate.js';
import type { SchedulesService } from './service.js';

export function scheduleRoutes(service: SchedulesService) {
  return new Hono<AppEnv>()
    .get('/', async (c) =>
      c.json({ items: await service.list(c.get('member').id, readQuery(c, scheduleListQuerySchema).agent) }),
    )
    .post('/', async (c) =>
      c.json(await service.create(c.get('member').id, await readJson(c, createScheduleInputSchema)), 201),
    )
    .get('/:id', async (c) => c.json(await service.get(c.get('member').id, c.req.param('id'))))
    .patch('/:id', async (c) =>
      c.json(await service.update(c.get('member').id, c.req.param('id'), await readJson(c, updateScheduleInputSchema))),
    )
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, c.req.param('id'));
      return c.body(null, 204);
    })
    .post('/:id/pause', async (c) => c.json(await service.pause(c.get('member').id, c.req.param('id'))))
    .post('/:id/resume', async (c) => c.json(await service.resume(c.get('member').id, c.req.param('id'))))
    .post('/:id/run-now', async (c) => c.json(await service.runNow(c.get('member').id, c.req.param('id'))));
}

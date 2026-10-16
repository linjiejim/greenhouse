import { Hono } from 'hono';
import { z } from 'zod';
import {
  automationInputSchema,
  automationUpdateSchema,
  idParamSchema,
  pageQuerySchema,
  recordHandoffSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { AutomationsService } from './automations.js';
import type { RecordAgentsService } from './agents.js';

export function automationsRoutes(service: AutomationsService, recordAgents: RecordAgentsService) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  return new Hono<AppEnv>()
    .get('/bases/:id/automations', async (c) =>
      c.json(await service.list(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .post('/bases/:id/automations', async (c) =>
      c.json(await service.create(c.get('member').id, id(c), await readJson(c, automationInputSchema)), 201),
    )
    .patch('/automations/:id', async (c) =>
      c.json(await service.update(c.get('member').id, id(c), await readJson(c, automationUpdateSchema))),
    )
    .delete('/automations/:id', async (c) => {
      await service.remove(c.get('member').id, id(c));
      return c.body(null, 204);
    })
    .get('/automations/:id/runs', async (c) =>
      c.json(await service.history(c.get('member').id, id(c), readQuery(c, pageQuerySchema))),
    )
    .post('/automations/:id/run', async (c) =>
      c.json(
        await service.button(
          c.get('member').id,
          id(c),
          (await readJson(c, z.object({ record_id: idParamSchema.optional() }))).record_id,
        ),
        201,
      ),
    )
    .post('/records/:id/handoff', async (c) =>
      c.json(await recordAgents.handoff(c.get('member').id, id(c), await readJson(c, recordHandoffSchema)), 201),
    );
}

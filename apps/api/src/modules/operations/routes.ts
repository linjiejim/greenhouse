import { Hono } from 'hono';
import { updateOperationSwitchesSchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson } from '../../http/validate.js';
import type { OperationsService } from './service.js';

export function operationRoutes(service: OperationsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.get(c.get('member').id)))
    .patch('/', async (c) =>
      c.json(await service.update(c.get('member').id, await readJson(c, updateOperationSwitchesSchema))),
    );
}

export function memberOperationRoutes(service: OperationsService) {
  return new Hono<AppEnv>().get('/', async (c) => c.json(await service.memberStatus(c.get('member').id)));
}

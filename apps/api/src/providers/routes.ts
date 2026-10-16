/**
 * GET    /api/admin/providers                       every capability: instances, order, defaults, policy; the adapter catalog
 * POST   /api/admin/providers                       add a workspace instance
 * PATCH  /api/admin/providers/:id                   rename, edit settings, replace keys, turn on or off
 * DELETE /api/admin/providers/:id                   delete; it leaves the order and defaults too
 * POST   /api/admin/providers/:id/test              test connection (env and built-in instances too)
 * POST   /api/admin/providers/:id/copy              copy an env instance into an editable one that takes its place
 * PUT    /api/admin/provider-bindings/:capability   order, defaults and policy of one capability
 * GET    /api/me/providers                          my keys, for capabilities that allow them, and their catalog
 * POST   /api/me/providers                          add my key
 * PATCH  /api/me/providers/:id                      edit my key
 * DELETE /api/me/providers/:id                      delete my key
 * POST   /api/me/providers/:id/test                 test my key
 */

import { Hono } from 'hono';
import {
  bindingInputSchema,
  capabilitySchema,
  createProviderInputSchema,
  updateProviderInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../http/env.js';
import { readJson, readParam } from '../http/validate.js';
import type { ProvidersService } from './service.js';

export function adminProviderRoutes(service: ProvidersService) {
  return new Hono<AppEnv>()
    .get('/providers', async (c) => c.json(await service.adminView()))
    .post('/providers', async (c) =>
      c.json(await service.create(c.get('member').id, 'workspace', await readJson(c, createProviderInputSchema)), 201),
    )
    .patch('/providers/:id', async (c) =>
      c.json(
        await service.update(
          c.get('member').id,
          'workspace',
          c.req.param('id'),
          await readJson(c, updateProviderInputSchema),
        ),
      ),
    )
    .delete('/providers/:id', async (c) => {
      await service.remove(c.get('member').id, 'workspace', c.req.param('id'));
      return c.body(null, 204);
    })
    .post('/providers/:id/test', async (c) =>
      c.json(await service.test(c.get('member').id, 'workspace', c.req.param('id'))),
    )
    .post('/providers/:id/copy', async (c) => c.json(await service.copy(c.get('member').id, c.req.param('id')), 201))
    .put('/provider-bindings/:capability', async (c) =>
      c.json(
        await service.setBinding(
          c.get('member').id,
          readParam(c, 'capability', capabilitySchema),
          await readJson(c, bindingInputSchema),
        ),
      ),
    );
}

export function myProviderRoutes(service: ProvidersService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.myView(c.get('member').id)))
    .post('/', async (c) =>
      c.json(await service.create(c.get('member').id, 'personal', await readJson(c, createProviderInputSchema)), 201),
    )
    .patch('/:id', async (c) =>
      c.json(
        await service.update(
          c.get('member').id,
          'personal',
          c.req.param('id'),
          await readJson(c, updateProviderInputSchema),
        ),
      ),
    )
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, 'personal', c.req.param('id'));
      return c.body(null, 204);
    })
    .post('/:id/test', async (c) => c.json(await service.test(c.get('member').id, 'personal', c.req.param('id'))));
}

/** GET /api/me/models: what I may pick as an Agent's model. */
export function myModelRoutes(service: ProvidersService) {
  return new Hono<AppEnv>().get('/', async (c) =>
    c.json({ items: await service.models({ memberId: c.get('member').id }) }),
  );
}

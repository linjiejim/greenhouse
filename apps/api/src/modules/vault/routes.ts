/**
 * My password vault: logins my Agents can use without seeing them. No response ever holds a
 * user name, a password or an authenticator secret; only labels, sites and masked user names.
 * Without VAULT_ENCRYPTION_KEY every route answers 503 vault_unavailable.
 *
 * GET    /api/me/vault          my logins, newest first
 * POST   /api/me/vault          save a login
 * GET    /api/me/vault/log      what my Agents did with them (mine only; admins never read a vault)
 * GET    /api/me/vault/:id      one login
 * PATCH  /api/me/vault/:id      change it: a value left out stays, an empty one is removed
 * DELETE /api/me/vault/:id      delete it; its log rows keep the label
 */

import { Hono } from 'hono';
import {
  createVaultItemInputSchema,
  idParamSchema,
  pageQuerySchema,
  updateVaultItemInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { VaultService } from './service.js';

export function vaultRoutes(service: VaultService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list(c.get('member').id, readQuery(c, pageQuerySchema))))
    .post('/', async (c) => {
      const input = await readJson(c, createVaultItemInputSchema);
      return c.json(await service.create(c.get('member').id, input), 201);
    })
    .get('/log', async (c) => c.json(await service.log(c.get('member').id, readQuery(c, pageQuerySchema))))
    .get('/:id', async (c) => c.json(await service.get(c.get('member').id, readParam(c, 'id', idParamSchema))))
    .patch('/:id', async (c) => {
      const input = await readJson(c, updateVaultItemInputSchema);
      return c.json(await service.update(c.get('member').id, readParam(c, 'id', idParamSchema), input));
    })
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    });
}

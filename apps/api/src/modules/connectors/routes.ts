/**
 * GET    /api/admin/connectors                  installed connectors (keys and client secrets never returned)
 * GET    /api/admin/connectors/catalog          the built-in catalog, with what is installed
 * GET    /api/admin/connectors/registry?q=      search the official MCP Registry (slow: cached, with a deadline)
 * POST   /api/admin/connectors/probe            what an address asks for: nothing, a key or a sign-in
 * POST   /api/admin/connectors                  install from the catalog ({ catalog_id }) or from a URL; lists its tools
 * GET    /api/admin/connectors/:id              one connector
 * PATCH  /api/admin/connectors/:id              edit, turn on or off; a new address or auth mode disconnects every member
 * DELETE /api/admin/connectors/:id              remove (members' connections go with it)
 * POST   /api/admin/connectors/:id/refresh      list the tools again (per_member and oauth: with the admin's own connection)
 * POST   /api/admin/connectors/:id/test         connect and list, without changing the cached tools
 * GET    /api/me/connections                    my connections and the connectors I can use
 * POST   /api/me/connections                    connect my own key to a per_member connector, or (kind `email`) my own
 *                                                mailbox to the built-in mailbox connector; both are checked first
 * POST   /api/me/connections/oauth/start        start my sign-in: the provider's consent page
 * POST   /api/me/connections/oauth/finish       finish it with the state and code the callback handed the web app
 * POST   /api/me/connections/:id/test           list the tools with my connection
 * DELETE /api/me/connections/:id                disconnect (a sign-in is revoked at the provider, best effort)
 *
 * Public, before sign-in is required (connectorCallbackRoutes). The path is not under /api/mcp,
 * which is Greenhouse's own MCP server:
 * GET    /api/connectors/oauth/callback         the provider sends the browser here; it goes on to 设置 → 连接
 */

import { Hono } from 'hono';
import {
  connectKeyInputSchema,
  connectMailboxInputSchema,
  createConnectorInputSchema,
  idParamSchema,
  oauthFinishInputSchema,
  oauthStartInputSchema,
  probeInputSchema,
  registryQuerySchema,
  updateConnectorInputSchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { ConnectorsService } from './service.js';

export function adminConnectorRoutes(service: ConnectorsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.list()))
    .get('/catalog', async (c) => c.json(await service.catalog()))
    .get('/registry', async (c) => c.json(await service.registry(readQuery(c, registryQuerySchema).q)))
    .post('/probe', async (c) => c.json(await service.probe(await readJson(c, probeInputSchema))))
    .post('/', async (c) =>
      c.json(await service.create(c.get('member').id, await readJson(c, createConnectorInputSchema)), 201),
    )
    .get('/:id', async (c) => c.json(await service.get(readParam(c, 'id', idParamSchema))))
    .patch('/:id', async (c) =>
      c.json(
        await service.update(
          c.get('member').id,
          readParam(c, 'id', idParamSchema),
          await readJson(c, updateConnectorInputSchema),
        ),
      ),
    )
    .delete('/:id', async (c) => {
      await service.remove(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    })
    .post('/:id/refresh', async (c) =>
      c.json(await service.refresh(c.get('member').id, readParam(c, 'id', idParamSchema))),
    )
    .post('/:id/test', async (c) => c.json(await service.test(c.get('member').id, readParam(c, 'id', idParamSchema))));
}

export function myConnectionRoutes(service: ConnectorsService) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await service.mine(c.get('member').id)))
    .post('/', async (c) => {
      const kind = (
        (await c.req.raw
          .clone()
          .json()
          .catch(() => null)) as { kind?: unknown } | null
      )?.kind;
      if (kind === 'email') {
        return c.json(
          await service.connectMailbox(c.get('member').id, await readJson(c, connectMailboxInputSchema)),
          201,
        );
      }
      return c.json(await service.connectKey(c.get('member').id, await readJson(c, connectKeyInputSchema)), 201);
    })
    .post('/oauth/start', async (c) =>
      c.json(await service.startOAuth(c.get('member').id, (await readJson(c, oauthStartInputSchema)).connector_id)),
    )
    .post('/oauth/finish', async (c) =>
      c.json(await service.finishOAuth(c.get('member').id, await readJson(c, oauthFinishInputSchema))),
    )
    .post('/:id/test', async (c) =>
      c.json(await service.testConnection(c.get('member').id, readParam(c, 'id', idParamSchema))),
    )
    .delete('/:id', async (c) => {
      await service.disconnect(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    });
}

/**
 * Mounted before sign-in is required: the provider redirects the member's browser here with no
 * bearer header. It changes nothing; it hands the code and the sealed state on to the web app,
 * whose signed-in session finishes the sign-in, so only the member who started it can.
 */
export function connectorCallbackRoutes(service: ConnectorsService) {
  return new Hono<AppEnv>().get('/oauth/callback', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    return c.redirect(service.callbackRedirect(c.req.query()), 302);
  });
}

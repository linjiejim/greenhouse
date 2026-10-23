/**
 * Data catalog — /api/data-catalog (internal users).
 *
 * GET /api/data-catalog — the Tables bases and extension data sources this member
 *                         can read, with row counts, owners, last change and the
 *                         MCP tools their agent reaches each one with
 *
 * The same builder serves the `data_catalog` MCP tool (narrowed to the token's
 * scopes there); here it is the member's own permissions (hub-context/catalog.ts).
 */

import { Hono } from 'hono';
import { getDb } from '@greenhouse/db';
import type { DataCatalog } from '@greenhouse/types/hub-context';
import type { AppEnv } from '../app-env.js';
import { getAuthUser } from '../auth/middleware.js';
import { humanActor } from '../platform/actor.js';
import { memberMcpToolIds } from '../agent-runtime/mcp-tool-visibility.js';
import { buildDataCatalog } from '../hub-context/catalog.js';

const dataCatalogRoutes = new Hono<AppEnv>().get('/', async (c) => {
  const user = getAuthUser(c);
  const role = user.role === 'super' ? 'super' : 'team';
  const catalog: DataCatalog = await buildDataCatalog({
    db: getDb(),
    actor: humanActor(user, c),
    reachable: await memberMcpToolIds(user.id, role),
  });
  return c.json(catalog);
});

export default dataCatalogRoutes;

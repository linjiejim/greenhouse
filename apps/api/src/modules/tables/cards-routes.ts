/**
 * POST   /api/tables/bases/:id/dashboards   a dashboard without cards: shared (builders) or `personal` (anyone who sees the base)
 * GET    /api/tables/views/:id/cards        what every card of a dashboard shows me: `{ revision, items: [{ id, data }] }`
 * POST   /api/tables/cards/query            what one card shows me, saved or not: `{ card }`
 * Renaming, reordering, changing the cards and deleting a dashboard go through PATCH and DELETE
 * /api/tables/views/:id (routes.ts), with its revision.
 */

import { Hono } from 'hono';
import { cardQueryInputSchema, createDashboardInputSchema, idParamSchema } from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam } from '../../http/validate.js';
import type { CardsPart } from './cards.js';

export function cardsRoutes(part: CardsPart) {
  const id = (c: Parameters<typeof readParam>[0]) => readParam(c, 'id', idParamSchema);
  return new Hono<AppEnv>()
    .post('/bases/:id/dashboards', async (c) =>
      c.json(await part.createDashboard(c.get('member').id, id(c), await readJson(c, createDashboardInputSchema)), 201),
    )
    .get('/views/:id/cards', async (c) => c.json(await part.dashboard(c.get('member').id, id(c))))
    .post('/cards/query', async (c) => {
      const { card } = await readJson(c, cardQueryInputSchema);
      return c.json(await part.query(c.get('member').id, card));
    });
}

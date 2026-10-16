/**
 * GET    /api/me/usage?period=month|30d                      my usage: totals, by capability, Agent and day; my budgets
 * GET    /api/agents/:id/usage?period=                        one of my Agents: replies, runs, tokens, cost, ratings
 * GET    /api/agents/:id/activity                             one of my Agents' runs, newest first, never content
 * GET    /api/admin/usage?period=&group_by=member|agent|provider|capability   the workspace's usage
 * GET    /api/admin/budgets                                   budgets with what they spent this month
 * PUT    /api/admin/budgets                                   create or replace the budget of a scope and unit
 * DELETE /api/admin/budgets/:id                               remove a budget
 */

import { Hono } from 'hono';
import {
  adminUsageQuerySchema,
  agentBudgetInputSchema,
  budgetInputSchema,
  idParamSchema,
  pageQuerySchema,
  usageQuerySchema,
} from '@greenhouse/contract';
import type { AppEnv } from '../../http/env.js';
import { readJson, readParam, readQuery } from '../../http/validate.js';
import type { UsageService } from './service.js';

export function myUsageRoutes(service: UsageService) {
  return new Hono<AppEnv>().get('/', async (c) =>
    c.json(await service.mine(c.get('member').id, readQuery(c, usageQuerySchema).period)),
  );
}

/** Mounted under /api/agents. */
export function agentUsageRoutes(service: UsageService) {
  return new Hono<AppEnv>()
    .get('/:id/budgets', async (c) =>
      c.json({ items: await service.agentBudgets(c.get('member').id, c.req.param('id')) }),
    )
    .put('/:id/budgets', async (c) => {
      const input = await readJson(c, agentBudgetInputSchema);
      return c.json(
        await service.saveBudget(c.get('member').id, { ...input, scope_type: 'agent', scope_id: c.req.param('id') }),
      );
    })
    .get('/:id/usage', async (c) =>
      c.json(await service.agentUsage(c.get('member').id, c.req.param('id'), readQuery(c, usageQuerySchema).period)),
    )
    .get('/:id/activity', async (c) =>
      c.json(await service.agentActivity(c.get('member').id, c.req.param('id'), readQuery(c, pageQuerySchema))),
    );
}

/** Mounted under /api/admin, which already requires an admin. */
export function adminUsageRoutes(service: UsageService) {
  return new Hono<AppEnv>()
    .get('/usage', async (c) => {
      const query = readQuery(c, adminUsageQuerySchema);
      return c.json(await service.workspace(query.period, query.group_by));
    })
    .get('/budgets', async (c) => c.json(await service.budgets(readQuery(c, pageQuerySchema))))
    .put('/budgets', async (c) =>
      c.json(await service.saveBudget(c.get('member').id, await readJson(c, budgetInputSchema))),
    )
    .delete('/budgets/:id', async (c) => {
      await service.removeBudget(c.get('member').id, readParam(c, 'id', idParamSchema));
      return c.body(null, 204);
    });
}

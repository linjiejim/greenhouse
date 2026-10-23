/**
 * 服务与计价 — /api/admin/metering（super only，挂在 /api/admin/* 的 requireSuper 之后）
 *
 * GET    /api/admin/metering/overview?month=YYYY-MM — 服务与模型价目（含未定价）、当月花费（按成员 / 服务 / 客户端 / Agent 客户端）、三级预算与当月已花 / 预留
 * PUT    /api/admin/metering/budgets                — 设一条 USD 月度上限 {scope: organization|service|member|member_default, scope_id?, limit_usd_micros}
 * DELETE /api/admin/metering/budgets?scope=&scope_id= — 删掉一条覆盖，回落到 env / 默认值
 *
 * 读全部有界：一个 UTC 月，按 created_at 索引；改上限下一次调用即生效。
 */

import { Hono } from 'hono';
import { getDb, MEMBER_DEFAULT_SCOPE_ID, type UsageBudgetLimitScopeType } from '@greenhouse/db';
import type { BudgetLimitInput } from '@greenhouse/types/metering';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { organizationScopeId } from '../usage/metering.js';
import { buildMeteringOverview, isMeteredService, parseMonth } from '../usage/report.js';

/** Hard ceiling on one limit: $10M a month. */
const MAX_LIMIT_USD_MICROS = 10_000_000 * 1_000_000;

type LimitTarget = { scope_type: UsageBudgetLimitScopeType; scope_id: string } | { error: string };

async function resolveTarget(scope: unknown, scopeId: unknown): Promise<LimitTarget> {
  switch (scope) {
    case 'organization':
      return { scope_type: 'organization', scope_id: organizationScopeId() };
    case 'member_default':
      return { scope_type: 'user', scope_id: MEMBER_DEFAULT_SCOPE_ID };
    case 'service':
      if (!isMeteredService(scopeId)) return { error: 'Unknown service' };
      return { scope_type: 'service', scope_id: scopeId };
    case 'member': {
      if (typeof scopeId !== 'string' || !scopeId.trim()) return { error: 'scope_id is required' };
      const user = await getDb().users.getById(scopeId.trim());
      if (!user || (user.role !== 'team' && user.role !== 'super')) return { error: 'Unknown member' };
      return { scope_type: 'user', scope_id: user.id };
    }
    default:
      return { error: 'scope must be organization, service, member or member_default' };
  }
}

const adminMetering = new Hono<AppEnv>()
  .get('/overview', async (c) => {
    const at = parseMonth(c.req.query('month'));
    if (!at) return c.json({ error: 'month must be YYYY-MM' }, 400);
    return c.json(await buildMeteringOverview(getDb(), at));
  })
  .put('/budgets', async (c) => {
    let body: Partial<BudgetLimitInput>;
    try {
      body = (await c.req.json()) as Partial<BudgetLimitInput>;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const limit = body.limit_usd_micros;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || limit > MAX_LIMIT_USD_MICROS) {
      return c.json({ error: 'limit_usd_micros must be a non-negative integer' }, 400);
    }
    const target = await resolveTarget(body.scope, body.scope_id);
    if ('error' in target) return c.json({ error: target.error }, 400);
    const row = await getDb().metering.setLimit({ ...target, limit_units: limit, actor_id: getAuthUser(c).id });
    return c.json({
      ok: true as const,
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      limit_usd_micros: row.limit_units,
    });
  })
  .delete('/budgets', async (c) => {
    const target = await resolveTarget(c.req.query('scope'), c.req.query('scope_id'));
    if ('error' in target) return c.json({ error: target.error }, 400);
    const removed = await getDb().metering.deleteLimit(target.scope_type, target.scope_id);
    return c.json({ ok: true as const, removed });
  });

export default adminMetering;

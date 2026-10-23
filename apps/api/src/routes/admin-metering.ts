/**
 * 服务与计价 — /api/admin/metering（super only，挂在 /api/admin/* 的 requireSuper 之后）
 *
 * GET    /api/admin/metering/overview?month=YYYY-MM — 服务与模型价目（含未定价）、当月花费（按成员 / 服务 / 客户端 / Agent 客户端）、三级预算与当月已花 / 预留
 * PUT    /api/admin/metering/budgets                — 设一条 USD 月度上限 {scope: organization|service|member|member_default, scope_id?, limit_usd_micros}
 * DELETE /api/admin/metering/budgets?scope=&scope_id= — 删掉一条覆盖，回落到 env / 默认值
 * PUT    /api/admin/metering/prices                 — 设一个价（覆盖 yaml）{kind: model|service, target, provider?, input/output/cached_input（每百万 token 美元）| unit_price（美元/次·张·分钟）}
 * DELETE /api/admin/metering/prices?kind=&target=&provider= — 删掉覆盖，回落到 models.yaml / services.yaml
 * GET    /api/admin/metering/gateway-keys           — 模型网关：开关状态 + 全员的网关 Key（不含密钥）
 * DELETE /api/admin/metering/gateway-keys/:id       — 撤销任一成员的网关 Key（审计 revokeMemberGatewayKey）
 *
 * 读全部有界：一个 UTC 月，按 created_at 索引；改上限、改价下一次调用（结算）即生效，已记账的事实保留当时的价。
 * 每次有效写入都记 platform 审计（updateBudgetLimit / removeBudgetLimit / updateServicePrice / removeServicePrice），
 * 在操作记录里显示为管理员改动。
 */

import { Hono, type Context } from 'hono';
import { getDb, MEMBER_DEFAULT_SCOPE_ID, type UsageBudgetLimitScopeType } from '@greenhouse/db';
import type { BudgetLimitInput, PriceOverrideInput } from '@greenhouse/types/metering';
import { getAuthUser } from '../auth/middleware.js';
import type { AppEnv } from '../app-env.js';
import { humanActor } from '../platform/actor.js';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';
import { getModelCatalog } from '../config/models.js';
import { getServiceCatalog, SERVICE_PROVIDERS, type PricedService } from '../config/services.js';
import { organizationScopeId } from '../usage/metering.js';
import { syncPriceOverrides } from '../usage/pricing.js';
import { buildMeteringOverview, isMeteredService, parseMonth } from '../usage/report.js';
import { isGatewayEnabled, recordGatewayKeyAudit, toGatewayAdminKeyView, toGatewayKeyView } from '../gateway/keys.js';

/** Hard ceiling on one price: $10,000 per unit or per 1M tokens. */
const MAX_PRICE_USD = 10_000;

/** Units of the services priced per token; everything else is priced per unit. */
const TOKEN_PRICED: ReadonlySet<PricedService> = new Set(['vision']);

function serviceUnit(service: PricedService): string {
  return getServiceCatalog()[service]?.unit ?? (TOKEN_PRICED.has(service) ? 'token' : 'unit');
}

/** Platform audit for one admin change; the Activity log lists it under admin changes. */
async function recordMeteringAudit(
  c: Context<AppEnv>,
  input: {
    actionId: string;
    entityId: 'budgetLimit' | 'servicePrice';
    recordId: string;
    summary: Record<string, unknown>;
  },
) {
  const user = getAuthUser(c);
  await getDb().platform.recordAudit({
    orgId: PLATFORM_ORG_ID,
    actorId: user.id,
    actorType: 'human',
    requestId: humanActor(user, c).requestId,
    resource: { appId: 'platform', moduleId: 'settings', entityId: input.entityId, recordId: input.recordId },
    actionId: input.actionId,
    capability: 'platform.settings.manage',
    result: 'success',
    summary: input.summary,
  });
}

function usd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function rate(value: unknown, label: string, required: boolean): number | null | { error: string } {
  if (value === undefined || value === null) return required ? { error: `${label} is required` } : null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > MAX_PRICE_USD) {
    return { error: `${label} must be a number between 0 and ${MAX_PRICE_USD}` };
  }
  return value;
}

type PriceTarget =
  | { kind: 'model' | 'service'; target: string; provider: string; tokenPriced: boolean }
  | { error: string };

function resolvePriceTarget(kind: unknown, target: unknown, provider: unknown): PriceTarget {
  if (kind === 'model') {
    if (typeof target !== 'string' || !getModelCatalog().models[target]) return { error: 'Unknown model' };
    return { kind, target, provider: '', tokenPriced: true };
  }
  if (kind === 'service') {
    if (typeof target !== 'string' || !(target in SERVICE_PROVIDERS)) return { error: 'Unknown service' };
    const service = target as PricedService;
    if (typeof provider !== 'string' || !SERVICE_PROVIDERS[service].includes(provider)) {
      return { error: 'Unknown provider for this service' };
    }
    return { kind, target: service, provider, tokenPriced: serviceUnit(service) === 'token' };
  }
  return { error: 'kind must be model or service' };
}

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
    await recordMeteringAudit(c, {
      actionId: 'updateBudgetLimit',
      entityId: 'budgetLimit',
      recordId: `${body.scope}:${target.scope_id}`,
      summary: {
        scope: body.scope,
        scope_id: target.scope_id,
        limit_usd_micros: limit,
        detail: `${body.scope}${body.scope === 'service' || body.scope === 'member' ? ` ${target.scope_id}` : ''}: ${usd(limit)} / month`,
      },
    });
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
    if (removed) {
      const scope = c.req.query('scope') ?? '';
      await recordMeteringAudit(c, {
        actionId: 'removeBudgetLimit',
        entityId: 'budgetLimit',
        recordId: `${scope}:${target.scope_id}`,
        summary: {
          scope,
          scope_id: target.scope_id,
          detail: `${scope}${scope === 'service' || scope === 'member' ? ` ${target.scope_id}` : ''}: back to default`,
        },
      });
    }
    return c.json({ ok: true as const, removed });
  })
  .put('/prices', async (c) => {
    let body: Partial<PriceOverrideInput>;
    try {
      body = (await c.req.json()) as Partial<PriceOverrideInput>;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }
    const target = resolvePriceTarget(body.kind, body.target, body.provider);
    if ('error' in target) return c.json({ error: target.error }, 400);
    const input = rate(body.input, 'input', target.tokenPriced);
    const output = rate(body.output, 'output', target.tokenPriced);
    const cached = rate(body.cached_input, 'cached_input', false);
    const unit = rate(body.unit_price, 'unit_price', !target.tokenPriced);
    for (const value of [input, output, cached, unit]) {
      if (value !== null && typeof value === 'object') return c.json({ error: value.error }, 400);
    }
    const fields = target.tokenPriced
      ? {
          input_per_mtok: input as number,
          output_per_mtok: output as number,
          cached_input_per_mtok: cached as number | null,
          unit_price: null,
        }
      : { input_per_mtok: null, output_per_mtok: null, cached_input_per_mtok: null, unit_price: unit as number };
    const db = getDb();
    await db.metering.setPriceOverride({
      kind: target.kind,
      target: target.target,
      provider: target.provider,
      ...fields,
      actor_id: getAuthUser(c).id,
    });
    await syncPriceOverrides(db, true);
    const name = target.provider ? `${target.target}/${target.provider}` : target.target;
    await recordMeteringAudit(c, {
      actionId: 'updateServicePrice',
      entityId: 'servicePrice',
      recordId: `${target.kind}:${name}`,
      summary: {
        kind: target.kind,
        target: target.target,
        provider: target.provider || null,
        ...fields,
        detail: target.tokenPriced
          ? `${name}: in $${fields.input_per_mtok} / out $${fields.output_per_mtok}${fields.cached_input_per_mtok !== null ? ` / cached $${fields.cached_input_per_mtok}` : ''} per 1M tokens`
          : `${name}: $${fields.unit_price} per ${serviceUnit(target.target as PricedService)}`,
      },
    });
    return c.json({ ok: true as const, kind: target.kind, target: target.target, provider: target.provider || null });
  })
  .delete('/prices', async (c) => {
    const target = resolvePriceTarget(c.req.query('kind'), c.req.query('target'), c.req.query('provider'));
    if ('error' in target) return c.json({ error: target.error }, 400);
    const db = getDb();
    const removed = await db.metering.deletePriceOverride(target.kind, target.target, target.provider);
    await syncPriceOverrides(db, true);
    if (removed) {
      const name = target.provider ? `${target.target}/${target.provider}` : target.target;
      await recordMeteringAudit(c, {
        actionId: 'removeServicePrice',
        entityId: 'servicePrice',
        recordId: `${target.kind}:${name}`,
        summary: {
          kind: target.kind,
          target: target.target,
          provider: target.provider || null,
          detail: `${name}: back to the config price`,
        },
      });
    }
    return c.json({ ok: true as const, removed });
  })
  .get('/gateway-keys', async (c) => {
    const keys = await getDb().gatewayKeys.listAll();
    return c.json({ enabled: await isGatewayEnabled(), keys: keys.map((row) => toGatewayAdminKeyView(row)) });
  })
  .delete('/gateway-keys/:id', async (c) => {
    const db = getDb();
    const user = getAuthUser(c);
    const result = await db.gatewayKeys.revoke({ id: c.req.param('id'), revoked_by: user.id });
    if (!result) return c.json({ error: 'Gateway key not found' }, 404);
    if (result.changed) {
      const owner = await db.users.getById(result.row.user_id);
      await recordGatewayKeyAudit(db, c, user, {
        actionId: 'revokeMemberGatewayKey',
        key: result.row,
        capability: 'platform.settings.manage',
        detail: `${result.row.name} (${result.row.key_prefix}…) of ${owner?.nickname || owner?.email || result.row.user_id}`,
      });
    }
    return c.json({ ok: true as const, key: toGatewayKeyView(result.row) });
  });

export default adminMetering;

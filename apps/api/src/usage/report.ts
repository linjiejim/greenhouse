/**
 * Read models for Administration › Services & pricing and Settings › Usage.
 *
 * Prices come from the two config files, spend from the per-call facts
 * (llm_usage + service_usage, one month, indexed), budgets from the admin
 * limit rows resolved exactly as metering resolves them, with this month's
 * account balance next to each.
 */

import { getAvailableProviders, type TokenPrice } from '@greenhouse/agent-core';
import {
  getUtcMonthPeriod,
  MEMBER_DEFAULT_SCOPE_ID,
  usageBudgetAccountId,
  type DatabaseProvider,
} from '@greenhouse/db';
import {
  METERED_SERVICES,
  type BudgetView,
  type MeteredService,
  type MeteringOverview,
  type ModelPriceView,
  type MySpendReport,
  type ServicePriceView,
  type SpendRow,
  type TokenPriceView,
} from '@greenhouse/types/metering';
import { getModelCatalog } from '../config/models.js';
import {
  getServiceCatalog,
  isServiceProviderConfigured,
  SERVICE_PROVIDERS,
  type PricedService,
} from '../config/services.js';
import { organizationScopeId, resolveLimitsFromRows } from './metering.js';

function tokenPriceView(price: TokenPrice | undefined): TokenPriceView | null {
  return price ? { input: price.input, output: price.output, cached_input: price.cachedInput ?? null } : null;
}

/** Every priced service, declared or not: a service missing from the file is shown as unpriced. */
export function listServicePrices(): ServicePriceView[] {
  const catalog = getServiceCatalog();
  const defaults: Record<PricedService, Pick<ServicePriceView, 'name' | 'unit'>> = {
    vision: { name: 'Image understanding', unit: 'token' },
    web_search: { name: 'Web search', unit: 'call' },
    page_read: { name: 'Page read', unit: 'call' },
    image_generation: { name: 'Image generation', unit: 'image' },
    computer: { name: 'Cloud computer', unit: 'minute' },
  };
  return (Object.keys(SERVICE_PROVIDERS) as PricedService[]).map((service) => {
    const definition = catalog[service];
    const providers = SERVICE_PROVIDERS[service].map((provider) => {
      const entry = definition?.providers[provider];
      const tokenPrice = tokenPriceView(entry?.tokenPrice);
      const price = entry?.price ?? null;
      const priceBySize = entry?.priceBySize ?? null;
      return {
        provider,
        configured: entry ? isServiceProviderConfigured(entry) : false,
        price,
        price_by_size: priceBySize,
        token_price: tokenPrice,
        priced: price !== null || priceBySize !== null || tokenPrice !== null,
      };
    });
    return {
      service,
      name: definition?.name ?? defaults[service].name,
      unit: definition?.unit ?? defaults[service].unit,
      enabled: definition ? definition.enabled : service !== 'computer',
      providers,
    };
  });
}

export function listModelPrices(): ModelPriceView[] {
  const catalog = getModelCatalog();
  return Object.entries(catalog.models).map(([id, entry]) => ({
    id,
    name: entry.name,
    configured: getAvailableProviders(id).length > 0,
    price: tokenPriceView(entry.price),
  }));
}

/** `YYYY-MM` → that UTC month; anything else → null. */
export function parseMonth(value: string | undefined): Date | null {
  if (!value) return new Date();
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(Number(match[1]), month - 1, 1));
}

function spendRows(rows: Awaited<ReturnType<DatabaseProvider['metering']['spendBy']>>): SpendRow[] {
  return rows.map((row) => ({ ...row }));
}

export async function buildMeteringOverview(db: DatabaseProvider, at: Date = new Date()): Promise<MeteringOverview> {
  const period = getUtcMonthPeriod(at);
  const query = { since: period.start, until: period.end };
  const [totals, byMember, byService, byClient, byAgentClient, unsettled, limitRows, accounts, users] =
    await Promise.all([
      db.metering.spendTotals(query),
      db.metering.spendBy('member', query),
      db.metering.spendBy('service', query),
      db.metering.spendBy('client', query),
      db.metering.spendBy('agent_client', query),
      db.metering.unsettledUsdMicros({
        period_start: period.start,
        period_end: period.end,
        scope_type: 'organization',
        scope_id: organizationScopeId(),
      }),
      db.metering.listLimits(),
      db.metering.listUsdAccounts({ period_start: period.start, period_end: period.end }),
      db.users.list(),
    ]);

  const account = (scopeType: string, scopeId: string) =>
    accounts.find((row) => row.scope_type === scopeType && row.scope_id === scopeId);
  const balance = (scopeType: string, scopeId: string) => {
    const row = account(scopeType, scopeId);
    return { spent_usd_micros: row?.spent_units ?? 0, reserved_usd_micros: row?.reserved_units ?? 0 };
  };
  const base = resolveLimitsFromRows(limitRows, {});
  const userLabel = new Map(users.map((user) => [user.id, user.nickname || user.email || user.id]));

  const services: BudgetView[] = METERED_SERVICES.map((service) => {
    const limit = resolveLimitsFromRows(limitRows, { service }).service;
    return {
      scope: 'service',
      scope_id: service,
      label: null,
      limit_usd_micros: limit.limit,
      source: limit.source,
      ...balance('service', service),
    };
  });

  const memberIds = new Set<string>();
  for (const row of limitRows) {
    if (row.scope_type === 'user' && row.scope_id !== MEMBER_DEFAULT_SCOPE_ID) memberIds.add(row.scope_id);
  }
  for (const row of accounts) if (row.scope_type === 'user') memberIds.add(row.scope_id);
  const members: BudgetView[] = [...memberIds].sort().map((userId) => {
    const limit = resolveLimitsFromRows(limitRows, { userId }).member;
    return {
      scope: 'member',
      scope_id: userId,
      label: userLabel.get(userId) ?? null,
      limit_usd_micros: limit.limit,
      source: limit.source,
      ...balance('user', userId),
    };
  });

  return {
    period,
    services: listServicePrices(),
    models: listModelPrices(),
    spend: {
      totals,
      by_member: spendRows(byMember).map((row) => ({ ...row, label: row.label ?? userLabel.get(row.key) ?? null })),
      by_service: spendRows(byService),
      by_client: spendRows(byClient),
      by_agent_client: spendRows(byAgentClient),
      unsettled_usd_micros: unsettled,
    },
    budgets: {
      organization: {
        scope: 'organization',
        scope_id: '',
        label: null,
        limit_usd_micros: base.organization.limit,
        source: base.organization.source,
        ...balance('organization', organizationScopeId()),
      },
      member_default: {
        scope: 'member_default',
        scope_id: '',
        label: null,
        limit_usd_micros: base.memberDefault.limit,
        source: base.memberDefault.source,
        spent_usd_micros: 0,
        reserved_usd_micros: 0,
      },
      services,
      members,
    },
  };
}

export async function buildMySpend(
  db: DatabaseProvider,
  userId: string,
  at: Date = new Date(),
): Promise<MySpendReport> {
  const period = getUtcMonthPeriod(at);
  const query = { since: period.start, until: period.end, user_id: userId };
  const [totals, byService, byClient, byAgentClient, limitRows, own] = await Promise.all([
    db.metering.spendTotals(query),
    db.metering.spendBy('service', query),
    db.metering.spendBy('client', query),
    db.metering.spendBy('agent_client', query),
    db.metering.getLimits([
      { scope_type: 'user', scope_id: MEMBER_DEFAULT_SCOPE_ID },
      { scope_type: 'user', scope_id: userId },
    ]),
    db.usageBudget.getAccount(
      usageBudgetAccountId({
        scope_type: 'user',
        scope_id: userId,
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
      }),
    ),
  ]);
  const limit = resolveLimitsFromRows(limitRows, { userId }).member;
  return {
    period,
    totals,
    by_service: spendRows(byService),
    by_client: spendRows(byClient),
    by_agent_client: spendRows(byAgentClient),
    budget: {
      scope: 'member',
      scope_id: userId,
      label: null,
      limit_usd_micros: limit.limit,
      source: limit.source,
      spent_usd_micros: own?.spent_units ?? 0,
      reserved_usd_micros: own?.reserved_units ?? 0,
    },
  };
}

export function isMeteredService(value: unknown): value is MeteredService {
  return typeof value === 'string' && (METERED_SERVICES as readonly string[]).includes(value);
}

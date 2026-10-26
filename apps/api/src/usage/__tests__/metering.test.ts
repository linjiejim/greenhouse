/**
 * The USD meter's own rules, against an in-memory DatabaseProvider: limit
 * resolution, attribution scopes, the release-only-before-I/O rule for service
 * calls, the refusal contract and alert thresholds.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeMeteringServices } from '../../../../../tests/helpers/metering-db.js';
import {
  budgetExceededMessage,
  budgetRefusalReason,
  findBudgetRefusal,
  localizedBudgetNotice,
  UsageBudgetAdmissionError,
} from '../budget-errors.js';
import {
  bindMeteringScope,
  currentMeteringScope,
  DEFAULT_MEMBER_MONTHLY_USD_MICROS,
  meteringClientForToolClient,
  meterServiceCall,
  reachedThreshold,
  resolveLimitsFromRows,
  resolveMeteringClient,
  runWithMeteringScope,
} from '../metering.js';

function fakeDb() {
  const metered = fakeMeteringServices();
  const db = {
    users: {
      getById: vi.fn(async (id: string) => ({ id, role: 'team', status: 'active', locale: 'zh' })),
      list: vi.fn(async () => []),
    },
    usageBudget: {
      ensureAccount: metered.ensureAccount,
      reserve: metered.reserve,
      settle: vi.fn(async () => []),
      release: vi.fn(async () => []),
    },
    metering: metered.metering,
    notifications: { createWithStatus: vi.fn(), countUnread: vi.fn(async () => 0) },
  };
  return { db, ...metered };
}

const limitRow = (scope_type: 'organization' | 'service' | 'user', scope_id: string, limit_units: number) => ({
  id: `ubl_${scope_type}_${scope_id}`,
  scope_type,
  scope_id,
  unit: 'usd_micros' as const,
  limit_units,
  updated_by: null,
  created_at: '2026-10-01T00:00:00.000Z',
  updated_at: '2026-10-01T00:00:00.000Z',
});

afterEach(() => {
  delete process.env.USAGE_BUDGET_MEMBER_MONTHLY_USD_MICROS;
  delete process.env.USAGE_BUDGET_ORG_MONTHLY_USD_MICROS;
  delete process.env.USAGE_BUDGET_SERVICE_MONTHLY_USD_MICROS;
});

describe('limit resolution', () => {
  it('prefers the admin row, then the env, then the built-in default', () => {
    expect(resolveLimitsFromRows([], { userId: 'u1' }).member).toEqual({
      limit: DEFAULT_MEMBER_MONTHLY_USD_MICROS,
      source: 'default',
    });
    process.env.USAGE_BUDGET_MEMBER_MONTHLY_USD_MICROS = '7000000';
    expect(resolveLimitsFromRows([], {}).memberDefault).toEqual({ limit: 7_000_000, source: 'env' });
    const rows = [limitRow('user', '*', 9_000_000), limitRow('user', 'u2', 1_000_000)];
    expect(resolveLimitsFromRows(rows, { userId: 'u1' }).member).toEqual({ limit: 9_000_000, source: 'default' });
    expect(resolveLimitsFromRows(rows, { userId: 'u2' }).member).toEqual({ limit: 1_000_000, source: 'override' });
  });

  it('lets a service without its own limit follow the resolved team limit', () => {
    // Admin team row → the service follows it, not the built-in $2,000.
    expect(
      resolveLimitsFromRows([limitRow('organization', 'default', 500_000_000)], { service: 'llm' }).service,
    ).toEqual({
      limit: 500_000_000,
      source: 'default',
    });
    // Team from env → the service follows the env.
    process.env.USAGE_BUDGET_ORG_MONTHLY_USD_MICROS = '300000000';
    expect(resolveLimitsFromRows([], { service: 'llm' }).service).toEqual({ limit: 300_000_000, source: 'default' });
    // A service env or row still wins.
    process.env.USAGE_BUDGET_SERVICE_MONTHLY_USD_MICROS = '7';
    expect(resolveLimitsFromRows([], { service: 'llm' }).service).toEqual({ limit: 7, source: 'env' });
    expect(resolveLimitsFromRows([limitRow('service', 'llm', 9)], { service: 'llm' }).service).toEqual({
      limit: 9,
      source: 'override',
    });
  });

  it('reads per-service and organization rows', () => {
    const rows = [limitRow('service', 'web_search', 3), limitRow('organization', 'default', 99)];
    const limits = resolveLimitsFromRows(rows, { service: 'web_search' });
    expect(limits.service).toEqual({ limit: 3, source: 'override' });
    expect(limits.organization).toEqual({ limit: 99, source: 'override' });
  });
});

describe('attribution', () => {
  it('maps tool-call surfaces onto metering clients', () => {
    expect(meteringClientForToolClient('web_chat')).toBe('web');
    expect(meteringClientForToolClient('mcp')).toBe('mcp');
    expect(meteringClientForToolClient('automation')).toBe('automation');
    expect(meteringClientForToolClient('mobile')).toBe('mobile');
  });

  it('explicit client > scope > caller default', () => {
    expect(resolveMeteringClient(undefined, 'scheduled-task')).toBe('automation');
    expect(resolveMeteringClient('system', 'plugin-upkeep')).toBe('system');
    runWithMeteringScope({ userId: 'u1', client: 'mcp' }, () => {
      expect(resolveMeteringClient(undefined, 'scheduled-task')).toBe('mcp');
      expect(resolveMeteringClient('mobile', 'chat')).toBe('mobile');
    });
  });

  it('runs a bound tool inside its scope without touching the shared registry', async () => {
    const execute = vi.fn(async () => currentMeteringScope());
    const shared = { external_search: { description: 'x', execute } };
    const bound = bindMeteringScope(shared, { userId: 'u1', client: 'mcp', oauthClientId: 'oc1' });
    expect(shared.external_search.execute).toBe(execute);
    await expect(bound.external_search.execute({}, {})).resolves.toEqual({
      userId: 'u1',
      client: 'mcp',
      oauthClientId: 'oc1',
    });
  });
});

describe('meterServiceCall', () => {
  it('reserves the dearest candidate, settles the provider that answered and records the fact', async () => {
    const f = fakeDb();
    const value = await runWithMeteringScope({ userId: 'u1', client: 'mcp', oauthClientId: 'oc1' }, () =>
      meterServiceCall(
        {
          db: f.db as never,
          service: 'web_search',
          caller: 'external_search',
          unitKind: 'call',
          candidateProviders: ['tavily', 'brave'],
        },
        async (io) => {
          io.markProviderIoStarted();
          return { value: 'results', provider: 'brave' };
        },
      ),
    );
    expect(value).toBe('results');
    expect(f.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        estimated_units: 8_000,
        account_ids: ['user:u1:usd_micros', 'service:web_search:usd_micros', 'organization:default:usd_micros'],
        metadata: expect.objectContaining({ client: 'mcp', oauth_client_id: 'oc1', service: 'web_search' }),
      }),
    );
    expect(f.db.usageBudget.settle).toHaveBeenCalledWith(expect.objectContaining({ actual_units: 5_000 }));
    expect(f.metering.recordService).toHaveBeenCalledWith(
      expect.objectContaining({
        user_id: 'u1',
        service: 'web_search',
        provider: 'brave',
        unit_kind: 'call',
        units: 1,
        cost_usd_micros: 5_000,
        client: 'mcp',
        oauth_client_id: 'oc1',
      }),
    );
  });

  it('settles an unpriced success at zero instead of charging the reservation', async () => {
    const f = fakeDb();
    await runWithMeteringScope({ userId: 'u1', client: 'web' }, () =>
      meterServiceCall(
        {
          db: f.db as never,
          service: 'web_search',
          caller: 'external_search',
          unitKind: 'call',
          candidateProviders: ['tavily', 'firecrawl'],
        },
        async (io) => {
          io.markProviderIoStarted();
          // Tavily failed over to Firecrawl, which has no price.
          return { value: 'results', provider: 'firecrawl' };
        },
      ),
    );
    expect(f.reserve).toHaveBeenCalledWith(expect.objectContaining({ estimated_units: 8_000 }));
    expect(f.db.usageBudget.settle).toHaveBeenCalledWith(
      expect.objectContaining({ actual_units: 0, metadata: expect.objectContaining({ cost_known: false }) }),
    );
    expect(f.metering.recordService).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'firecrawl', cost_usd_micros: null, price_applied: null }),
    );
  });

  it('releases a call that failed before provider I/O and keeps one that failed after', async () => {
    const f = fakeDb();
    const call = (startIo: boolean) =>
      runWithMeteringScope({ userId: 'u1', client: 'web' }, () =>
        meterServiceCall(
          {
            db: f.db as never,
            service: 'web_search',
            caller: 'external_search',
            unitKind: 'call',
            candidateProviders: ['tavily'],
          },
          async (io) => {
            if (startIo) io.markProviderIoStarted();
            throw new Error('network');
          },
        ),
      );
    await expect(call(false)).rejects.toThrow('network');
    expect(f.db.usageBudget.release).toHaveBeenCalledTimes(1);
    await expect(call(true)).rejects.toThrow('network');
    expect(f.db.usageBudget.release).toHaveBeenCalledTimes(1);
    expect(f.metering.recordService).not.toHaveBeenCalled();
  });

  it('records an unpriced call with an unknown cost and reserves nothing', async () => {
    const f = fakeDb();
    await runWithMeteringScope({ userId: 'u1', client: 'web' }, () =>
      meterServiceCall(
        {
          db: f.db as never,
          service: 'web_search',
          caller: 'external_search',
          unitKind: 'call',
          candidateProviders: ['firecrawl'],
        },
        async () => ({ value: null, provider: 'firecrawl' }),
      ),
    );
    expect(f.reserve).not.toHaveBeenCalled();
    expect(f.metering.recordService).toHaveBeenCalledWith(expect.objectContaining({ cost_usd_micros: null }));
  });

  it('refuses before I/O with a refusal naming the exhausted service', async () => {
    const f = fakeDb();
    f.metering.getAccounts.mockImplementation(async (ids: readonly string[]) =>
      ids.map((id) => ({
        ...f.accounts.get(id)!,
        spent_units: id.startsWith('service:') ? f.accounts.get(id)!.limit_units : 0,
      })),
    );
    const call = vi.fn();
    const err = await runWithMeteringScope({ userId: 'u1', client: 'mcp' }, () =>
      meterServiceCall(
        {
          db: f.db as never,
          service: 'page_read',
          caller: 'external_search',
          unitKind: 'call',
          candidateProviders: ['jina'],
        },
        call,
      ),
    ).catch((error: unknown) => error);
    expect(call).not.toHaveBeenCalled();
    expect(findBudgetRefusal(err)).toMatchObject({
      status: 429,
      code: 'usage_budget_exceeded',
      refusal: { unit: 'usd_micros', level: 'service', service: 'page_read' },
    });
    expect(budgetRefusalReason(err)).toContain('「网页读取」服务额度已用完');
  });
});

describe('refusal contract', () => {
  it('gives the agent both languages and the person one', () => {
    const refusal = { unit: 'usd_micros' as const, level: 'organization' as const };
    expect(budgetExceededMessage(refusal)).toBe(
      "本月团队额度已用完，重试不会成功。请联系管理员提高额度。 (This month's team budget is used up, so retrying will not help. Ask an administrator to raise it.)",
    );
    expect(localizedBudgetNotice(refusal, 'en')).toMatch(/^This month's team budget/);
  });

  it('finds a refusal through wrapping errors, but not a budget outage', () => {
    const refusal = new UsageBudgetAdmissionError('over', 429, 'usage_budget_exceeded');
    expect(findBudgetRefusal(new Error('retry failed', { cause: new Error('x', { cause: refusal }) }))).toBe(refusal);
    expect(findBudgetRefusal(new UsageBudgetAdmissionError('down', 503, 'usage_budget_unavailable'))).toBeNull();
    expect(budgetRefusalReason(new Error('boom'))).toBeNull();
  });
});

describe('alert thresholds', () => {
  it('reports the highest threshold reached, and nothing for a deliberate zero limit', () => {
    expect(reachedThreshold({ limit_units: 100, spent_units: 79 })).toBeNull();
    expect(reachedThreshold({ limit_units: 100, spent_units: 80 })).toBe(80);
    expect(reachedThreshold({ limit_units: 100, spent_units: 130 })).toBe(100);
    expect(reachedThreshold({ limit_units: 0, spent_units: 0 })).toBeNull();
  });
});

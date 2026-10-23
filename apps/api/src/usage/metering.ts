/**
 * USD metering — the one path every paid external call goes through.
 *
 * The team pays for every model call, search, page read and image a member (or
 * a member's agent) makes, so each one is:
 *   1. priced (models.yaml `price`, services.yaml) — unpriced calls cost zero
 *      and are flagged, never refused for that;
 *   2. reserved in USD micros, atomically, against three monthly accounts —
 *      the member, the service and the organization — before provider I/O;
 *   3. settled with the actual cost afterwards, or released when it failed
 *      before provider I/O. Once I/O may have started an unknown outcome stays
 *      reserved and the TTL sweeper charges the estimate;
 *   4. recorded as a fact with its attribution: member, service, provider,
 *      model, client and — for a member's agent over MCP — the OAuth client.
 *
 * Model calls enter through `reserveUserTokenBudget` (llm/usage-budget.ts),
 * which keeps the older token accounts in parallel and reserves USD here.
 * Everything else uses `reserveSpend` / `meterServiceCall` directly.
 *
 * Attribution rides an AsyncLocalStorage scope (`runWithMeteringScope`): set
 * once where a request enters (MCP, Agent API, Chat, automations) and read by
 * tools that are built once and shared (web search has no user of its own).
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import {
  getDb,
  getUtcMonthPeriod,
  MEMBER_DEFAULT_SCOPE_ID,
  UsageBudgetError,
  UsageBudgetExceededError,
  type DatabaseProvider,
  type UsageBudgetAccountRow,
  type UsageBudgetLimitRow,
  type UserRow,
} from '@greenhouse/db';
import {
  BUDGET_ALERT_THRESHOLDS,
  type BudgetLevel,
  type BudgetLimitSource,
  type MeteredService,
  type MeteringClient,
  type ServiceUnitKind,
} from '@greenhouse/types/metering';
import { APP_CLIENT_HEADER, parseAppClient, type ToolCallClient } from '@greenhouse/types/usage';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { ToolRegistry } from '../agent.js';
import type { PricedService } from '../config/services.js';
import { connectionManager } from '../ws/connection-manager.js';
import { queueMobilePush } from '../notifications/push/queue.js';
import { budgetExceededMessage, UsageBudgetAdmissionError, type BudgetRefusal } from './budget-errors.js';
import {
  effectiveServicePrice,
  maxServiceUnitCostMicros,
  serviceUnitCostMicros,
  syncPriceOverrides,
  unitPriceSnapshot,
} from './pricing.js';

export const SERVICE_BUDGET_TTL_MS = 5 * 60_000;

// ─── Attribution scope ───────────────────────────────────

export interface MeteringScope {
  /** The member whose budget pays. */
  userId?: string;
  client: MeteringClient;
  /** OAuth client of the member's agent (MCP). */
  oauthClientId?: string | null;
  sessionId?: string;
  runId?: string;
}

const scopeStorage = new AsyncLocalStorage<MeteringScope>();

/** Run `fn` with `scope` as the attribution of every metered call inside it. */
export function runWithMeteringScope<T>(scope: MeteringScope, fn: () => T): T {
  return scopeStorage.run(scope, fn);
}

export function currentMeteringScope(): MeteringScope | undefined {
  return scopeStorage.getStore();
}

/**
 * A copy of `tools` whose `execute` runs inside `scope`. Tools built once and
 * shared (web search) learn who is calling only this way; the input registry is
 * never mutated.
 */
export function bindMeteringScope(tools: ToolRegistry, scope: MeteringScope): ToolRegistry {
  const bound: ToolRegistry = {};
  for (const [toolName, definition] of Object.entries(tools)) {
    if (!definition || typeof definition !== 'object' || typeof definition.execute !== 'function') {
      bound[toolName] = definition;
      continue;
    }
    const original = definition.execute;
    bound[toolName] = {
      ...definition,
      execute: (input: unknown, options: unknown) =>
        scopeStorage.run(scope, () => original.call(definition, input, options)),
    };
  }
  return bound;
}

/** Tool-call counters and metering name the same surfaces slightly differently. */
export function meteringClientForToolClient(client: ToolCallClient): MeteringClient {
  switch (client) {
    case 'web_chat':
    case 'browser':
      return 'web';
    case 'subagent':
      return 'system';
    default:
      return client;
  }
}

/** A plain API request: the mobile app says so in its header, anything else is the web app. */
export function meteringClientForRequest(c: Context): MeteringClient {
  return parseAppClient(c.req.header(APP_CLIENT_HEADER)) === 'mobile' ? 'mobile' : 'web';
}

/** Where a caller's calls come from when nobody set a scope. */
const CALLER_CLIENTS: Record<string, MeteringClient> = {
  chat: 'web',
  'title-gen': 'web',
  digest: 'web',
  'scheduled-task': 'automation',
  'feishu-bot': 'feishu',
  'memory-consolidation': 'system',
};

export function resolveMeteringClient(explicit: MeteringClient | undefined, caller: string): MeteringClient {
  return explicit ?? currentMeteringScope()?.client ?? CALLER_CLIENTS[caller] ?? 'web';
}

// ─── Limits ──────────────────────────────────────────────

/** $50 per member per month unless an admin or the env says otherwise. */
export const DEFAULT_MEMBER_MONTHLY_USD_MICROS = 50_000_000;
/** $2,000 for the whole team. */
export const DEFAULT_ORG_MONTHLY_USD_MICROS = 2_000_000_000;
/*
 * A service has no default of its own: without an admin row or
 * USAGE_BUDGET_SERVICE_MONTHLY_USD_MICROS it follows the organization's
 * resolved limit, so it is capped only by the team (see resolveLimitsFromRows).
 */

const DEFAULT_ORG_SCOPE_ID = 'default';

export function organizationScopeId(): string {
  return process.env.USAGE_BUDGET_ORG_SCOPE_ID?.trim() || DEFAULT_ORG_SCOPE_ID;
}

export interface ResolvedLimit {
  limit: number;
  source: BudgetLimitSource;
}

function envLimit(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new UsageBudgetAdmissionError(
      `Usage budget configuration ${name} must be a non-negative integer (USD micros)`,
      503,
      'usage_budget_configuration_invalid',
    );
  }
  return parsed;
}

function fromEnvOrDefault(name: string, fallback: number): ResolvedLimit {
  const env = envLimit(name);
  return env === undefined ? { limit: fallback, source: 'default' } : { limit: env, source: 'env' };
}

/** Admin row → deployment env → built-in default, for every level one call touches. */
export function resolveLimitsFromRows(
  rows: readonly UsageBudgetLimitRow[],
  input: { userId?: string; service?: string },
): { organization: ResolvedLimit; service: ResolvedLimit; memberDefault: ResolvedLimit; member: ResolvedLimit } {
  const find = (scopeType: UsageBudgetLimitRow['scope_type'], scopeId: string) =>
    rows.find((row) => row.scope_type === scopeType && row.scope_id === scopeId);
  const orgRow = find('organization', organizationScopeId());
  const serviceRow = input.service ? find('service', input.service) : undefined;
  const defaultRow = find('user', MEMBER_DEFAULT_SCOPE_ID);
  const memberRow = input.userId ? find('user', input.userId) : undefined;
  const memberDefault: ResolvedLimit = defaultRow
    ? { limit: defaultRow.limit_units, source: 'override' }
    : fromEnvOrDefault('USAGE_BUDGET_MEMBER_MONTHLY_USD_MICROS', DEFAULT_MEMBER_MONTHLY_USD_MICROS);
  const organization: ResolvedLimit = orgRow
    ? { limit: orgRow.limit_units, source: 'override' }
    : fromEnvOrDefault('USAGE_BUDGET_ORG_MONTHLY_USD_MICROS', DEFAULT_ORG_MONTHLY_USD_MICROS);
  const serviceEnv = envLimit('USAGE_BUDGET_SERVICE_MONTHLY_USD_MICROS');
  return {
    organization,
    // No service row and no service env: the service follows the team's limit, wherever that came from.
    service: serviceRow
      ? { limit: serviceRow.limit_units, source: 'override' }
      : serviceEnv !== undefined
        ? { limit: serviceEnv, source: 'env' }
        : { limit: organization.limit, source: 'default' },
    memberDefault,
    // A member without an override follows the member default, wherever that came from.
    member: memberRow ? { limit: memberRow.limit_units, source: 'override' } : { ...memberDefault, source: 'default' },
  };
}

export async function resolveLimits(db: DatabaseProvider, input: { userId?: string; service?: string }) {
  const rows = await db.metering.getLimits([
    { scope_type: 'organization', scope_id: organizationScopeId() },
    { scope_type: 'user', scope_id: MEMBER_DEFAULT_SCOPE_ID },
    ...(input.service ? [{ scope_type: 'service' as const, scope_id: input.service }] : []),
    ...(input.userId ? [{ scope_type: 'user' as const, scope_id: input.userId }] : []),
  ]);
  return resolveLimitsFromRows(rows, input);
}

interface SpendAccounts {
  /** Account id → the level it charges. */
  levels: Map<string, BudgetLevel>;
  ids: string[];
}

/**
 * Materialize this month's USD accounts for one call. Limits are re-applied on
 * every call, so an admin's change takes effect on the next call of the period.
 */
async function ensureSpendAccounts(
  db: DatabaseProvider,
  input: { userId?: string; service: MeteredService },
): Promise<SpendAccounts> {
  const period = getUtcMonthPeriod();
  const limits = await resolveLimits(db, input);
  const wanted: Array<{
    level: BudgetLevel;
    scope_type: 'user' | 'service' | 'organization';
    scope_id: string;
    limit: number;
  }> = [
    ...(input.userId
      ? [{ level: 'member' as const, scope_type: 'user' as const, scope_id: input.userId, limit: limits.member.limit }]
      : []),
    { level: 'service', scope_type: 'service', scope_id: input.service, limit: limits.service.limit },
    {
      level: 'organization',
      scope_type: 'organization',
      scope_id: organizationScopeId(),
      limit: limits.organization.limit,
    },
  ];
  const accounts = await Promise.all(
    wanted.map((entry) =>
      db.usageBudget.ensureAccount({
        scope_type: entry.scope_type,
        scope_id: entry.scope_id,
        unit: 'usd_micros',
        period_start: period.start,
        period_end: period.end,
        limit_units: entry.limit,
        bootstrap_metadata: { metering: true, level: entry.level },
        update_existing_limit: true,
      }),
    ),
  );
  const levels = new Map<string, BudgetLevel>();
  accounts.forEach((account, index) => levels.set(account.id, wanted[index]!.level));
  return { levels, ids: accounts.map((account) => account.id) };
}

/**
 * A member reads about their own budget first; then the team's, which a
 * service without its own limit merely mirrors; a service cap last.
 */
const LEVEL_ORDER: BudgetLevel[] = ['member', 'organization', 'service'];

function refusalFor(levels: Map<string, BudgetLevel>, accountIds: readonly string[], service: MeteredService) {
  const exceeded = new Set(accountIds.map((id) => levels.get(id)).filter((level): level is BudgetLevel => !!level));
  const level = LEVEL_ORDER.find((candidate) => exceeded.has(candidate)) ?? 'organization';
  const refusal: BudgetRefusal = { unit: 'usd_micros', level, ...(level === 'service' ? { service } : {}) };
  return new UsageBudgetAdmissionError(
    budgetExceededMessage(refusal),
    429,
    'usage_budget_exceeded',
    undefined,
    refusal,
  );
}

export async function requireBudgetOwner(db: DatabaseProvider, userId: string): Promise<UserRow> {
  const user = await db.users.getById(userId);
  if (!user || user.status !== 'active' || (user.role !== 'team' && user.role !== 'super')) {
    throw new UsageBudgetAdmissionError(
      'The account responsible for this request is unavailable',
      403,
      'usage_budget_subject_unavailable',
    );
  }
  return user;
}

function toSpendAdmissionError(err: unknown): UsageBudgetAdmissionError {
  if (err instanceof UsageBudgetAdmissionError) return err;
  if (err instanceof UsageBudgetError) {
    const status = err.code === 'usage_budget_account_unavailable' ? 403 : 503;
    return new UsageBudgetAdmissionError('Usage budget is unavailable for this request', status, err.code, {
      cause: err,
    });
  }
  return new UsageBudgetAdmissionError(
    'Usage budget service is temporarily unavailable',
    503,
    'usage_budget_unavailable',
    {
      cause: err,
    },
  );
}

// ─── Leases ──────────────────────────────────────────────

export interface SpendAttribution {
  userId: string | null;
  service: MeteredService;
  provider: string;
  model: string | null;
  client: MeteringClient;
  oauthClientId: string | null;
  caller: string;
  sessionId: string | null;
  runId: string | null;
}

/**
 * One call's USD reservation. An unpriced or free call holds no reservation
 * (`reserved` false) but passed the same admission check: an exhausted budget
 * refuses even a zero-cost call.
 */
export class SpendLease {
  private providerIoStarted = false;
  /** Debited at settlement without a reservation (see settle). */
  private charged = false;

  constructor(
    private readonly db: DatabaseProvider,
    public readonly idempotencyKey: string,
    public readonly estimatedUsdMicros: number,
    public readonly reserved: boolean,
    public readonly accountIds: readonly string[],
    public readonly attribution: SpendAttribution,
  ) {}

  markProviderIoStarted(): void {
    this.providerIoStarted = true;
  }

  /** The budget key the fact links to: set once the accounts were debited through the ledger. */
  get ledgerKey(): string | null {
    return this.reserved || this.charged ? this.idempotencyKey : null;
  }

  /** Release when the call failed before provider I/O; a no-op once I/O may have started. */
  async releaseBeforeProviderIo(reason: string): Promise<boolean> {
    if (this.providerIoStarted || !this.reserved) return false;
    await this.db.usageBudget.release({ idempotency_key: this.idempotencyKey, reason });
    return true;
  }

  /**
   * Release after the provider gave a definite refusal (an HTTP 4xx: malformed
   * request, rate limited, …) or provably never received the request (the
   * connection was refused): nothing was billed, so nothing is owed. Unlike
   * `releaseBeforeProviderIo` this applies once I/O started — never use it for
   * an outcome that is unknown (5xx, a timeout, a dropped connection).
   */
  async releaseAfterProviderRefusal(reason: string): Promise<boolean> {
    if (!this.reserved) return false;
    await this.db.usageBudget.release({ idempotency_key: this.idempotencyKey, reason });
    return true;
  }

  /**
   * Settle a call that SUCCEEDED at its actual cost, then tell the owners of any
   * account that crossed a threshold. Alerts never fail the call.
   *
   * `null` = the call succeeded but its provider is unpriced (e.g. the search
   * fell through to an unpriced provider after reserving at a priced one's
   * rate): it settles at 0 and the fact keeps a NULL cost. A call whose outcome
   * is unknown never comes here — its reservation stays for the TTL sweeper.
   *
   * A lease with no reservation (the call was unpriced when it started) that
   * settles at a positive cost — an admin priced it mid-call, the provider
   * reported a cost — is still debited on all three accounts, through the
   * ledger and without a limit check: the money is already spent.
   */
  async settle(actualUsdMicros: number | null, metadata?: Readonly<Record<string, unknown>>): Promise<void> {
    let debited = 0;
    if (this.reserved) {
      debited = Math.max(0, Math.ceil(actualUsdMicros ?? 0));
      await this.db.usageBudget.settle({
        idempotency_key: this.idempotencyKey,
        actual_units: debited,
        metadata: { ...metadata, cost_known: actualUsdMicros !== null },
      });
    } else if (actualUsdMicros !== null && actualUsdMicros > 0) {
      debited = Math.ceil(actualUsdMicros);
      const { attribution } = this;
      await this.db.usageBudget.chargeUnreserved({
        account_ids: this.accountIds,
        idempotency_key: this.idempotencyKey,
        actual_units: debited,
        caller: attribution.caller,
        ...(attribution.userId ? { user_id: attribution.userId } : {}),
        ...(attribution.runId ? { run_id: attribution.runId } : {}),
        provider_id: attribution.provider,
        ...(attribution.model ? { model_id: attribution.model } : {}),
        metadata: { ...metadata, service: attribution.service, client: attribution.client },
      });
      this.charged = true;
    }
    if (debited > 0) await publishBudgetAlerts(this.db, this.accountIds);
  }
}

export interface ReserveSpendInput {
  db: DatabaseProvider;
  service: MeteredService;
  provider: string;
  model?: string | null;
  caller: string;
  /** Null or zero = unpriced / free: admission check only, nothing reserved. */
  estimatedUsdMicros: number | null;
  /** Defaults to the current metering scope. */
  scope?: MeteringScope;
  /** The member who pays; defaults to the scope's member. */
  userId?: string;
  client?: MeteringClient;
  oauthClientId?: string | null;
  sessionId?: string;
  runId?: string;
  idempotencyKey?: string;
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
  /** The caller already verified the member is an active internal account. */
  ownerVerified?: boolean;
}

/** Reserve one call's USD against the member, the service and the organization. */
export async function reserveSpend(input: ReserveSpendInput): Promise<SpendLease> {
  const scope = input.scope ?? currentMeteringScope();
  const userId = input.userId ?? scope?.userId;
  const attribution: SpendAttribution = {
    userId: userId ?? null,
    service: input.service,
    provider: input.provider,
    model: input.model ?? null,
    client: resolveMeteringClient(input.client ?? scope?.client, input.caller),
    oauthClientId: input.oauthClientId ?? scope?.oauthClientId ?? null,
    caller: input.caller,
    sessionId: input.sessionId ?? scope?.sessionId ?? null,
    runId: input.runId ?? scope?.runId ?? input.sessionId ?? scope?.sessionId ?? null,
  };
  if (!userId) {
    // Every entry point sets a scope; reaching here means a new one forgot to.
    // Still charge the service and the team rather than make the call free.
    logger.warn('[metering] call without a member in scope — charged to service and organization only', {
      service: input.service,
      caller: input.caller,
    });
  }
  const idempotencyKey = input.idempotencyKey ?? `${input.caller}:usd:${randomUUID()}`;
  const estimate =
    input.estimatedUsdMicros === null ? 0 : Math.max(0, Math.ceil(Number(input.estimatedUsdMicros) || 0));
  try {
    if (userId && !input.ownerVerified) await requireBudgetOwner(input.db, userId);
    const accounts = await ensureSpendAccounts(input.db, { userId, service: input.service });
    if (estimate === 0) {
      const snapshot = await input.db.metering.getAccounts(accounts.ids);
      const exhausted = snapshot.filter(
        (account) => account.spent_units + account.reserved_units >= account.limit_units,
      );
      if (exhausted.length > 0) {
        await publishBudgetAlerts(
          input.db,
          exhausted.map((account) => account.id),
        );
        throw refusalFor(
          accounts.levels,
          exhausted.map((account) => account.id),
          input.service,
        );
      }
      return new SpendLease(input.db, idempotencyKey, 0, false, accounts.ids, attribution);
    }
    try {
      await input.db.usageBudget.reserve({
        account_ids: accounts.ids,
        idempotency_key: idempotencyKey,
        estimated_units: estimate,
        caller: input.caller,
        ...(userId ? { user_id: userId } : {}),
        ...(attribution.runId ? { run_id: attribution.runId } : {}),
        provider_id: input.provider,
        ...(input.model ? { model_id: input.model } : {}),
        ttl_ms: input.ttlMs ?? SERVICE_BUDGET_TTL_MS,
        metadata: {
          ...input.metadata,
          service: input.service,
          client: attribution.client,
          oauth_client_id: attribution.oauthClientId,
        },
      });
    } catch (err) {
      if (err instanceof UsageBudgetExceededError) {
        const ids = err.accounts.map((account) => account.account_id);
        await publishBudgetAlerts(input.db, ids);
        throw refusalFor(accounts.levels, ids, input.service);
      }
      throw err;
    }
    return new SpendLease(input.db, idempotencyKey, estimate, true, accounts.ids, attribution);
  } catch (err) {
    throw toSpendAdmissionError(err);
  }
}

/**
 * The lease of a reservation made earlier — by another request, another API
 * process, or before a restart — rebuilt from its idempotency key so it can be
 * settled now. Long-lived spend (a cloud computer billed per minute in blocks)
 * keeps only the key; the accounts come from the reservation group, or, when
 * nothing was reserved because the service was unpriced at the time, from this
 * period's accounts, so a price set since still debits all three levels.
 */
export async function restoreSpendLease(
  db: DatabaseProvider,
  input: {
    idempotencyKey: string;
    estimatedUsdMicros: number;
    attribution: SpendAttribution;
  },
): Promise<SpendLease> {
  const group = await db.usageBudget.getReservationGroup(input.idempotencyKey);
  const accountIds = group.length
    ? group.map((row) => row.account_id)
    : (
        await ensureSpendAccounts(db, {
          ...(input.attribution.userId ? { userId: input.attribution.userId } : {}),
          service: input.attribution.service,
        })
      ).ids;
  const lease = new SpendLease(
    db,
    input.idempotencyKey,
    group.length ? input.estimatedUsdMicros : 0,
    group.length > 0,
    accountIds,
    input.attribution,
  );
  // The call this lease paid for has run; settling it is all that is left.
  lease.markProviderIoStarted();
  return lease;
}

// ─── Non-model services ──────────────────────────────────

export interface ServiceFact {
  provider: string;
  model?: string | null;
  units: number;
  unitKind: ServiceUnitKind;
  /** Null = unpriced. */
  costUsdMicros: number | null;
  /** The price the call was settled at (kept on the fact so later price changes never rewrite history). */
  priceApplied?: Readonly<Record<string, unknown>> | null;
  metadata?: Readonly<Record<string, unknown>>;
}

/** Settle the lease at the fact's cost and append the fact. Never throws. */
export async function settleServiceFact(db: DatabaseProvider, lease: SpendLease, fact: ServiceFact): Promise<void> {
  try {
    await lease.settle(fact.costUsdMicros, { provider: fact.provider, units: fact.units });
  } catch (err) {
    // The reservation stays and the sweeper charges the estimate.
    logger.warn('[metering] could not settle a service call', {
      service: lease.attribution.service,
      key: lease.idempotencyKey,
      error: toErrorMessage(err),
    });
  }
  try {
    await db.metering.recordService({
      user_id: lease.attribution.userId,
      service: lease.attribution.service,
      provider: fact.provider,
      model: fact.model ?? lease.attribution.model,
      units: Math.max(0, Math.ceil(fact.units)),
      unit_kind: fact.unitKind,
      cost_usd_micros: fact.costUsdMicros,
      client: lease.attribution.client,
      oauth_client_id: lease.attribution.oauthClientId,
      caller: lease.attribution.caller,
      run_id: lease.attribution.runId,
      session_id: lease.attribution.sessionId,
      budget_idempotency_key: lease.ledgerKey,
      price_applied: fact.costUsdMicros === null ? null : (fact.priceApplied ?? null),
      metadata: fact.metadata,
    });
  } catch (err) {
    logger.warn('[metering] could not record a service call', {
      service: lease.attribution.service,
      error: toErrorMessage(err),
    });
  }
}

export interface MeterServiceCallInput {
  db?: DatabaseProvider;
  service: PricedService;
  caller: string;
  unitKind: ServiceUnitKind;
  /** Providers the call may fall through; the reservation covers the dearest priced one. */
  candidateProviders: readonly string[];
  /** Units reserved (default 1). */
  estimatedUnits?: number;
  scope?: MeteringScope;
  ttlMs?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface MeteredServiceResult<T> {
  value: T;
  /** The provider that actually answered. */
  provider: string;
  units?: number;
  model?: string | null;
  /** Override the price list (e.g. provider-reported cost); undefined = price list. */
  costUsdMicros?: number | null;
  metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Meter one call to a non-model service: reserve → call → settle + record. The
 * callback calls `markProviderIoStarted()` right before its first network
 * request; a failure before that releases the reservation, after it the
 * reservation stays for the sweeper (the provider may have billed).
 */
export async function meterServiceCall<T>(
  input: MeterServiceCallInput,
  call: (io: { markProviderIoStarted(): void }) => Promise<MeteredServiceResult<T>>,
): Promise<T> {
  const db = input.db ?? getDb();
  await syncPriceOverrides(db);
  const units = Math.max(1, Math.ceil(input.estimatedUnits ?? 1));
  const unitCost = maxServiceUnitCostMicros(input.service, input.candidateProviders);
  const lease = await reserveSpend({
    db,
    service: input.service,
    provider: input.candidateProviders.length === 1 ? input.candidateProviders[0]! : input.candidateProviders.join('|'),
    caller: input.caller,
    estimatedUsdMicros: unitCost === null ? null : unitCost * units,
    ...(input.scope ? { scope: input.scope } : {}),
    ttlMs: input.ttlMs ?? SERVICE_BUDGET_TTL_MS,
    ...(input.metadata ? { metadata: input.metadata } : {}),
  });
  let result: MeteredServiceResult<T>;
  try {
    result = await call({ markProviderIoStarted: () => lease.markProviderIoStarted() });
  } catch (err) {
    await lease.releaseBeforeProviderIo(`${input.service}_failed_before_io`).catch(() => {});
    throw err;
  }
  const actualUnits = Math.max(0, Math.ceil(result.units ?? units));
  // Priced as of settlement: an admin change mid-call applies to this call.
  await syncPriceOverrides(db);
  const cost =
    result.costUsdMicros !== undefined
      ? result.costUsdMicros
      : serviceUnitCostMicros(input.service, result.provider, actualUnits);
  const effective = effectiveServicePrice(input.service, result.provider);
  await settleServiceFact(db, lease, {
    provider: result.provider,
    model: result.model ?? null,
    units: actualUnits,
    unitKind: input.unitKind,
    costUsdMicros: cost,
    priceApplied:
      result.costUsdMicros === undefined && effective?.price !== undefined
        ? unitPriceSnapshot(effective.price, effective.source, { unit: input.unitKind })
        : { source: 'provider_reported' },
    ...(result.metadata ? { metadata: result.metadata } : {}),
  });
  return result.value;
}

// ─── Alerts ──────────────────────────────────────────────

const ALERT_LEVEL: Record<string, BudgetLevel> = {
  user: 'member',
  service: 'service',
  organization: 'organization',
};

/** The highest threshold an account has reached, or null. Zero limits are a deliberate block, not news. */
export function reachedThreshold(account: Pick<UsageBudgetAccountRow, 'limit_units' | 'spent_units'>) {
  if (account.limit_units <= 0) return null;
  let reached: (typeof BUDGET_ALERT_THRESHOLDS)[number] | null = null;
  for (const threshold of BUDGET_ALERT_THRESHOLDS) {
    if (account.spent_units * 100 >= account.limit_units * threshold) reached = threshold;
  }
  return reached;
}

function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(2)}`;
}

function alertCopy(account: UsageBudgetAccountRow, threshold: number, locale: string): { title: string; body: string } {
  const level = ALERT_LEVEL[account.scope_type] ?? 'organization';
  const en = locale === 'en';
  const limit = formatUsd(account.limit_units);
  const scope =
    level === 'member'
      ? en
        ? 'Your monthly budget'
        : '你本月的个人额度'
      : level === 'service'
        ? en
          ? `The monthly ${account.scope_id} budget`
          : `本月「${account.scope_id}」服务额度`
        : en
          ? "The team's monthly budget"
          : '本月团队额度';
  if (threshold >= 100) {
    return {
      title: en ? `${scope} is used up` : `${scope}已用完`,
      body: en
        ? `${scope} (${limit}) is used up. Calls that cost money are refused until an administrator raises the limit or the month ends.`
        : `${scope}（${limit}）已用完，付费调用会被拒绝，直到管理员提高额度或下月重置。`,
    };
  }
  return {
    title: en ? `${scope} is ${threshold}% used` : `${scope}已用 ${threshold}%`,
    body: en
      ? `${scope} (${limit}) has reached ${threshold}%. Calls are refused once it is used up.`
      : `${scope}（${limit}）已用到 ${threshold}%，用完后付费调用会被拒绝。`,
  };
}

async function publishAlert(
  db: DatabaseProvider,
  recipient: UserRow,
  account: UsageBudgetAccountRow,
  threshold: number,
) {
  const copy = alertCopy(account, threshold, recipient.locale);
  let result;
  try {
    result = await db.notifications.createWithStatus({
      user_id: recipient.id,
      kind: 'budget_attention',
      title: copy.title,
      body: copy.body,
      payload: {
        account_id: account.id,
        scope_type: account.scope_type,
        scope_id: account.scope_id,
        threshold,
        limit_usd_micros: account.limit_units,
        period_start: account.period_start,
        period_end: account.period_end,
      },
      // One fact per account × period × threshold (the account id is per period).
      dedupe_key: `usage-budget:${account.id}:${threshold}`,
    });
  } catch (err) {
    // A reused key with other words (the limit changed since) is the same alert.
    if ((err as { code?: string }).code === 'notification_idempotency_conflict') return;
    throw err;
  }
  await queueMobilePush(db, result.notification);
  if (!result.created) return;
  const unread = await db.notifications.countUnread(recipient.id);
  connectionManager.sendToUser(recipient.id, {
    type: 'notification:new',
    notificationId: result.notification.id,
    kind: result.notification.kind,
    title: result.notification.title,
    unread,
    runId: result.notification.run_id,
    interruptId: result.notification.interrupt_id,
  });
}

/**
 * Tell whoever owns each account that crossed 80% / 100% this period — the
 * member for their own account, every active admin for service and
 * organization accounts. Deduplicated per account + period + threshold; only
 * the highest threshold reached is sent. Never throws.
 */
export async function publishBudgetAlerts(db: DatabaseProvider, accountIds: readonly string[]): Promise<void> {
  try {
    const accounts = await db.metering.getAccounts([...new Set(accountIds)]);
    let admins: UserRow[] | null = null;
    for (const account of accounts) {
      if (account.unit !== 'usd_micros') continue;
      const threshold = reachedThreshold(account);
      if (threshold === null) continue;
      let recipients: UserRow[];
      if (account.scope_type === 'user') {
        const member = await db.users.getById(account.scope_id);
        recipients = member && member.status === 'active' ? [member] : [];
      } else if (account.scope_type === 'service' || account.scope_type === 'organization') {
        // A service without its own limit mirrors the team's: the team alert already says it.
        if (account.scope_type === 'service') {
          const limits = await resolveLimits(db, { service: account.scope_id });
          if (limits.service.source === 'default') continue;
        }
        admins ??= (await db.users.list()).filter((user) => user.role === 'super' && user.status === 'active');
        recipients = admins;
      } else {
        continue;
      }
      for (const recipient of recipients) {
        await publishAlert(db, recipient, account, threshold);
      }
    }
  } catch (err) {
    logger.warn('[metering] could not publish budget alerts', { error: toErrorMessage(err) });
  }
}

/**
 * Unified Usage Budget service.
 *
 * Every model entry point reserves capacity before provider I/O, then settles
 * real usage or releases the reservation. A reservation group may charge
 * several scope accounts at once. Account rows are locked in stable id order,
 * while an advisory lock serializes reuse of one idempotency key.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { Db } from '../client.js';
import { llmUsage, usageBudgetAccounts, usageBudgetLedger, usageBudgetReservations, users } from '../schema/index.js';
import type {
  UsageBudgetAccountRow,
  UsageBudgetAccountStatus,
  UsageBudgetLedgerRow,
  UsageBudgetReservationRow,
  UsageBudgetScopeType,
  UsageBudgetUnit,
} from '../schema/usage.js';

export type UsageBudgetErrorCode =
  | 'usage_budget_invalid_input'
  | 'usage_budget_account_unavailable'
  | 'usage_budget_exceeded'
  | 'usage_budget_idempotency_conflict'
  | 'usage_budget_reservation_not_found'
  | 'usage_budget_invalid_state'
  | 'usage_budget_invariant_violation';

export class UsageBudgetError extends Error {
  constructor(
    public readonly code: UsageBudgetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'UsageBudgetError';
  }
}

export interface UsageBudgetExceededAccount {
  account_id: string;
  limit_units: number;
  spent_units: number;
  reserved_units: number;
  requested_units: number;
}

export class UsageBudgetExceededError extends UsageBudgetError {
  constructor(public readonly accounts: UsageBudgetExceededAccount[]) {
    super('usage_budget_exceeded', 'Usage budget does not have enough available capacity');
    this.name = 'UsageBudgetExceededError';
  }
}

export interface UsageBudgetAccountInput {
  scope_type: UsageBudgetScopeType;
  scope_id: string;
  unit?: UsageBudgetUnit;
  period_start: string;
  period_end: string;
  limit_units: number;
  /** Only used when the account is first materialized. */
  initial_spent_units?: number;
  /** Legacy llm_usage projection included in initial_spent_units. */
  initial_legacy_spent_units?: number;
  bootstrap_metadata?: Readonly<Record<string, unknown>>;
  /** Existing accounts keep their limit unless an explicit control-plane sync asks to change it. */
  update_existing_limit?: boolean;
}

export interface MonthlyUserBudgetInput {
  user_id: string;
  limit_tokens: number;
  at?: string | Date;
  /** Control-plane only: synchronize an already-materialized account from the live users row. */
  sync_limit?: boolean;
}

export interface UsageBudgetReserveInput {
  account_ids: readonly string[];
  idempotency_key: string;
  estimated_units: number;
  caller: string;
  user_id?: string;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
  metadata?: Readonly<Record<string, unknown>>;
  ttl_ms: number;
  at?: string | Date;
}

export interface MonthlyUserBudgetReserveInput extends Omit<UsageBudgetReserveInput, 'account_ids' | 'user_id'> {
  user_id: string;
  limit_tokens: number;
  /**
   * Organization/Eval/provider accounts charged atomically with the user.
   * All entries must use the same unit as the monthly user account (`tokens`).
   */
  additional_accounts?: readonly UsageBudgetAccountInput[];
}

export interface UsageBudgetSettleInput {
  idempotency_key: string;
  actual_units: number;
  metadata?: Readonly<Record<string, unknown>>;
  at?: string | Date;
}

export interface UsageBudgetReleaseInput {
  idempotency_key: string;
  reason: string;
  metadata?: Readonly<Record<string, unknown>>;
  at?: string | Date;
}

export interface UsageBudgetAdjustmentInput {
  account_id: string;
  idempotency_key: string;
  delta_spent_units: number;
  reason: string;
  actor_id?: string;
  at?: string | Date;
}

export interface UsageBudgetAccountStatusInput {
  account_id: string;
  status: UsageBudgetAccountStatus;
  idempotency_key: string;
  reason: string;
  actor_id?: string;
  at?: string | Date;
}

export interface UsageBudgetAccountSnapshot {
  account: UsageBudgetAccountRow;
  available_units: number;
  exceeded: boolean;
}

export interface UsageBudgetPeriod {
  start: string;
  end: string;
}

const MAX_KEY_LENGTH = 512;

function fail(code: UsageBudgetErrorCode, message: string): never {
  throw new UsageBudgetError(code, message);
}

function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_KEY_LENGTH) {
    fail('usage_budget_invalid_input', `${label} must contain 1-${MAX_KEY_LENGTH} characters`);
  }
  return normalized;
}

function assertUnits(value: number, label: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    fail('usage_budget_invalid_input', `${label} must be a ${allowZero ? 'non-negative' : 'positive'} safe integer`);
  }
  return value;
}

function asIso(value: string | Date | undefined): string {
  if (value === undefined) return nowIso();
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) fail('usage_budget_invalid_input', 'at must be a valid timestamp');
  return parsed.toISOString();
}

function assertPeriod(start: string, end: string): void {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    fail('usage_budget_invalid_input', 'Budget period must be a valid non-empty half-open interval');
  }
}

function sameInstant(left: string, right: string): boolean {
  return Date.parse(left) === Date.parse(right);
}

function encodeMetadata(value: Readonly<Record<string, unknown>> | undefined): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    fail('usage_budget_invalid_input', 'Budget metadata must be JSON serializable');
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}_${createHash('sha256').update(value).digest('hex').slice(0, 32)}`;
}

export function usageBudgetAccountId(input: {
  scope_type: UsageBudgetScopeType;
  scope_id: string;
  unit: UsageBudgetUnit;
  period_start: string;
  period_end: string;
}): string {
  return stableId(
    'uba',
    [input.scope_type, input.scope_id, input.unit, input.period_start, input.period_end].join('\u0000'),
  );
}

function reservationId(accountId: string, idempotencyKey: string): string {
  return stableId('ubr', `${accountId}\u0000${idempotencyKey}`);
}

function reservationRequestHash(input: {
  account_ids: readonly string[];
  estimated_units: number;
  caller: string;
  user_id?: string;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
  ttl_ms: number;
  metadata: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        account_ids: input.account_ids,
        estimated_units: input.estimated_units,
        caller: input.caller,
        user_id: input.user_id ?? null,
        run_id: input.run_id ?? null,
        provider_id: input.provider_id ?? null,
        model_id: input.model_id ?? null,
        ttl_ms: input.ttl_ms,
        metadata: input.metadata,
      }),
    )
    .digest('hex');
}

export function getUtcMonthPeriod(at: string | Date = new Date()): UsageBudgetPeriod {
  const value = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(value.getTime())) fail('usage_budget_invalid_input', 'at must be a valid timestamp');
  const start = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), 1));
  const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

function accountSnapshot(account: UsageBudgetAccountRow): UsageBudgetAccountSnapshot {
  const available = account.limit_units - account.spent_units - account.reserved_units;
  return {
    account,
    available_units: Math.max(0, available),
    exceeded: available < 0,
  };
}

export function createUsageBudgetService(db: Db) {
  async function finishReservationGroup(
    input: UsageBudgetReleaseInput,
    terminalStatus: 'released' | 'expired',
  ): Promise<{ reservations: UsageBudgetReservationRow[]; changed: boolean }> {
    const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
    const reason = assertIdentifier(input.reason, 'reason');
    const at = asIso(input.at);
    const metadata = encodeMetadata({ ...input.metadata, reason });

    return db.transaction(async (tx) => {
      const lockKey = `usage-budget-reservation:${idempotencyKey}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const reservations = await tx
        .select()
        .from(usageBudgetReservations)
        .where(eq(usageBudgetReservations.idempotency_key, idempotencyKey))
        .orderBy(asc(usageBudgetReservations.account_id))
        .for('update');
      if (reservations.length === 0) {
        fail('usage_budget_reservation_not_found', 'Usage budget reservation was not found');
      }

      const pending = reservations.filter((row) => row.status === 'reserved');
      if (pending.length === 0) {
        if (reservations.every((row) => row.status === terminalStatus)) {
          const terminalLedger = await tx
            .select({ metadata: usageBudgetLedger.metadata })
            .from(usageBudgetLedger)
            .where(
              and(
                inArray(
                  usageBudgetLedger.account_id,
                  reservations.map((row) => row.account_id),
                ),
                eq(usageBudgetLedger.operation_key, `${idempotencyKey}:${terminalStatus}`),
              ),
            );
          if (terminalLedger.length !== reservations.length) {
            fail('usage_budget_invariant_violation', 'Reservation terminal state is missing ledger history');
          }
          if (terminalLedger.some((row) => row.metadata !== metadata)) {
            fail(
              'usage_budget_idempotency_conflict',
              `${terminalStatus} was already recorded with different audit metadata`,
            );
          }
          return { reservations, changed: false };
        }
        fail(
          'usage_budget_invalid_state',
          `Reservation group cannot transition from ${reservations[0]!.status} to ${terminalStatus}`,
        );
      }
      if (pending.length !== reservations.length) {
        fail('usage_budget_invariant_violation', 'Reservation group contains mixed terminal states');
      }

      const accountIds = pending.map((row) => row.account_id).sort();
      const accounts = await tx
        .select()
        .from(usageBudgetAccounts)
        .where(inArray(usageBudgetAccounts.id, accountIds))
        .orderBy(asc(usageBudgetAccounts.id))
        .for('update');
      if (accounts.length !== accountIds.length) {
        fail('usage_budget_invariant_violation', 'A reserved budget account is missing');
      }
      const byId = new Map(accounts.map((row) => [row.id, row]));

      for (const reservation of pending) {
        const account = byId.get(reservation.account_id)!;
        if (account.reserved_units < reservation.estimated_units) {
          fail('usage_budget_invariant_violation', 'Account reserved balance is below its reservation');
        }
        const reservedAfter = account.reserved_units - reservation.estimated_units;
        const spentDelta = terminalStatus === 'expired' ? reservation.estimated_units : 0;
        const spentAfter = account.spent_units + spentDelta;
        const [updatedAccount] = await tx
          .update(usageBudgetAccounts)
          .set({ reserved_units: reservedAfter, spent_units: spentAfter, updated_at: at })
          .where(eq(usageBudgetAccounts.id, account.id))
          .returning();
        await tx
          .update(usageBudgetReservations)
          .set({
            status: terminalStatus,
            actual_units: terminalStatus === 'expired' ? reservation.estimated_units : null,
            settled_at: terminalStatus === 'expired' ? at : null,
            released_at: terminalStatus === 'released' ? at : null,
            updated_at: at,
          })
          .where(eq(usageBudgetReservations.id, reservation.id));
        await tx.insert(usageBudgetLedger).values({
          account_id: account.id,
          reservation_id: reservation.id,
          operation_key: `${idempotencyKey}:${terminalStatus}`,
          entry_type: terminalStatus === 'expired' ? 'expire' : 'release',
          delta_reserved_units: -reservation.estimated_units,
          delta_spent_units: spentDelta,
          reserved_units_after: updatedAccount!.reserved_units,
          spent_units_after: updatedAccount!.spent_units,
          metadata,
          created_at: at,
        });
        byId.set(account.id, updatedAccount!);
      }

      const updated = await tx
        .select()
        .from(usageBudgetReservations)
        .where(eq(usageBudgetReservations.idempotency_key, idempotencyKey))
        .orderBy(asc(usageBudgetReservations.account_id));
      return { reservations: updated, changed: true };
    });
  }

  const service = {
    async ensureAccount(input: UsageBudgetAccountInput): Promise<UsageBudgetAccountRow> {
      const scopeId = assertIdentifier(input.scope_id, 'scope_id');
      const limitUnits = assertUnits(input.limit_units, 'limit_units', true);
      const initialSpent = assertUnits(input.initial_spent_units ?? 0, 'initial_spent_units', true);
      const initialLegacySpent = assertUnits(input.initial_legacy_spent_units ?? 0, 'initial_legacy_spent_units', true);
      if (initialLegacySpent > initialSpent) {
        fail('usage_budget_invalid_input', 'initial_legacy_spent_units cannot exceed initial_spent_units');
      }
      const unit = input.unit ?? 'tokens';
      const periodStart = asIso(input.period_start);
      const periodEnd = asIso(input.period_end);
      assertPeriod(periodStart, periodEnd);
      const id = usageBudgetAccountId({
        scope_type: input.scope_type,
        scope_id: scopeId,
        unit,
        period_start: periodStart,
        period_end: periodEnd,
      });
      const bootstrapMetadata = encodeMetadata(input.bootstrap_metadata);

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-account:${id}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [existing] = await tx
          .select()
          .from(usageBudgetAccounts)
          .where(eq(usageBudgetAccounts.id, id))
          .limit(1)
          .for('update');
        if (existing) {
          if (
            existing.scope_type !== input.scope_type ||
            existing.scope_id !== scopeId ||
            existing.unit !== unit ||
            !sameInstant(existing.period_start, periodStart) ||
            !sameInstant(existing.period_end, periodEnd)
          ) {
            fail('usage_budget_invariant_violation', 'Deterministic budget account id collision');
          }
          if (existing.limit_units === limitUnits || input.update_existing_limit !== true) return existing;

          const at = nowIso();
          const [updated] = await tx
            .update(usageBudgetAccounts)
            .set({ limit_units: limitUnits, updated_at: at })
            .where(eq(usageBudgetAccounts.id, id))
            .returning();
          await tx.insert(usageBudgetLedger).values({
            account_id: id,
            reservation_id: null,
            operation_key: `limit:${existing.limit_units}:${limitUnits}:${existing.updated_at}`,
            entry_type: 'adjustment',
            delta_reserved_units: 0,
            delta_spent_units: 0,
            reserved_units_after: updated!.reserved_units,
            spent_units_after: updated!.spent_units,
            metadata: encodeMetadata({ previous_limit_units: existing.limit_units, limit_units: limitUnits }),
            created_at: at,
          });
          return updated!;
        }

        const at = nowIso();
        const [created] = await tx
          .insert(usageBudgetAccounts)
          .values({
            id,
            scope_type: input.scope_type,
            scope_id: scopeId,
            unit,
            period_start: periodStart,
            period_end: periodEnd,
            limit_units: limitUnits,
            spent_units: initialSpent,
            legacy_spent_units: initialLegacySpent,
            created_at: at,
            updated_at: at,
          })
          .returning();
        await tx.insert(usageBudgetLedger).values({
          account_id: id,
          reservation_id: null,
          operation_key: 'bootstrap',
          entry_type: 'bootstrap',
          delta_reserved_units: 0,
          delta_spent_units: initialSpent,
          reserved_units_after: 0,
          spent_units_after: initialSpent,
          metadata: bootstrapMetadata,
          created_at: at,
        });
        return created!;
      });
    },

    async ensureMonthlyUserAccount(input: MonthlyUserBudgetInput): Promise<UsageBudgetAccountRow> {
      const userId = assertIdentifier(input.user_id, 'user_id');
      const period = getUtcMonthPeriod(input.at);
      // `users.monthly_token_limit` is the live administrative source of truth.
      // Never trust the caller's previously-read copy here: an in-flight
      // request could otherwise restore an old, higher limit after an admin
      // lowered it. Normal request admission is create-only for account limits;
      // only the control plane may explicitly synchronize an existing account.
      const currentLimit = await db.transaction(async (tx) => {
        const [user] = await tx
          .select({ monthly_token_limit: users.monthly_token_limit })
          .from(users)
          .where(eq(users.id, userId))
          .limit(1)
          .for('share');
        if (!user) fail('usage_budget_account_unavailable', 'Usage budget user does not exist');
        return user.monthly_token_limit;
      });
      const rows = await db
        .select({ total: sql<number>`COALESCE(SUM(${llmUsage.input_tokens} + ${llmUsage.output_tokens}), 0)` })
        .from(llmUsage)
        .where(
          and(
            eq(llmUsage.user_id, userId),
            gte(llmUsage.created_at, period.start),
            lt(llmUsage.created_at, period.end),
            isNull(llmUsage.budget_idempotency_key),
          ),
        );
      const historicalUsage = Number(rows[0]?.total ?? 0);
      assertUnits(historicalUsage, 'historical_usage', true);
      return service.ensureAccount({
        scope_type: 'user',
        scope_id: userId,
        period_start: period.start,
        period_end: period.end,
        limit_units: currentLimit,
        initial_spent_units: historicalUsage,
        initial_legacy_spent_units: historicalUsage,
        bootstrap_metadata: { source: 'llm_usage', historical_usage_units: historicalUsage },
        update_existing_limit: input.sync_limit === true,
      });
    },

    async reserve(input: UsageBudgetReserveInput): Promise<UsageBudgetReservationRow[]> {
      const accountIds = [...new Set(input.account_ids.map((id) => assertIdentifier(id, 'account_id')))].sort();
      if (accountIds.length === 0) fail('usage_budget_invalid_input', 'At least one budget account is required');
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const estimatedUnits = assertUnits(input.estimated_units, 'estimated_units', false);
      const caller = assertIdentifier(input.caller, 'caller');
      const ttlMs = assertUnits(input.ttl_ms, 'ttl_ms', false);
      const at = asIso(input.at);
      const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
      const metadata = encodeMetadata(input.metadata);
      const requestHash = reservationRequestHash({
        account_ids: accountIds,
        estimated_units: estimatedUnits,
        caller,
        user_id: input.user_id,
        run_id: input.run_id,
        provider_id: input.provider_id,
        model_id: input.model_id,
        ttl_ms: ttlMs,
        metadata,
      });

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-reservation:${idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

        const existing = await tx
          .select()
          .from(usageBudgetReservations)
          .where(eq(usageBudgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(usageBudgetReservations.account_id));
        if (existing.length > 0) {
          const existingAccountIds = existing.map((row) => row.account_id);
          if (
            existing.length !== accountIds.length ||
            existing.some((row) => row.request_hash !== requestHash) ||
            existingAccountIds.some((id, index) => id !== accountIds[index])
          ) {
            fail('usage_budget_idempotency_conflict', 'Idempotency key was already used for a different reservation');
          }
          return existing;
        }

        const locked = await tx
          .select()
          .from(usageBudgetAccounts)
          .where(inArray(usageBudgetAccounts.id, accountIds))
          .orderBy(asc(usageBudgetAccounts.id))
          .for('update');
        if (locked.length !== accountIds.length) {
          fail('usage_budget_account_unavailable', 'One or more required budget accounts do not exist');
        }
        if (new Set(locked.map((account) => account.unit)).size !== 1) {
          fail('usage_budget_invalid_input', 'One reservation group can only charge accounts with the same unit');
        }
        const byId = new Map(locked.map((row) => [row.id, row]));

        // During rollout, reconcile the user account with the legacy immutable
        // usage facts. Once every caller is budget-aware this remains a cheap
        // equality check and catches any out-of-band usage writer fail-closed.
        for (const accountId of accountIds) {
          const account = byId.get(accountId)!;
          if (account.scope_type !== 'user' || account.unit !== 'tokens') continue;
          const rows = await tx
            .select({ total: sql<number>`COALESCE(SUM(${llmUsage.input_tokens} + ${llmUsage.output_tokens}), 0)` })
            .from(llmUsage)
            .where(
              and(
                eq(llmUsage.user_id, account.scope_id),
                gte(llmUsage.created_at, account.period_start),
                lt(llmUsage.created_at, account.period_end),
                isNull(llmUsage.budget_idempotency_key),
              ),
            );
          const historicalUsage = Number(rows[0]?.total ?? 0);
          if (!Number.isSafeInteger(historicalUsage) || historicalUsage <= account.legacy_spent_units) continue;
          const legacyDelta = historicalUsage - account.legacy_spent_units;

          const [reconciled] = await tx
            .update(usageBudgetAccounts)
            .set({
              spent_units: account.spent_units + legacyDelta,
              legacy_spent_units: historicalUsage,
              updated_at: at,
            })
            .where(eq(usageBudgetAccounts.id, account.id))
            .returning();
          await tx.insert(usageBudgetLedger).values({
            account_id: account.id,
            reservation_id: null,
            operation_key: `reconcile:${account.legacy_spent_units}:${historicalUsage}`,
            entry_type: 'reconcile',
            delta_reserved_units: 0,
            delta_spent_units: legacyDelta,
            reserved_units_after: reconciled!.reserved_units,
            spent_units_after: reconciled!.spent_units,
            metadata: encodeMetadata({ source: 'llm_usage' }),
            created_at: at,
          });
          byId.set(account.id, reconciled!);
        }

        const exceeded: UsageBudgetExceededAccount[] = [];
        const atMs = Date.parse(at);
        for (const accountId of accountIds) {
          const account = byId.get(accountId)!;
          if (
            account.status !== 'active' ||
            atMs < Date.parse(account.period_start) ||
            atMs >= Date.parse(account.period_end)
          ) {
            fail('usage_budget_account_unavailable', `Budget account ${account.id} is not active for this period`);
          }
          if (account.spent_units + account.reserved_units + estimatedUnits > account.limit_units) {
            exceeded.push({
              account_id: account.id,
              limit_units: account.limit_units,
              spent_units: account.spent_units,
              reserved_units: account.reserved_units,
              requested_units: estimatedUnits,
            });
          }
        }
        if (exceeded.length > 0) throw new UsageBudgetExceededError(exceeded);

        const values = accountIds.map((accountId) => ({
          id: reservationId(accountId, idempotencyKey),
          account_id: accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          estimated_units: estimatedUnits,
          caller,
          user_id: input.user_id ?? null,
          run_id: input.run_id ?? null,
          provider_id: input.provider_id ?? null,
          model_id: input.model_id ?? null,
          metadata,
          expires_at: expiresAt,
          created_at: at,
          updated_at: at,
        }));
        const reservations = await tx.insert(usageBudgetReservations).values(values).returning();
        const reservationByAccount = new Map(reservations.map((row) => [row.account_id, row]));

        for (const accountId of accountIds) {
          const account = byId.get(accountId)!;
          const reservedAfter = account.reserved_units + estimatedUnits;
          const [updated] = await tx
            .update(usageBudgetAccounts)
            .set({ reserved_units: reservedAfter, updated_at: at })
            .where(eq(usageBudgetAccounts.id, accountId))
            .returning();
          const reservation = reservationByAccount.get(accountId)!;
          await tx.insert(usageBudgetLedger).values({
            account_id: accountId,
            reservation_id: reservation.id,
            operation_key: `${idempotencyKey}:reserve`,
            entry_type: 'reserve',
            delta_reserved_units: estimatedUnits,
            delta_spent_units: 0,
            reserved_units_after: updated!.reserved_units,
            spent_units_after: updated!.spent_units,
            metadata: encodeMetadata({ idempotency_key: idempotencyKey, caller }),
            created_at: at,
          });
          byId.set(accountId, updated!);
        }
        return reservations.sort((a, b) => a.account_id.localeCompare(b.account_id));
      });
    },

    async reserveMonthlyUser(input: MonthlyUserBudgetReserveInput): Promise<UsageBudgetReservationRow[]> {
      const { limit_tokens: limitTokens, additional_accounts: additionalAccounts = [], ...reserveInput } = input;
      const account = await service.ensureMonthlyUserAccount({
        user_id: input.user_id,
        // Backwards-compatible input field; ensureMonthlyUserAccount reads the
        // current users row under a lock and deliberately ignores stale copies.
        limit_tokens: limitTokens,
        at: input.at,
      });
      const additional = await Promise.all(
        additionalAccounts.map((candidate) => {
          if ((candidate.unit ?? 'tokens') !== 'tokens') {
            fail('usage_budget_invalid_input', 'Monthly user reservation can only include token accounts');
          }
          if (candidate.scope_type === 'user' && candidate.scope_id === input.user_id) {
            fail('usage_budget_invalid_input', 'Monthly user account must not be duplicated in additional_accounts');
          }
          return service.ensureAccount(candidate);
        }),
      );
      return service.reserve({
        ...reserveInput,
        account_ids: [account.id, ...additional.map((row) => row.id)],
        user_id: input.user_id,
      });
    },

    async settle(input: UsageBudgetSettleInput): Promise<UsageBudgetReservationRow[]> {
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const actualUnits = assertUnits(input.actual_units, 'actual_units', true);
      const at = asIso(input.at);

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-reservation:${idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const reservations = await tx
          .select()
          .from(usageBudgetReservations)
          .where(eq(usageBudgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(usageBudgetReservations.account_id))
          .for('update');
        if (reservations.length === 0) {
          fail('usage_budget_reservation_not_found', 'Usage budget reservation was not found');
        }
        if (reservations.every((row) => row.status === 'settled')) {
          if (reservations.some((row) => row.actual_units !== actualUnits)) {
            fail('usage_budget_idempotency_conflict', 'Reservation was already settled with different usage');
          }
          return reservations;
        }
        if (reservations.some((row) => row.status === 'settled')) {
          fail('usage_budget_invariant_violation', 'Reservation group contains mixed settlement states');
        }

        const unsettled = reservations.filter((row) => row.status !== 'settled');
        const accountIds = unsettled.map((row) => row.account_id).sort();
        const accounts = await tx
          .select()
          .from(usageBudgetAccounts)
          .where(inArray(usageBudgetAccounts.id, accountIds))
          .orderBy(asc(usageBudgetAccounts.id))
          .for('update');
        if (accounts.length !== accountIds.length) {
          fail('usage_budget_invariant_violation', 'A settlement budget account is missing');
        }
        const byId = new Map(accounts.map((row) => [row.id, row]));

        for (const reservation of unsettled) {
          const account = byId.get(reservation.account_id)!;
          const releaseReserved = reservation.status === 'reserved' ? reservation.estimated_units : 0;
          if (account.reserved_units < releaseReserved) {
            fail('usage_budget_invariant_violation', 'Account reserved balance is below its reservation');
          }
          const reservedAfter = account.reserved_units - releaseReserved;
          const previouslyAccountedUnits =
            reservation.status === 'expired' ? (reservation.actual_units ?? reservation.estimated_units) : 0;
          const spentDelta = actualUnits - previouslyAccountedUnits;
          const spentAfter = account.spent_units + spentDelta;
          if (!Number.isSafeInteger(spentAfter) || spentAfter < account.legacy_spent_units) {
            fail('usage_budget_invariant_violation', 'Account spent balance would violate its legacy projection');
          }
          const [updatedAccount] = await tx
            .update(usageBudgetAccounts)
            .set({ reserved_units: reservedAfter, spent_units: spentAfter, updated_at: at })
            .where(eq(usageBudgetAccounts.id, account.id))
            .returning();
          await tx
            .update(usageBudgetReservations)
            .set({ status: 'settled', actual_units: actualUnits, settled_at: at, updated_at: at })
            .where(eq(usageBudgetReservations.id, reservation.id));
          await tx.insert(usageBudgetLedger).values({
            account_id: account.id,
            reservation_id: reservation.id,
            operation_key: `${idempotencyKey}:settle`,
            entry_type: 'settle',
            delta_reserved_units: -releaseReserved,
            delta_spent_units: spentDelta,
            reserved_units_after: updatedAccount!.reserved_units,
            spent_units_after: updatedAccount!.spent_units,
            metadata: encodeMetadata({ ...input.metadata, previous_status: reservation.status }),
            created_at: at,
          });
          byId.set(account.id, updatedAccount!);
        }

        return tx
          .select()
          .from(usageBudgetReservations)
          .where(eq(usageBudgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(usageBudgetReservations.account_id));
      });
    },

    async release(input: UsageBudgetReleaseInput): Promise<UsageBudgetReservationRow[]> {
      return (await finishReservationGroup(input, 'released')).reservations;
    },

    async expireStaleReservations(at: string | Date = new Date(), limit = 100): Promise<number> {
      const expiresAt = asIso(at);
      const safeLimit = Math.min(Math.max(assertUnits(limit, 'limit', false), 1), 1_000);
      const candidates = await db
        .selectDistinct({ idempotency_key: usageBudgetReservations.idempotency_key })
        .from(usageBudgetReservations)
        .where(and(eq(usageBudgetReservations.status, 'reserved'), lte(usageBudgetReservations.expires_at, expiresAt)))
        .limit(safeLimit);
      let expired = 0;
      for (const candidate of candidates) {
        const result = await finishReservationGroup(
          {
            idempotency_key: candidate.idempotency_key,
            reason: 'reservation_ttl_expired',
            at: expiresAt,
          },
          'expired',
        );
        if (result.changed) expired += 1;
      }
      return expired;
    },

    async adjustSpent(input: UsageBudgetAdjustmentInput): Promise<UsageBudgetAccountRow> {
      const accountId = assertIdentifier(input.account_id, 'account_id');
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      if (!Number.isSafeInteger(input.delta_spent_units) || input.delta_spent_units === 0) {
        fail('usage_budget_invalid_input', 'delta_spent_units must be a non-zero safe integer');
      }
      const reason = assertIdentifier(input.reason, 'reason');
      const at = asIso(input.at);
      const operationKey = `adjust:${idempotencyKey}`;
      const adjustmentMetadata = encodeMetadata({ reason, actor_id: input.actor_id ?? null });

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-adjustment:${accountId}:${idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [account] = await tx
          .select()
          .from(usageBudgetAccounts)
          .where(eq(usageBudgetAccounts.id, accountId))
          .limit(1)
          .for('update');
        if (!account) fail('usage_budget_account_unavailable', 'Budget account does not exist');
        const [existing] = await tx
          .select({
            id: usageBudgetLedger.id,
            delta_spent_units: usageBudgetLedger.delta_spent_units,
            metadata: usageBudgetLedger.metadata,
          })
          .from(usageBudgetLedger)
          .where(and(eq(usageBudgetLedger.account_id, accountId), eq(usageBudgetLedger.operation_key, operationKey)))
          .limit(1);
        if (existing) {
          if (existing.delta_spent_units !== input.delta_spent_units || existing.metadata !== adjustmentMetadata) {
            fail('usage_budget_idempotency_conflict', 'Adjustment key was already used for a different operation');
          }
          return account;
        }

        const spentAfter = account.spent_units + input.delta_spent_units;
        if (!Number.isSafeInteger(spentAfter) || spentAfter < account.legacy_spent_units) {
          fail('usage_budget_invalid_input', 'Adjustment would make the spent balance invalid');
        }
        const [updated] = await tx
          .update(usageBudgetAccounts)
          .set({ spent_units: spentAfter, updated_at: at })
          .where(eq(usageBudgetAccounts.id, accountId))
          .returning();
        await tx.insert(usageBudgetLedger).values({
          account_id: accountId,
          reservation_id: null,
          operation_key: operationKey,
          entry_type: 'adjustment',
          delta_reserved_units: 0,
          delta_spent_units: input.delta_spent_units,
          reserved_units_after: updated!.reserved_units,
          spent_units_after: updated!.spent_units,
          metadata: adjustmentMetadata,
          created_at: at,
        });
        return updated!;
      });
    },

    async setAccountStatus(input: UsageBudgetAccountStatusInput): Promise<UsageBudgetAccountRow> {
      const accountId = assertIdentifier(input.account_id, 'account_id');
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const reason = assertIdentifier(input.reason, 'reason');
      const at = asIso(input.at);
      const operationKey = `status:${idempotencyKey}`;
      const requestMetadata = {
        status: input.status,
        reason,
        actor_id: input.actor_id ?? null,
      };

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-status:${accountId}:${idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [account] = await tx
          .select()
          .from(usageBudgetAccounts)
          .where(eq(usageBudgetAccounts.id, accountId))
          .limit(1)
          .for('update');
        if (!account) fail('usage_budget_account_unavailable', 'Budget account does not exist');

        const [existing] = await tx
          .select({ metadata: usageBudgetLedger.metadata })
          .from(usageBudgetLedger)
          .where(and(eq(usageBudgetLedger.account_id, accountId), eq(usageBudgetLedger.operation_key, operationKey)))
          .limit(1);
        if (existing) {
          const stored = safeJsonParse(existing.metadata, {}) as Partial<typeof requestMetadata>;
          if (
            stored.status !== requestMetadata.status ||
            stored.reason !== requestMetadata.reason ||
            stored.actor_id !== requestMetadata.actor_id
          ) {
            fail('usage_budget_idempotency_conflict', 'Status key was already used for a different operation');
          }
          return account;
        }

        const [updated] = await tx
          .update(usageBudgetAccounts)
          .set({ status: input.status, updated_at: at })
          .where(eq(usageBudgetAccounts.id, accountId))
          .returning();
        await tx.insert(usageBudgetLedger).values({
          account_id: accountId,
          reservation_id: null,
          operation_key: operationKey,
          entry_type: 'status',
          delta_reserved_units: 0,
          delta_spent_units: 0,
          reserved_units_after: updated!.reserved_units,
          spent_units_after: updated!.spent_units,
          metadata: encodeMetadata({ ...requestMetadata, previous_status: account.status }),
          created_at: at,
        });
        return updated!;
      });
    },

    async getAccount(accountId: string): Promise<UsageBudgetAccountRow | undefined> {
      const rows = await db
        .select()
        .from(usageBudgetAccounts)
        .where(eq(usageBudgetAccounts.id, assertIdentifier(accountId, 'account_id')))
        .limit(1);
      return rows[0];
    },

    async getAccountSnapshot(accountId: string): Promise<UsageBudgetAccountSnapshot | undefined> {
      const account = await service.getAccount(accountId);
      return account ? accountSnapshot(account) : undefined;
    },

    async getReservationGroup(idempotencyKey: string): Promise<UsageBudgetReservationRow[]> {
      return db
        .select()
        .from(usageBudgetReservations)
        .where(eq(usageBudgetReservations.idempotency_key, assertIdentifier(idempotencyKey, 'idempotency_key')))
        .orderBy(asc(usageBudgetReservations.account_id));
    },

    async listLedger(accountId: string, limit = 100): Promise<UsageBudgetLedgerRow[]> {
      const safeLimit = Math.min(Math.max(assertUnits(limit, 'limit', false), 1), 1_000);
      return db
        .select()
        .from(usageBudgetLedger)
        .where(eq(usageBudgetLedger.account_id, assertIdentifier(accountId, 'account_id')))
        .orderBy(desc(usageBudgetLedger.id))
        .limit(safeLimit);
    },
  };

  return service;
}

export type UsageBudgetService = ReturnType<typeof createUsageBudgetService>;

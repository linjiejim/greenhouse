/**
 * Unified Usage Budget service.
 *
 * Every model entry point reserves capacity before provider I/O, then settles
 * real usage or releases the reservation. A reservation group may charge
 * several scope accounts at once. Account rows are locked in stable id order,
 * while an advisory lock serializes reuse of one idempotency key.
 */

import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { newId } from '../ids.js';
import { budgetLedger, budgetReservations, budgets } from '../schema/index.js';
import type {
  BudgetRow,
  UsageBudgetAccountStatus,
  UsageBudgetLedgerRow,
  UsageBudgetReservationRow,
  UsageBudgetScopeType,
  UsageBudgetUnit,
} from '../schema/usage.js';

/** A `budgets` row of kind `account`: one balance for one scope and one half-open period. */
export interface UsageBudgetAccountRow {
  id: string;
  scope_type: UsageBudgetScopeType;
  scope_id: string;
  unit: UsageBudgetUnit;
  status: UsageBudgetAccountStatus;
  period_start: string;
  period_end: string;
  limit_units: number;
  reserved_units: number;
  spent_units: number;
  created_at: string;
  updated_at: string;
}

/** Narrow a `budgets` row to an account (the CHECK guarantees both period bounds). */
export function toUsageBudgetAccount(row: BudgetRow): UsageBudgetAccountRow {
  if (row.kind !== 'account' || row.period_start === null || row.period_end === null) {
    throw new UsageBudgetError('usage_budget_invariant_violation', `Budget ${row.id} is not an account`);
  }
  return {
    id: row.id,
    scope_type: row.scope_type,
    scope_id: row.scope_id,
    unit: row.unit,
    status: row.status,
    period_start: row.period_start,
    period_end: row.period_end,
    limit_units: row.limit_units,
    reserved_units: row.reserved_units,
    spent_units: row.spent_units,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

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
  bootstrap_metadata?: Readonly<Record<string, unknown>>;
  /** Existing accounts keep their limit unless an explicit control-plane sync asks to change it. */
  update_existing_limit?: boolean;
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

export interface UsageBudgetSettleInput {
  idempotency_key: string;
  actual_units: number;
  metadata?: Readonly<Record<string, unknown>>;
  at?: string | Date;
}

/**
 * A cost that was never reserved — the call was unpriced when it started and
 * priced by settlement (an admin set a price mid-call, a provider reported a
 * cost). It already happened, so it is charged without a limit check; it is
 * still a settled reservation group with ledger history, never a bypass.
 */
export interface UsageBudgetUnreservedChargeInput {
  account_ids: readonly string[];
  idempotency_key: string;
  actual_units: number;
  caller: string;
  user_id?: string;
  run_id?: string;
  provider_id?: string;
  model_id?: string;
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

/** Metadata as stored in jsonb: the JSON round trip of the caller's value. */
function metadataValue(value: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  return JSON.parse(encodeMetadata(value)) as Record<string, unknown>;
}

/** Key-order independent JSON (jsonb reorders object keys). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sameMetadata(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
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
    const metadata = metadataValue({ ...input.metadata, reason });

    return db.transaction(async (tx) => {
      const lockKey = `usage-budget-reservation:${idempotencyKey}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

      const reservations = await tx
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.idempotency_key, idempotencyKey))
        .orderBy(asc(budgetReservations.account_id))
        .for('update');
      if (reservations.length === 0) {
        fail('usage_budget_reservation_not_found', 'Usage budget reservation was not found');
      }

      const pending = reservations.filter((row) => row.status === 'reserved');
      if (pending.length === 0) {
        if (reservations.every((row) => row.status === terminalStatus)) {
          const terminalLedger = await tx
            .select({ metadata: budgetLedger.metadata })
            .from(budgetLedger)
            .where(
              and(
                inArray(
                  budgetLedger.account_id,
                  reservations.map((row) => row.account_id),
                ),
                eq(budgetLedger.operation_key, `${idempotencyKey}:${terminalStatus}`),
              ),
            );
          if (terminalLedger.length !== reservations.length) {
            fail('usage_budget_invariant_violation', 'Reservation terminal state is missing ledger history');
          }
          if (terminalLedger.some((row) => !sameMetadata(row.metadata, metadata))) {
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
        .from(budgets)
        .where(inArray(budgets.id, accountIds))
        .orderBy(asc(budgets.id))
        .for('update');
      if (accounts.length !== accountIds.length) {
        fail('usage_budget_invariant_violation', 'A reserved budget account is missing');
      }
      const byId = new Map(accounts.map((row) => [row.id, toUsageBudgetAccount(row)]));

      for (const reservation of pending) {
        const account = byId.get(reservation.account_id)!;
        if (account.reserved_units < reservation.estimated_units) {
          fail('usage_budget_invariant_violation', 'Account reserved balance is below its reservation');
        }
        const reservedAfter = account.reserved_units - reservation.estimated_units;
        const spentDelta = terminalStatus === 'expired' ? reservation.estimated_units : 0;
        const spentAfter = account.spent_units + spentDelta;
        const [updatedAccount] = await tx
          .update(budgets)
          .set({ reserved_units: reservedAfter, spent_units: spentAfter, updated_at: at })
          .where(eq(budgets.id, account.id))
          .returning();
        await tx
          .update(budgetReservations)
          .set({
            status: terminalStatus,
            actual_units: terminalStatus === 'expired' ? reservation.estimated_units : null,
            settled_at: terminalStatus === 'expired' ? at : null,
            released_at: terminalStatus === 'released' ? at : null,
            updated_at: at,
          })
          .where(eq(budgetReservations.id, reservation.id));
        await tx.insert(budgetLedger).values({
          id: newId('ledgerEntry'),
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
        byId.set(account.id, toUsageBudgetAccount(updatedAccount!));
      }

      const updated = await tx
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.idempotency_key, idempotencyKey))
        .orderBy(asc(budgetReservations.account_id));
      return { reservations: updated, changed: true };
    });
  }

  const service = {
    async ensureAccount(input: UsageBudgetAccountInput): Promise<UsageBudgetAccountRow> {
      const scopeId = assertIdentifier(input.scope_id, 'scope_id');
      const limitUnits = assertUnits(input.limit_units, 'limit_units', true);
      const initialSpent = assertUnits(input.initial_spent_units ?? 0, 'initial_spent_units', true);
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
      const bootstrapMetadata = metadataValue(input.bootstrap_metadata);

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-account:${id}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [existingRow] = await tx.select().from(budgets).where(eq(budgets.id, id)).limit(1).for('update');
        if (existingRow) {
          const existing = toUsageBudgetAccount(existingRow);
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
            .update(budgets)
            .set({ limit_units: limitUnits, updated_at: at })
            .where(eq(budgets.id, id))
            .returning();
          await tx.insert(budgetLedger).values({
            id: newId('ledgerEntry'),
            account_id: id,
            reservation_id: null,
            operation_key: `limit:${existing.limit_units}:${limitUnits}:${existing.updated_at}`,
            entry_type: 'adjustment',
            delta_reserved_units: 0,
            delta_spent_units: 0,
            reserved_units_after: updated!.reserved_units,
            spent_units_after: updated!.spent_units,
            metadata: metadataValue({ previous_limit_units: existing.limit_units, limit_units: limitUnits }),
            created_at: at,
          });
          return toUsageBudgetAccount(updated!);
        }

        const at = nowIso();
        const [created] = await tx
          .insert(budgets)
          .values({
            id,
            kind: 'account',
            scope_type: input.scope_type,
            scope_id: scopeId,
            unit,
            period_start: periodStart,
            period_end: periodEnd,
            limit_units: limitUnits,
            spent_units: initialSpent,
            created_at: at,
            updated_at: at,
          })
          .returning();
        await tx.insert(budgetLedger).values({
          id: newId('ledgerEntry'),
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
        return toUsageBudgetAccount(created!);
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
      const storedMetadata = metadataValue(input.metadata);
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
          .from(budgetReservations)
          .where(eq(budgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(budgetReservations.account_id));
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
          .from(budgets)
          .where(inArray(budgets.id, accountIds))
          .orderBy(asc(budgets.id))
          .for('update');
        if (locked.length !== accountIds.length) {
          fail('usage_budget_account_unavailable', 'One or more required budget accounts do not exist');
        }
        if (new Set(locked.map((account) => account.unit)).size !== 1) {
          fail('usage_budget_invalid_input', 'One reservation group can only charge accounts with the same unit');
        }
        const byId = new Map(locked.map((row) => [row.id, toUsageBudgetAccount(row)]));

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
          id: newId('reservation'),
          account_id: accountId,
          idempotency_key: idempotencyKey,
          request_hash: requestHash,
          estimated_units: estimatedUnits,
          caller,
          user_id: input.user_id ?? null,
          run_id: input.run_id ?? null,
          provider_id: input.provider_id ?? null,
          model_id: input.model_id ?? null,
          metadata: storedMetadata,
          expires_at: expiresAt,
          created_at: at,
          updated_at: at,
        }));
        const reservations = await tx.insert(budgetReservations).values(values).returning();
        const reservationByAccount = new Map(reservations.map((row) => [row.account_id, row]));

        for (const accountId of accountIds) {
          const account = byId.get(accountId)!;
          const reservedAfter = account.reserved_units + estimatedUnits;
          const [updated] = await tx
            .update(budgets)
            .set({ reserved_units: reservedAfter, updated_at: at })
            .where(eq(budgets.id, accountId))
            .returning();
          const reservation = reservationByAccount.get(accountId)!;
          await tx.insert(budgetLedger).values({
            id: newId('ledgerEntry'),
            account_id: accountId,
            reservation_id: reservation.id,
            operation_key: `${idempotencyKey}:reserve`,
            entry_type: 'reserve',
            delta_reserved_units: estimatedUnits,
            delta_spent_units: 0,
            reserved_units_after: updated!.reserved_units,
            spent_units_after: updated!.spent_units,
            metadata: metadataValue({ idempotency_key: idempotencyKey, caller }),
            created_at: at,
          });
          byId.set(accountId, toUsageBudgetAccount(updated!));
        }
        return reservations.sort((a, b) => a.account_id.localeCompare(b.account_id));
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
          .from(budgetReservations)
          .where(eq(budgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(budgetReservations.account_id))
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
          .from(budgets)
          .where(inArray(budgets.id, accountIds))
          .orderBy(asc(budgets.id))
          .for('update');
        if (accounts.length !== accountIds.length) {
          fail('usage_budget_invariant_violation', 'A settlement budget account is missing');
        }
        const byId = new Map(accounts.map((row) => [row.id, toUsageBudgetAccount(row)]));

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
          if (!Number.isSafeInteger(spentAfter) || spentAfter < 0) {
            fail('usage_budget_invariant_violation', 'Account spent balance would become negative');
          }
          const [updatedAccount] = await tx
            .update(budgets)
            .set({ reserved_units: reservedAfter, spent_units: spentAfter, updated_at: at })
            .where(eq(budgets.id, account.id))
            .returning();
          await tx
            .update(budgetReservations)
            .set({ status: 'settled', actual_units: actualUnits, settled_at: at, updated_at: at })
            .where(eq(budgetReservations.id, reservation.id));
          await tx.insert(budgetLedger).values({
            id: newId('ledgerEntry'),
            account_id: account.id,
            reservation_id: reservation.id,
            operation_key: `${idempotencyKey}:settle`,
            entry_type: 'settle',
            delta_reserved_units: -releaseReserved,
            delta_spent_units: spentDelta,
            reserved_units_after: updatedAccount!.reserved_units,
            spent_units_after: updatedAccount!.spent_units,
            metadata: metadataValue({ ...input.metadata, previous_status: reservation.status }),
            created_at: at,
          });
          byId.set(account.id, toUsageBudgetAccount(updatedAccount!));
        }

        return tx
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(budgetReservations.account_id));
      });
    },

    async chargeUnreserved(input: UsageBudgetUnreservedChargeInput): Promise<UsageBudgetReservationRow[]> {
      const accountIds = [...new Set(input.account_ids.map((id) => assertIdentifier(id, 'account_id')))].sort();
      if (accountIds.length === 0) fail('usage_budget_invalid_input', 'At least one budget account is required');
      const idempotencyKey = assertIdentifier(input.idempotency_key, 'idempotency_key');
      const actualUnits = assertUnits(input.actual_units, 'actual_units', false);
      const caller = assertIdentifier(input.caller, 'caller');
      const at = asIso(input.at);
      const metadata = encodeMetadata({ ...input.metadata, unreserved: true });
      const storedMetadata = metadataValue({ ...input.metadata, unreserved: true });
      const requestHash = reservationRequestHash({
        account_ids: accountIds,
        estimated_units: actualUnits,
        caller,
        user_id: input.user_id,
        run_id: input.run_id,
        provider_id: input.provider_id,
        model_id: input.model_id,
        ttl_ms: 0,
        metadata,
      });

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-reservation:${idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const existing = await tx
          .select()
          .from(budgetReservations)
          .where(eq(budgetReservations.idempotency_key, idempotencyKey))
          .orderBy(asc(budgetReservations.account_id));
        if (existing.length > 0) {
          if (existing.some((row) => row.request_hash !== requestHash)) {
            fail('usage_budget_idempotency_conflict', 'Idempotency key was already used for a different charge');
          }
          return existing;
        }

        const accounts = await tx
          .select()
          .from(budgets)
          .where(inArray(budgets.id, accountIds))
          .orderBy(asc(budgets.id))
          .for('update');
        if (accounts.length !== accountIds.length) {
          fail('usage_budget_account_unavailable', 'One or more required budget accounts do not exist');
        }
        if (new Set(accounts.map((account) => account.unit)).size !== 1) {
          fail('usage_budget_invalid_input', 'One charge can only debit accounts with the same unit');
        }

        const reservations = await tx
          .insert(budgetReservations)
          .values(
            accounts.map((account) => ({
              id: newId('reservation'),
              account_id: account.id,
              idempotency_key: idempotencyKey,
              request_hash: requestHash,
              status: 'settled' as const,
              estimated_units: actualUnits,
              actual_units: actualUnits,
              caller,
              user_id: input.user_id ?? null,
              run_id: input.run_id ?? null,
              provider_id: input.provider_id ?? null,
              model_id: input.model_id ?? null,
              metadata: storedMetadata,
              expires_at: at,
              settled_at: at,
              created_at: at,
              updated_at: at,
            })),
          )
          .returning();
        const byAccount = new Map(reservations.map((row) => [row.account_id, row]));
        for (const account of accounts) {
          const [updated] = await tx
            .update(budgets)
            .set({ spent_units: account.spent_units + actualUnits, updated_at: at })
            .where(eq(budgets.id, account.id))
            .returning();
          await tx.insert(budgetLedger).values({
            id: newId('ledgerEntry'),
            account_id: account.id,
            reservation_id: byAccount.get(account.id)!.id,
            operation_key: `${idempotencyKey}:settle`,
            entry_type: 'settle',
            delta_reserved_units: 0,
            delta_spent_units: actualUnits,
            reserved_units_after: updated!.reserved_units,
            spent_units_after: updated!.spent_units,
            metadata: storedMetadata,
            created_at: at,
          });
        }
        return reservations.sort((a, b) => a.account_id.localeCompare(b.account_id));
      });
    },

    async release(input: UsageBudgetReleaseInput): Promise<UsageBudgetReservationRow[]> {
      return (await finishReservationGroup(input, 'released')).reservations;
    },

    async expireStaleReservations(at: string | Date = new Date(), limit = 100): Promise<number> {
      const expiresAt = asIso(at);
      const safeLimit = Math.min(Math.max(assertUnits(limit, 'limit', false), 1), 1_000);
      const candidates = await db
        .selectDistinct({ idempotency_key: budgetReservations.idempotency_key })
        .from(budgetReservations)
        .where(and(eq(budgetReservations.status, 'reserved'), lte(budgetReservations.expires_at, expiresAt)))
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
      const adjustmentMetadata = metadataValue({ reason, actor_id: input.actor_id ?? null });

      return db.transaction(async (tx) => {
        const lockKey = `usage-budget-adjustment:${accountId}:${idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
        const [account] = await tx.select().from(budgets).where(eq(budgets.id, accountId)).limit(1).for('update');
        if (!account) fail('usage_budget_account_unavailable', 'Budget account does not exist');
        const [existing] = await tx
          .select({
            id: budgetLedger.id,
            delta_spent_units: budgetLedger.delta_spent_units,
            metadata: budgetLedger.metadata,
          })
          .from(budgetLedger)
          .where(and(eq(budgetLedger.account_id, accountId), eq(budgetLedger.operation_key, operationKey)))
          .limit(1);
        if (existing) {
          if (
            existing.delta_spent_units !== input.delta_spent_units ||
            !sameMetadata(existing.metadata, adjustmentMetadata)
          ) {
            fail('usage_budget_idempotency_conflict', 'Adjustment key was already used for a different operation');
          }
          return toUsageBudgetAccount(account);
        }

        const spentAfter = account.spent_units + input.delta_spent_units;
        if (!Number.isSafeInteger(spentAfter) || spentAfter < 0) {
          fail('usage_budget_invalid_input', 'Adjustment would make the spent balance invalid');
        }
        const [updated] = await tx
          .update(budgets)
          .set({ spent_units: spentAfter, updated_at: at })
          .where(eq(budgets.id, accountId))
          .returning();
        await tx.insert(budgetLedger).values({
          id: newId('ledgerEntry'),
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
        return toUsageBudgetAccount(updated!);
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
        const [account] = await tx.select().from(budgets).where(eq(budgets.id, accountId)).limit(1).for('update');
        if (!account) fail('usage_budget_account_unavailable', 'Budget account does not exist');

        const [existing] = await tx
          .select({ metadata: budgetLedger.metadata })
          .from(budgetLedger)
          .where(and(eq(budgetLedger.account_id, accountId), eq(budgetLedger.operation_key, operationKey)))
          .limit(1);
        if (existing) {
          const stored = existing.metadata as Partial<typeof requestMetadata>;
          if (
            stored.status !== requestMetadata.status ||
            stored.reason !== requestMetadata.reason ||
            stored.actor_id !== requestMetadata.actor_id
          ) {
            fail('usage_budget_idempotency_conflict', 'Status key was already used for a different operation');
          }
          return toUsageBudgetAccount(account);
        }

        const [updated] = await tx
          .update(budgets)
          .set({ status: input.status, updated_at: at })
          .where(eq(budgets.id, accountId))
          .returning();
        await tx.insert(budgetLedger).values({
          id: newId('ledgerEntry'),
          account_id: accountId,
          reservation_id: null,
          operation_key: operationKey,
          entry_type: 'status',
          delta_reserved_units: 0,
          delta_spent_units: 0,
          reserved_units_after: updated!.reserved_units,
          spent_units_after: updated!.spent_units,
          metadata: metadataValue({ ...requestMetadata, previous_status: account.status }),
          created_at: at,
        });
        return toUsageBudgetAccount(updated!);
      });
    },

    async getAccount(accountId: string): Promise<UsageBudgetAccountRow | undefined> {
      const rows = await db
        .select()
        .from(budgets)
        .where(and(eq(budgets.id, assertIdentifier(accountId, 'account_id')), eq(budgets.kind, 'account')))
        .limit(1);
      return rows[0] ? toUsageBudgetAccount(rows[0]) : undefined;
    },

    async getAccountSnapshot(accountId: string): Promise<UsageBudgetAccountSnapshot | undefined> {
      const account = await service.getAccount(accountId);
      return account ? accountSnapshot(account) : undefined;
    },

    async getReservationGroup(idempotencyKey: string): Promise<UsageBudgetReservationRow[]> {
      return db
        .select()
        .from(budgetReservations)
        .where(eq(budgetReservations.idempotency_key, assertIdentifier(idempotencyKey, 'idempotency_key')))
        .orderBy(asc(budgetReservations.account_id));
    },

    async listLedger(accountId: string, limit = 100): Promise<UsageBudgetLedgerRow[]> {
      const safeLimit = Math.min(Math.max(assertUnits(limit, 'limit', false), 1), 1_000);
      return db
        .select()
        .from(budgetLedger)
        .where(eq(budgetLedger.account_id, assertIdentifier(accountId, 'account_id')))
        .orderBy(desc(budgetLedger.created_at), desc(budgetLedger.id))
        .limit(safeLimit);
    },
  };

  return service;
}

export type UsageBudgetService = ReturnType<typeof createUsageBudgetService>;

/**
 * Members' cloud computers (云电脑, v1.6): one hosted sandbox per member,
 * started on first use, stopped on demand or after 15 idle minutes, billed per
 * minute. OFF by default — while the workspace switch is off, no path in this
 * module calls the driver's `create`, and the sweeper stops anything still
 * running.
 *
 * Lifecycle (state in member_computers, transitions compare-and-set):
 *   claim a slot (one per member, at most COMPUTER_MAX_RUNNING per workspace)
 *   → reserve the first billing block → create the sandbox → running
 *   → each use touches it and renews the provider's kill deadline
 *   → stop (member, admin, idle, budget, switch off): kill, then settle.
 *
 * Billing (usage/metering.ts, service `computer`, provider `e2b`, unit minute):
 * USD is reserved COMPUTER_BLOCK_MINUTES at a time. When a running computer
 * crosses a block boundary the sweeper reserves the next block first (refused
 * → the computer stops), then settles the finished block in full. A stop
 * settles the open block at the whole minutes it actually ran. Only the
 * reservation key is kept on the row, so any API process can settle any block
 * (restoreSpendLease). Unknown outcomes follow the metering rule: a create that
 * may have reached the provider, or a stop the provider did not confirm, keeps
 * its reservation, and the budget sweeper charges the estimate.
 */

import { getUtcMonthPeriod, type DatabaseProvider, type MemberComputerRow, type UserRow } from '@greenhouse/db';
import type { AdminComputersReport, ComputerView, MeteringClient, MyComputerReport } from '@greenhouse/types/metering';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { findBudgetRefusal } from '../usage/budget-errors.js';
import {
  restoreSpendLease,
  reserveSpend,
  settleServiceFact,
  type MeteringScope,
  type SpendAttribution,
  type SpendLease,
} from '../usage/metering.js';
import {
  effectiveServicePrice,
  serviceUnitCostMicros,
  syncPriceOverrides,
  unitPriceSnapshot,
} from '../usage/pricing.js';
import { ProviderRequestError } from './e2b/http.js';
import { getComputerDriver, type ComputerDriver } from './driver.js';
import {
  COMPUTER_BLOCK_MINUTES,
  COMPUTER_IDLE_MINUTES,
  computerMaxRunning,
  isComputerConfigured,
  isComputerEnabled,
} from './config.js';

const MINUTE_MS = 60_000;
const IDLE_MS = COMPUTER_IDLE_MINUTES * MINUTE_MS;
const BLOCK_MS = COMPUTER_BLOCK_MINUTES * MINUTE_MS;
/**
 * A block's reservation outlives the block by one idle window and a margin: a
 * computer whose API process died keeps running until the provider kills it,
 * at most one idle window after its last renewal.
 */
const BLOCK_TTL_MS = BLOCK_MS + IDLE_MS + 5 * MINUTE_MS;
/** A `starting` or `stopping` row this old belongs to a request that never finished. */
const STALE_TRANSITION_MS = 5 * MINUTE_MS;
/** While a command runs, its computer counts as in use; refreshed this often. */
const HEARTBEAT_MS = MINUTE_MS;
/** Slack added to the provider's kill deadline on top of the idle window and the operation. */
const RENEW_SLACK_SECONDS = 120;

// ─── Errors ──────────────────────────────────────────────

export const COMPUTER_DISABLED_MESSAGE =
  '云电脑未开启，请管理员在服务与计价里开启。The cloud computer is turned off; ask an administrator to turn it on in Services & pricing.';

const NOT_CONFIGURED_MESSAGE =
  '云电脑还没有配置好（缺少 E2B API key），请管理员在运行配置里填写。The cloud computer is not set up yet (no E2B API key); ask an administrator to add it in Runtime Config.';

export type ComputerErrorCode = 'disabled' | 'not_configured' | 'full' | 'busy' | 'not_running';

/** A refusal the caller (agent or member) should read as is: nothing was started or charged. */
export class ComputerUnavailableError extends Error {
  constructor(
    readonly code: ComputerErrorCode,
    message: string,
    readonly status: 403 | 409 | 429 | 503 = 409,
  ) {
    super(message);
    this.name = 'ComputerUnavailableError';
  }
}

/** Why no computer may run right now, or null. Checked before anything is claimed or created. */
export function computerUnavailableReason(): ComputerUnavailableError | null {
  if (!isComputerEnabled()) return new ComputerUnavailableError('disabled', COMPUTER_DISABLED_MESSAGE, 403);
  if (!isComputerConfigured()) return new ComputerUnavailableError('not_configured', NOT_CONFIGURED_MESSAGE, 503);
  return null;
}

function fullMessage(max: number): string {
  return (
    `云电脑已满：团队最多同时运行 ${max} 台，请稍后再试，或请管理员停掉不用的。` +
    `All ${max} of the team's cloud computers are in use; try again later or ask an administrator to stop an idle one.`
  );
}

const BUSY_MESSAGE =
  '你的云电脑正在启动或停止，请稍后再试。Your cloud computer is starting or stopping; try again in a moment.';

export const NOT_RUNNING_MESSAGE =
  'No cloud computer is running. computer_exec (or copying a file in) starts one; files from an earlier computer are gone.';

// ─── Billing ─────────────────────────────────────────────

function minutesBetween(from: string, to: number): number {
  return Math.max(0, Math.ceil((to - Date.parse(from)) / MINUTE_MS));
}

function attributionOf(row: MemberComputerRow): SpendAttribution {
  return {
    userId: row.user_id,
    service: 'computer',
    provider: 'e2b',
    model: null,
    client: row.client as MeteringClient,
    oauthClientId: row.oauth_client_id,
    caller: 'computer',
    sessionId: null,
    runId: row.id,
  };
}

async function blockEstimate(db: DatabaseProvider): Promise<number | null> {
  await syncPriceOverrides(db);
  const perMinute = serviceUnitCostMicros('computer', 'e2b', 1);
  return perMinute === null ? null : perMinute * COMPUTER_BLOCK_MINUTES;
}

/**
 * The reservation key of one billing block: one per computer and block start,
 * so every process that evaluates the same block makes the same admission
 * (a second reserve with the key returns the first one's reservation).
 */
export function blockBudgetKey(computerId: string, blockStartedAt: string): string {
  return `computer:${computerId}:${new Date(blockStartedAt).toISOString()}`;
}

/**
 * Reserve one block of minutes for a computer; throws the budget refusal when
 * it does not fit.
 *
 * A block already reserved under its key (a sweep that reserved it and died
 * before installing it, or another process) keeps that admission: its
 * accounts, its period and its estimate are restored as they are. Admitting it
 * afresh would compute other accounts after a month boundary, or another
 * estimate after a price change, and collide with the stored reservation on
 * every retry, so the computer would never advance again.
 */
async function reserveBlock(db: DatabaseProvider, row: MemberComputerRow, blockStartedAt: string): Promise<SpendLease> {
  const key = blockBudgetKey(row.id, blockStartedAt);
  const existing = await db.usageBudget.getReservationGroup(key);
  if (existing.length > 0) {
    return restoreSpendLease(db, {
      idempotencyKey: key,
      estimatedUsdMicros: existing[0]!.estimated_units,
      attribution: attributionOf(row),
    });
  }
  return reserveSpend({
    db,
    service: 'computer',
    provider: 'e2b',
    caller: 'computer',
    estimatedUsdMicros: await blockEstimate(db),
    userId: row.user_id,
    client: row.client as MeteringClient,
    oauthClientId: row.oauth_client_id,
    runId: row.id,
    idempotencyKey: key,
    ttlMs: BLOCK_TTL_MS,
    metadata: { computer_id: row.id, block_started_at: blockStartedAt, block_minutes: COMPUTER_BLOCK_MINUTES },
  });
}

/** Give back a block reservation that never became the open block. Never throws. */
async function releaseUnusedBlock(db: DatabaseProvider, key: string): Promise<void> {
  try {
    const group = await db.usageBudget.getReservationGroup(key);
    if (group.length > 0 && group.every((reservation) => reservation.status === 'reserved')) {
      await db.usageBudget.release({ idempotency_key: key, reason: 'computer_block_never_active' });
    }
  } catch (error) {
    logger.warn('[computer] could not release an unused billing block', { key, error: toErrorMessage(error) });
  }
}

/** Settle one block at `minutes` and record the fact. Never throws (an unsettled block is charged its estimate). */
async function settleBlock(
  db: DatabaseProvider,
  row: MemberComputerRow,
  budgetKey: string,
  minutes: number,
  reason: string,
): Promise<void> {
  try {
    const estimate = (await blockEstimate(db)) ?? 0;
    const lease = await restoreSpendLease(db, {
      idempotencyKey: budgetKey,
      estimatedUsdMicros: estimate,
      attribution: attributionOf(row),
    });
    // Priced as of settlement, like every other service.
    const effective = effectiveServicePrice('computer', 'e2b');
    await settleServiceFact(db, lease, {
      provider: 'e2b',
      units: minutes,
      unitKind: 'minute',
      costUsdMicros: serviceUnitCostMicros('computer', 'e2b', minutes),
      priceApplied:
        effective?.price !== undefined
          ? unitPriceSnapshot(effective.price, effective.source, { unit: 'minute' })
          : null,
      metadata: {
        computer_id: row.id,
        sandbox_id: row.sandbox_id,
        block_started_at: row.block_started_at,
        reason,
      },
    });
  } catch (error) {
    logger.warn('[computer] could not settle a billing block', {
      computer: row.id,
      key: budgetKey,
      error: toErrorMessage(error),
    });
  }
}

// ─── Stop ────────────────────────────────────────────────

export type StopReason = 'user' | 'admin' | 'idle' | 'budget' | 'disabled' | 'expired';

/**
 * Stop a running computer: kill the sandbox, then settle the open block at the
 * minutes it ran. One caller wins (running → stopping); a kill the provider did
 * not confirm leaves the computer `lost` with its block reserved.
 *
 * `endedAt` is for a sandbox that is already gone: bill up to when it died.
 * `expect` makes the stop conditional on what the caller decided from: the
 * billing block it evaluated is still open, the computer was not used after
 * the idle cutoff. A caller holding a stale snapshot stops nothing.
 */
export async function stopComputer(
  db: DatabaseProvider,
  row: MemberComputerRow,
  reason: StopReason,
  options: {
    driver?: ComputerDriver;
    endedAt?: number;
    expect?: { budgetKey?: string | null; idleBefore?: string };
  } = {},
): Promise<MemberComputerRow | null> {
  const claimed = await db.memberComputers.claimStop(row.id, {
    ...(options.expect?.budgetKey !== undefined ? { budget_key: options.expect.budgetKey } : {}),
    ...(options.expect?.idleBefore !== undefined ? { idle_before: options.expect.idleBefore } : {}),
  });
  if (!claimed) return null;
  if (options.endedAt === undefined && claimed.sandbox_id) {
    try {
      await (options.driver ?? getComputerDriver()).kill(claimed.sandbox_id);
    } catch (error) {
      logger.warn('[computer] the provider did not confirm a stop; billing falls back to the estimate', {
        computer: claimed.id,
        error: toErrorMessage(error),
      });
      return (
        (await db.memberComputers.finish(claimed.id, { from: ['stopping'], status: 'lost', stop_reason: 'lost' })) ??
        null
      );
    }
  }
  const ended = Math.min(options.endedAt ?? Date.now(), Date.now());
  const minutes = claimed.block_started_at ? minutesBetween(claimed.block_started_at, ended) : 0;
  if (claimed.budget_key) await settleBlock(db, claimed, claimed.budget_key, minutes, reason);
  return (
    (await db.memberComputers.finish(claimed.id, {
      from: ['stopping'],
      status: 'stopped',
      stop_reason: reason,
      add_minutes: minutes,
    })) ?? null
  );
}

// ─── Start / use ─────────────────────────────────────────

export interface ComputerCaller {
  db: DatabaseProvider;
  userId: string;
  /** Who is asking (client / OAuth client): a computer it starts is billed with this attribution. */
  scope: MeteringScope;
}

export interface UsableComputer {
  row: MemberComputerRow;
  sandboxId: string;
  /** Started by this call. */
  started: boolean;
  /** The member's previous computer had already stopped; this one is new. */
  replaced: boolean;
}

function definitelyRefused(error: unknown): boolean {
  return (
    error instanceof ProviderRequestError &&
    error.statusCode !== undefined &&
    error.statusCode >= 400 &&
    error.statusCode < 500 &&
    error.statusCode !== 408
  );
}

/**
 * How long the provider may let a computer live without hearing from us: the
 * idle window after the operation in hand, plus slack. Every renewal (use,
 * heartbeat) pushes it out again.
 */
function providerDeadlineSeconds(operationSeconds: number): number {
  return COMPUTER_IDLE_MINUTES * 60 + Math.max(0, operationSeconds) + RENEW_SLACK_SECONDS;
}

async function startClaimed(
  db: DatabaseProvider,
  driver: ComputerDriver,
  row: MemberComputerRow,
  operationSeconds: number,
): Promise<UsableComputer> {
  const blockStartedAt = new Date().toISOString();
  let lease;
  try {
    lease = await reserveBlock(db, row, blockStartedAt);
  } catch (error) {
    await db.memberComputers.finish(row.id, { from: ['starting'], status: 'failed', stop_reason: 'budget' });
    throw error;
  }
  lease.markProviderIoStarted();
  let sandboxId: string;
  try {
    ({ sandboxId } = await driver.create({
      computerId: row.id,
      userId: row.user_id,
      // The first command runs right away: its own time counts before the idle window.
      timeoutSeconds: providerDeadlineSeconds(operationSeconds),
    }));
  } catch (error) {
    // A provider refusal created nothing: give the reservation back. Anything
    // else may have created a sandbox the provider will kill at its timeout —
    // the reservation stays and is charged at its estimate.
    if (definitelyRefused(error) && lease.reserved) {
      await db.usageBudget
        .release({ idempotency_key: lease.idempotencyKey, reason: 'computer_create_refused' })
        .catch(() => undefined);
    }
    await db.memberComputers.finish(row.id, { from: ['starting'], status: 'failed', stop_reason: 'failed' });
    throw error;
  }
  const running = await db.memberComputers.markRunning(row.id, {
    sandbox_id: sandboxId,
    budget_key: lease.idempotencyKey,
    block_started_at: blockStartedAt,
  });
  if (!running) {
    // Someone ended the row while the sandbox booted (the sweeper calls a
    // `starting` row stale only after minutes): do not leave the sandbox behind.
    await driver.kill(sandboxId).catch(() => undefined);
    throw new ComputerUnavailableError('busy', BUSY_MESSAGE);
  }
  logger.info('[computer] started', { computer: row.id, user: row.user_id });
  return { row: running, sandboxId, started: true, replaced: false };
}

/** Push the provider's kill deadline out and record use; false when the sandbox is gone. */
async function keepAlive(
  db: DatabaseProvider,
  driver: ComputerDriver,
  row: MemberComputerRow,
  operationSeconds: number,
): Promise<boolean> {
  const alive = await driver.renew(row.sandbox_id!, providerDeadlineSeconds(operationSeconds));
  if (!alive) {
    // The provider already killed it (its deadline passed without a renewal):
    // bill up to when it can have lived at most.
    await stopComputer(db, row, 'expired', { driver, endedAt: Date.parse(row.last_used_at) + IDLE_MS });
    return false;
  }
  await db.memberComputers.touch(row.id);
  return true;
}

/**
 * The member's running computer, started now if they have none. Refuses while
 * the switch is off, the key is missing, or the workspace is full.
 */
export async function ensureComputer(
  caller: ComputerCaller,
  options: { operationSeconds?: number; driver?: ComputerDriver } = {},
): Promise<UsableComputer> {
  const unavailable = computerUnavailableReason();
  if (unavailable) throw unavailable;
  const driver = options.driver ?? getComputerDriver();
  const operationSeconds = options.operationSeconds ?? 60;
  let replaced = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const maxRunning = computerMaxRunning();
    const claim = await caller.db.memberComputers.claimStart({
      user_id: caller.userId,
      max_running: maxRunning,
      client: caller.scope.client,
      oauth_client_id: caller.scope.oauthClientId ?? null,
    });
    if (claim.status === 'full') throw new ComputerUnavailableError('full', fullMessage(maxRunning), 429);
    if (claim.status === 'claimed') {
      const started = await startClaimed(caller.db, driver, claim.row, operationSeconds);
      return { ...started, replaced };
    }
    const row = claim.row;
    if (row.status !== 'running' || !row.sandbox_id) {
      if (Date.now() - Date.parse(row.updated_at) > STALE_TRANSITION_MS) {
        await finishStale(caller.db, row);
        continue;
      }
      throw new ComputerUnavailableError('busy', BUSY_MESSAGE);
    }
    if (await keepAlive(caller.db, driver, row, operationSeconds)) {
      return { row, sandboxId: row.sandbox_id, started: false, replaced };
    }
    replaced = true;
  }
  throw new ComputerUnavailableError('busy', BUSY_MESSAGE);
}

/** The member's running computer, never starting one; null when there is none. */
export async function currentComputer(
  caller: Pick<ComputerCaller, 'db' | 'userId'>,
  options: { operationSeconds?: number; driver?: ComputerDriver } = {},
): Promise<UsableComputer | null> {
  const unavailable = computerUnavailableReason();
  if (unavailable) throw unavailable;
  const row = await caller.db.memberComputers.getActiveForUser(caller.userId);
  if (!row || row.status !== 'running' || !row.sandbox_id) return null;
  const driver = options.driver ?? getComputerDriver();
  if (!(await keepAlive(caller.db, driver, row, options.operationSeconds ?? 60))) return null;
  return { row, sandboxId: row.sandbox_id, started: false, replaced: false };
}

/**
 * Run `work` while the computer counts as in use, here and at the provider: a
 * long command neither idles out in our sweeper nor outlives the provider's
 * kill deadline. Each beat records use and pushes the deadline a full idle
 * window out; when the work ends, both are refreshed once more.
 */
export async function withHeartbeat<T>(
  db: DatabaseProvider,
  computer: Pick<UsableComputer, 'row' | 'sandboxId'>,
  driver: ComputerDriver,
  work: () => Promise<T>,
  options: { intervalMs?: number } = {},
): Promise<T> {
  const beat = () => {
    db.memberComputers.touch(computer.row.id).catch(() => undefined);
    driver.renew(computer.sandboxId, providerDeadlineSeconds(0)).catch((error: unknown) =>
      logger.warn('[computer] could not renew a busy computer', {
        computer: computer.row.id,
        error: toErrorMessage(error),
      }),
    );
  };
  const timer = setInterval(beat, options.intervalMs ?? HEARTBEAT_MS);
  timer.unref?.();
  try {
    return await work();
  } finally {
    clearInterval(timer);
    await db.memberComputers.touch(computer.row.id).catch(() => undefined);
    await driver.renew(computer.sandboxId, providerDeadlineSeconds(0)).catch(() => false);
  }
}

/** Stop the member's own computer, if one is running. */
export async function stopMemberComputer(
  db: DatabaseProvider,
  userId: string,
  reason: StopReason = 'user',
  options: { driver?: ComputerDriver } = {},
): Promise<MemberComputerRow | null> {
  const row = await db.memberComputers.getActiveForUser(userId);
  if (!row || row.status !== 'running') return null;
  return stopComputer(db, row, reason, options);
}

// ─── Sweeper ─────────────────────────────────────────────

async function finishStale(db: DatabaseProvider, row: MemberComputerRow): Promise<void> {
  if (row.status === 'starting') {
    // The create may or may not have reached the provider; its block stays reserved.
    await db.memberComputers.finish(row.id, { from: ['starting'], status: 'failed', stop_reason: 'failed' });
  } else if (row.status === 'stopping') {
    await db.memberComputers.finish(row.id, { from: ['stopping'], status: 'lost', stop_reason: 'lost' });
  }
}

/**
 * A running computer crossed its block boundary: reserve the next block, then
 * settle the finished one.
 *
 * Safe for two processes sweeping the same snapshot: the next block's key is
 * the same for both, so they get one admission decision; the block is rolled
 * by compare-and-set on the open block's key, so one of them settles it; and a
 * refusal stops the computer only while the block it evaluated is still the
 * open one — never a computer another process has already funded further.
 */
export async function rollComputerBlock(
  db: DatabaseProvider,
  row: MemberComputerRow,
  driver: ComputerDriver,
): Promise<'rolled' | 'stopped' | 'superseded'> {
  const nextStart = new Date(Date.parse(row.block_started_at!) + BLOCK_MS).toISOString();
  let lease;
  try {
    lease = await reserveBlock(db, row, nextStart);
  } catch (error) {
    if (!findBudgetRefusal(error)) throw error;
    const stopped = await stopComputer(db, row, 'budget', { driver, expect: { budgetKey: row.budget_key } });
    if (stopped)
      logger.info('[computer] stopped a computer whose next block did not fit the budget', { computer: row.id });
    return stopped ? 'stopped' : 'superseded';
  }
  const rolled = await db.memberComputers.rollBlock(row.id, {
    expected_budget_key: row.budget_key,
    budget_key: lease.idempotencyKey,
    block_started_at: nextStart,
    add_minutes: COMPUTER_BLOCK_MINUTES,
  });
  if (!rolled) {
    // Another process installed this very block (same key — the reservation is
    // theirs too), or the computer left `running` first. Only in the second
    // case, and only if the computer never got as far as this block, was the
    // reservation never active: give it back. Never decide from `budget_key`
    // alone — a stop clears it, and a `lost` computer's last funded block must
    // stay reserved for the TTL charge. `block_started_at` survives every stop.
    const current = await db.memberComputers.get(row.id);
    const installed =
      current?.block_started_at !== null &&
      current?.block_started_at !== undefined &&
      Date.parse(current.block_started_at) >= Date.parse(nextStart);
    if (!installed) await releaseUnusedBlock(db, lease.idempotencyKey);
    return 'superseded';
  }
  if (row.budget_key) await settleBlock(db, row, row.budget_key, COMPUTER_BLOCK_MINUTES, 'block');
  return 'rolled';
}

/**
 * One pass over every computer holding a slot (index.ts runs it each minute):
 * stop the idle ones (and all of them while the switch is off), roll billing
 * blocks, and close transitions a crashed request left half done.
 */
export async function sweepComputers(
  db: DatabaseProvider,
  options: { driver?: ComputerDriver; now?: number } = {},
): Promise<{ stopped: number; rolled: number }> {
  const now = options.now ?? Date.now();
  const enabled = isComputerEnabled();
  let stopped = 0;
  let rolled = 0;
  for (const row of await db.memberComputers.listActive()) {
    try {
      if (row.status !== 'running') {
        if (now - Date.parse(row.updated_at) > STALE_TRANSITION_MS) await finishStale(db, row);
        continue;
      }
      const driver = options.driver ?? getComputerDriver();
      if (!enabled) {
        if (await stopComputer(db, row, 'disabled', { driver })) stopped++;
        continue;
      }
      if (now - Date.parse(row.last_used_at) >= IDLE_MS) {
        // Only if it is still idle now: a use since this snapshot keeps it running.
        const idleBefore = new Date(now - IDLE_MS).toISOString();
        if (await stopComputer(db, row, 'idle', { driver, expect: { idleBefore } })) stopped++;
        continue;
      }
      if (row.block_started_at && now >= Date.parse(row.block_started_at) + BLOCK_MS) {
        const outcome = await rollComputerBlock(db, row, driver);
        if (outcome === 'rolled') rolled++;
        if (outcome === 'stopped') stopped++;
      }
    } catch (error) {
      logger.warn('[computer] sweep failed for a computer', { computer: row.id, error: toErrorMessage(error) });
    }
  }
  return { stopped, rolled };
}

// ─── Read side ───────────────────────────────────────────

export function computerView(row: MemberComputerRow): ComputerView {
  return {
    id: row.id,
    status: row.status,
    started_at: new Date(row.started_at).toISOString(),
    last_used_at: new Date(row.last_used_at).toISOString(),
    stopped_at: row.stopped_at ? new Date(row.stopped_at).toISOString() : null,
    stop_reason: row.stop_reason,
    minutes_billed: row.minutes_billed,
    client: row.client,
  };
}

async function pricePerMinuteUsd(db: DatabaseProvider): Promise<number | null> {
  await syncPriceOverrides(db);
  return effectiveServicePrice('computer', 'e2b')?.price ?? null;
}

export async function myComputerReport(db: DatabaseProvider, userId: string): Promise<MyComputerReport> {
  const period = getUtcMonthPeriod();
  const [active, minutes, price] = await Promise.all([
    db.memberComputers.getActiveForUser(userId),
    db.memberComputers.minutesForUser(userId, period.start, period.end),
    pricePerMinuteUsd(db),
  ]);
  return {
    enabled: isComputerEnabled(),
    configured: isComputerConfigured(),
    price_per_minute_usd: price,
    idle_minutes: COMPUTER_IDLE_MINUTES,
    computer: active ? computerView(active) : null,
    minutes_this_month: minutes,
    period: { start: period.start, end: period.end },
  };
}

export async function adminComputersReport(db: DatabaseProvider): Promise<AdminComputersReport> {
  const [rows, users, price] = await Promise.all([
    db.memberComputers.listActive(),
    db.users.list(),
    pricePerMinuteUsd(db),
  ]);
  const byId = new Map<string, UserRow>(users.map((user) => [user.id, user]));
  return {
    enabled: isComputerEnabled(),
    configured: isComputerConfigured(),
    max_running: computerMaxRunning(),
    idle_minutes: COMPUTER_IDLE_MINUTES,
    price_per_minute_usd: price,
    running: rows.map((row) => ({
      ...computerView(row),
      user_id: row.user_id,
      user_label: byId.get(row.user_id)?.nickname ?? null,
      oauth_client_id: row.oauth_client_id,
    })),
  };
}

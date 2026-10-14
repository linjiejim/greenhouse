/**
 * The one background job queue (`jobs`, data-model §11). A job is written in the same transaction
 * as the change that causes it, one per dedupe key ever. A worker claims ready jobs with a lease
 * (FOR UPDATE SKIP LOCKED, so processes never take the same job), and only the lease holder
 * settles one. A process that dies leaves its claims to expire; the next pass anywhere puts them
 * back in the queue, so work survives a restart. Retries back off; past its attempts a job is dead.
 */

import { and, eq, inArray, lt, lte, sql } from 'drizzle-orm';
import { getDb, jobs, newId, transaction, type JobRow } from '@greenhouse/db';

export const DEFAULT_MAX_ATTEMPTS = 8;
const MAX_BACKOFF_MS = 30 * 60_000;

const later = (ms: number) => sql`now() + (${Math.max(0, Math.round(ms))} * interval '1 millisecond')`;

/** 30 s after the first failure, doubling to every 30 minutes: eight attempts span about an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 30_000 * 2 ** Math.max(0, attempts - 1));
}

export interface NewJob {
  kind: string;
  /** At most one job per key, ever: enqueueing the same key again does nothing. */
  dedupeKey: string;
  payload: Record<string, unknown>;
  /** Not claimable before this delay. */
  delayMs?: number;
  maxAttempts?: number;
  /** Recorded as already settled, saying why nothing will be done. */
  suppressed?: Record<string, unknown>;
}

/** Joins the open transaction. Null when the key was already used. */
export async function enqueueJob(job: NewJob): Promise<JobRow | null> {
  const [row] = await getDb()
    .insert(jobs)
    .values({
      id: newId('job'),
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      payload: job.payload,
      status: job.suppressed ? 'suppressed' : 'pending',
      result: job.suppressed ?? null,
      maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      availableAt: later(job.delayMs ?? 0),
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning();
  return row ?? null;
}

/** Ready jobs of these kinds, oldest first, now leased to `owner`. Each claim counts as an attempt. */
export async function claimJobs(
  kinds: readonly string[],
  owner: string,
  options: { limit: number; leaseMs: number },
): Promise<JobRow[]> {
  return transaction(async (db) => {
    const ready = await db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.status, 'pending'), inArray(jobs.kind, [...kinds]), lte(jobs.availableAt, sql`now()`)))
      .orderBy(jobs.availableAt, jobs.id)
      .limit(options.limit)
      .for('update', { skipLocked: true });
    if (!ready.length) return [];
    return db
      .update(jobs)
      .set({
        status: 'claimed',
        leaseOwner: owner,
        leaseExpiresAt: later(options.leaseMs),
        attempts: sql`${jobs.attempts} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        inArray(
          jobs.id,
          ready.map((entry) => entry.id),
        ),
      )
      .returning();
  });
}

export type JobOutcome =
  | { status: 'succeeded' | 'suppressed'; result?: Record<string, unknown> }
  | { status: 'dead'; error: string; result?: Record<string, unknown> }
  /** Back to the queue after `delayMs` (default: the backoff), or dead when out of attempts. */
  | { status: 'retry'; error: string; delayMs?: number; result?: Record<string, unknown> };

/**
 * Settles a job this owner claimed. Null when the lease was lost meanwhile: another process
 * reclaimed it after it expired, and that process settles it now.
 */
export async function settleJob(job: JobRow, owner: string, outcome: JobOutcome): Promise<JobRow['status'] | null> {
  const retry = outcome.status === 'retry';
  const exhausted = retry && job.attempts >= job.maxAttempts;
  const status = retry ? (exhausted ? 'dead' : 'pending') : outcome.status;
  const [row] = await getDb()
    .update(jobs)
    .set({
      status,
      leaseOwner: null,
      leaseExpiresAt: null,
      ...(retry && !exhausted ? { availableAt: later(outcome.delayMs ?? backoffMs(job.attempts)) } : {}),
      ...('error' in outcome
        ? { lastError: outcome.error.slice(0, 1000) }
        : status === 'succeeded'
          ? { lastError: null }
          : {}),
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      updatedAt: sql`now()`,
    })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'claimed'), eq(jobs.leaseOwner, owner)))
    .returning({ status: jobs.status });
  return row?.status ?? null;
}

/** Keeps a claim alive while its owner still works on it. False when the lease was lost meanwhile. */
export async function extendJobLease(job: JobRow, owner: string, leaseMs: number): Promise<boolean> {
  const [row] = await getDb()
    .update(jobs)
    .set({ leaseExpiresAt: later(leaseMs), updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'claimed'), eq(jobs.leaseOwner, owner)))
    .returning({ id: jobs.id });
  return !!row;
}

/**
 * Notes how far a claimed job got (in `result`), so the claim that takes it over after a crash
 * knows. False when the lease was lost meanwhile: the owner must stop.
 */
export async function recordJobProgress(job: JobRow, owner: string, result: Record<string, unknown>): Promise<boolean> {
  const [row] = await getDb()
    .update(jobs)
    .set({ result, updatedAt: sql`now()` })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, 'claimed'), eq(jobs.leaseOwner, owner)))
    .returning({ id: jobs.id });
  return !!row;
}

/** Claims whose process stopped before settling them go back to the queue (or die out of attempts). */
export async function releaseExpiredClaims(kinds: readonly string[]): Promise<number> {
  const rows = await getDb()
    .update(jobs)
    .set({
      status: sql`case when ${jobs.attempts} >= ${jobs.maxAttempts} then 'dead' else 'pending' end`,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(jobs.status, 'claimed'), inArray(jobs.kind, [...kinds]), lt(jobs.leaseExpiresAt, sql`now()`)))
    .returning({ id: jobs.id });
  return rows.length;
}

/** Settled jobs of these kinds older than `olderThanMs` are deleted: the facts they served stay in their own tables. */
export async function pruneJobs(kinds: readonly string[], olderThanMs: number): Promise<number> {
  const rows = await getDb()
    .delete(jobs)
    .where(
      and(
        inArray(jobs.kind, [...kinds]),
        inArray(jobs.status, ['succeeded', 'suppressed', 'dead']),
        lt(jobs.updatedAt, sql`now() - (${olderThanMs} * interval '1 millisecond')`),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length;
}

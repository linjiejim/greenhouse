/**
 * The 表格 background work, on the one `jobs` queue (apps/api/src/jobs.ts): recomputing what
 * computed fields work out, AI field values, CSV imports, the recycle bin's daily purge and
 * discarding the bytes of files let go of (after the commit that let go of them). Each
 * kind has one handler; a job is written in the same transaction as the change that needs it.
 * In this process a pass runs every couple of seconds, and right after a change asks for one
 * (`kick`). Tests call `drain` to run every ready job at once.
 */

import { AsyncResource } from 'node:async_hooks';
import type { JobRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { claimJobs, extendJobLease, pruneJobs, releaseExpiredClaims, settleJob, type JobOutcome } from '../../jobs.js';
import { newId } from '@greenhouse/db';

export const TABLES_JOB_KINDS = [
  'base_recompute',
  'base_ai_field',
  'base_import',
  'base_purge',
  'base_discard',
  'base_automation',
] as const;
export type TablesJobKind = (typeof TABLES_JOB_KINDS)[number];
export type TablesJobHandler = (job: JobRow) => Promise<JobOutcome>;

const BATCH = 8;
const LEASE_MS = 5 * 60_000;
const POLL_MS = 2_000;
const PRUNE_EVERY_MS = 60 * 60_000;
/** Settled jobs are kept a week for looking into. */
const KEEP_JOBS_MS = 7 * 24 * 60 * 60_000;

export function createTablesWorker() {
  // Background timers start in the service context, never a request's open transaction.
  const workerContext = new AsyncResource('tables-worker');
  const handlers = new Map<string, TablesJobHandler>();
  /** Runs before each pass: work that is due on a schedule enqueues itself (the daily purge). */
  const beforePass: Array<() => Promise<void>> = [];
  const owner = `tables:${newId('job')}`;
  let timer: NodeJS.Timeout | null = null;
  let running: Promise<void> | null = null;
  let started = false;
  let prunedAt = 0;

  async function runOnce(): Promise<number> {
    const kinds = [...handlers.keys()];
    if (!kinds.length) return 0;
    for (const step of beforePass) {
      await step().catch((error: unknown) =>
        logger.warn('[tables] a scheduled step failed', { error: toErrorMessage(error) }),
      );
    }
    await releaseExpiredClaims(kinds);
    const claimed = await claimJobs(kinds, owner, { limit: BATCH, leaseMs: LEASE_MS });
    // One at a time: jobs of one table touch the same records.
    for (const job of claimed) {
      if (!(await extendJobLease(job, owner, LEASE_MS))) continue;
      let outcome: JobOutcome;
      try {
        outcome = await handlers.get(job.kind)!(job);
      } catch (error) {
        outcome = { status: 'retry', error: toErrorMessage(error).slice(0, 500) };
      }
      const status = await settleJob(job, owner, outcome).catch((error: unknown) => {
        logger.warn('[tables] could not settle a job', { job: job.id, error: toErrorMessage(error) });
        return null;
      });
      if (status === 'dead') {
        logger.warn('[tables] gave up on a job', {
          job: job.id,
          kind: job.kind,
          error: 'error' in outcome ? outcome.error : undefined,
        });
      }
    }
    if (Date.now() - prunedAt > PRUNE_EVERY_MS) {
      prunedAt = Date.now();
      await pruneJobs(kinds, KEEP_JOBS_MS);
    }
    return claimed.length;
  }

  function schedule(delay: number) {
    if (!started || running) return;
    if (timer) clearTimeout(timer);
    timer = workerContext.runInAsyncScope(() =>
      setTimeout(() => {
        timer = null;
        running = (async () => {
          // A full batch means more may be waiting.
          while (started && (await runOnce()) === BATCH);
        })()
          .catch((error: unknown) => logger.warn('[tables] a job pass failed', { error: toErrorMessage(error) }))
          .finally(() => {
            running = null;
            schedule(POLL_MS);
          });
      }, delay),
    );
    timer.unref?.();
  }

  return {
    /** The one handler of a kind. */
    register(kind: TablesJobKind, handler: TablesJobHandler) {
      handlers.set(kind, handler);
    },
    /** Something to do before every pass, like enqueueing today's purge. */
    every(step: () => Promise<void>) {
      beforePass.push(step);
    },
    runOnce,
    /** Runs passes until nothing is ready (tests; at most `rounds` passes). */
    async drain(rounds = 50): Promise<number> {
      let total = 0;
      for (let round = 0; round < rounds; round++) {
        const done = await runOnce();
        total += done;
        if (!done) break;
      }
      return total;
    },
    /** A change committed work: run a pass soon instead of at the next poll. */
    kick() {
      if (started && !running) schedule(50);
    },
    start() {
      if (started) return;
      started = true;
      schedule(0);
    },
    async stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
      await running;
    },
  };
}

export type TablesWorker = ReturnType<typeof createTablesWorker>;

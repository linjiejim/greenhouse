import type { DatabaseProvider } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 1_000;
const DEFAULT_MAX_BATCHES_PER_PASS = 10;

export interface UsageBudgetSweeperOptions {
  intervalMs?: number;
  batchSize?: number;
  maxBatchesPerPass?: number;
}

export interface UsageBudgetSweeperHandle {
  /** Run one bounded pass. Concurrent ticks collapse into the in-flight pass. */
  sweepNow(): Promise<number>;
  stop(): void;
}

/**
 * Charge abandoned provider attempts at their conservative reservation after
 * TTL. A boot pass closes downtime gaps; the unref'ed interval keeps doing so
 * without holding the API process open. DB reservation locks make a concurrent
 * late settlement/expiry safe and idempotent.
 */
export async function startUsageBudgetSweeper(
  db: DatabaseProvider,
  options: UsageBudgetSweeperOptions = {},
): Promise<UsageBudgetSweeperHandle> {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxBatchesPerPass = options.maxBatchesPerPass ?? DEFAULT_MAX_BATCHES_PER_PASS;
  let running: Promise<number> | null = null;
  let stopped = false;

  const runPass = async (): Promise<number> => {
    let total = 0;
    try {
      for (let batch = 0; batch < maxBatchesPerPass; batch += 1) {
        const expired = await db.usageBudget.expireStaleReservations(new Date(), batchSize);
        total += expired;
        if (expired < batchSize) break;
      }
      if (total > 0) logger.info('[UsageBudget] expired stale provider reservations', { count: total });
      return total;
    } catch (err) {
      // Sweeping is reconciliation, not admission. Provider entry points still
      // fail closed on reserve while a transient sweep failure is retried next tick.
      logger.warn('[UsageBudget] stale reservation sweep failed', { error: String(err) });
      return 0;
    }
  };

  const sweepNow = (): Promise<number> => {
    if (stopped) return Promise.resolve(0);
    if (running) return running;
    running = runPass().finally(() => {
      running = null;
    });
    return running;
  };

  // Reconcile reservations that expired while the API was down before opening
  // the regular interval. Failures are contained inside runPass.
  await sweepNow();
  const timer = setInterval(() => void sweepNow(), intervalMs);
  timer.unref();

  return {
    sweepNow,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

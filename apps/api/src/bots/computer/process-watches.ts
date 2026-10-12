/**
 * Wake a Bot when a background process it started has ended.
 *
 * `run_background` (tools/computer.ts) records a watch (bot_process_watches)
 * for the conversation and Bot that started the process. Every
 * WATCH_CHECK_MS the runtime asks each RUNNING computer that has watches for
 * its process list (one `gh-jobs list`): a watched process that is no longer
 * running — exited, lost (the computer restarted under it), or gone from the
 * list — settles its watch and wakes that Bot in that conversation once, as
 * a `continue` with a note (the Bot then reads the log and tells the member).
 *
 * An asleep computer is never woken for this: on the hosted driver its
 * processes are frozen and carry on later, on docker they ended with the
 * container and gh-jobs says `lost` at the next start — either way the
 * answer comes once it runs again. A computer that was wiped drops its
 * watches; a watch older than WATCH_MAX_AGE_MS is given up.
 *
 * Several API processes may run this: `settleWatch` is a conditional update,
 * so exactly one of them delivers each wake-up.
 */

import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { BotComputerService, BotProcessWatchRow } from '@greenhouse/db';
import type { ComputerProcessView } from '@greenhouse/types/bots';

import type { InboxItem } from '../engine/inbox-types.js';

/** How often computers with watched processes are asked about them. */
export const WATCH_CHECK_MS = 60_000;
/** A watch nobody could settle in this long is given up (a computer asleep for a week, a job that never ends). */
export const WATCH_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

export interface ProcessWatchDeps {
  store: Pick<
    BotComputerService,
    'get' | 'listWatchingComputers' | 'listWatches' | 'settleWatch' | 'expireWatches' | 'dropWatches'
  >;
  /** A computer's processes, or null when it is not running (never starts it). */
  listJobs(computerId: string): Promise<ComputerProcessView[] | null>;
  deliver(sessionId: string, item: InboxItem): Promise<void>;
  now?: () => number;
}

/** What the woken Bot is told (English, like the engine's other notes to a Bot). */
export function processEndedNote(
  watch: Pick<BotProcessWatchRow, 'job_id' | 'name'>,
  job: ComputerProcessView | undefined,
): string {
  const what = `Your background process "${watch.name}" (${watch.job_id})`;
  const how =
    job?.status === 'exited'
      ? `ended with exit code ${job.exit_code ?? 'unknown'}`
      : 'stopped without an exit code (the computer was restarted or reset under it)';
  return `${what} ${how}. Read the end of its log with process_log {id: "${watch.job_id}"} and tell the member the outcome in a few lines.`;
}

export async function checkProcessWatches(deps: ProcessWatchDeps): Promise<{ woken: number }> {
  const now = deps.now ?? Date.now;
  await deps.store.expireWatches(new Date(now() - WATCH_MAX_AGE_MS).toISOString());
  let woken = 0;
  for (const computerId of await deps.store.listWatchingComputers()) {
    const computer = await deps.store.get(computerId);
    if (!computer) {
      await deps.store.dropWatches(computerId);
      continue;
    }
    if (computer.state !== 'running') continue;
    let jobs: ComputerProcessView[] | null;
    try {
      jobs = await deps.listJobs(computerId);
    } catch (err) {
      logger.warn(`[bots-computer] could not list the processes of ${computerId}: ${toErrorMessage(err)}`);
      continue;
    }
    // Stopped between the state check and the listing: ask again next round.
    if (jobs === null) continue;
    const byId = new Map(jobs.map((job) => [job.id, job]));
    for (const watch of await deps.store.listWatches(computerId)) {
      const job = byId.get(watch.job_id);
      if (job?.status === 'running') continue;
      const settled = await deps.store.settleWatch(watch.id, 'notified');
      if (!settled) continue; // another API process got there first
      try {
        await deps.deliver(watch.session_id, {
          kind: 'continue',
          author_user_id: watch.user_id,
          botId: watch.bot_id,
          note: processEndedNote(watch, job),
        });
        woken++;
      } catch (err) {
        logger.warn(
          `[bots-computer] could not wake ${watch.bot_id} about process ${watch.job_id}: ${toErrorMessage(err)}`,
        );
      }
    }
  }
  return { woken };
}

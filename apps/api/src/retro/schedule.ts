/**
 * When the monthly retro runs — a leaf (croner only) so the scheduler can plan
 * without loading the database layer.
 *
 * Nominally 09:00 on the 1st, workspace time. The aggregates cover a UTC
 * calendar month, and in zones well east of UTC (Pacific/Auckland is UTC+13 in
 * November) that local 09:00 comes before the UTC month has closed, so the run
 * waits until the UTC month end plus a margin: runAt = max(local 09:00 on the
 * 1st, UTC month end + RETRO_CLOSE_MARGIN_MS).
 */

import { Cron } from 'croner';

/** 09:00 on the 1st of every month (in the workspace zone). */
export const MONTHLY_RETRO_CRON = '0 9 1 * *';

/** Late writes (a turn settling, a sweeper pass) land in the month before the retro reads it. */
export const RETRO_CLOSE_MARGIN_MS = 15 * 60_000;

/** The calendar month in `timeZone` that ended before `at` (`YYYY-MM`). */
export function previousMonthIn(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(at);
  const year = Number(parts.find((part) => part.type === 'year')!.value);
  const month = Number(parts.find((part) => part.type === 'month')!.value);
  return new Date(Date.UTC(year, month - 2, 1)).toISOString().slice(0, 7);
}

function utcMonthEnd(month: string): number {
  const [year, index] = month.split('-').map(Number) as [number, number];
  return Date.UTC(year, index, 1);
}

export interface RetroRunPlan {
  /** When to run. */
  runAt: Date;
  /** The month (`YYYY-MM`, UTC) that run writes. */
  month: string;
}

/** The next retro run after `now` in `timeZone` (see module doc). */
export function planMonthlyRetro(now: Date, timeZone: string): RetroRunPlan {
  const cron = new Cron(MONTHLY_RETRO_CRON, { timezone: timeZone, paused: true });
  // Start a little in the past: a local 09:00 that already went by can still
  // be waiting for its UTC month to close.
  let local = cron.nextRun(new Date(now.getTime() - 2 * 86_400_000));
  for (let i = 0; local && i < 4; i++) {
    const month = previousMonthIn(local, timeZone);
    const runAt = new Date(Math.max(local.getTime(), utcMonthEnd(month) + RETRO_CLOSE_MARGIN_MS));
    if (runAt.getTime() > now.getTime()) {
      cron.stop();
      return { runAt, month };
    }
    local = cron.nextRun(local);
  }
  cron.stop();
  throw new Error(`Could not plan the monthly retro in ${timeZone}`);
}

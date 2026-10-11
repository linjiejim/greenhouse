/**
 * Schedule arithmetic for Tables automations (croner is an API dependency, so
 * this lives here, not in packages/db).
 *
 * - `validateTablesSchedule`: a parseable cron in a valid IANA zone that never
 *   fires more often than every 15 minutes (the scheduled-task floor is an hour;
 *   rules are cheap deterministic steps, not LLM turns).
 * - `tablesScheduling`: what the db service calls to set `next_fire_at` when a
 *   rule is created, enabled, or its schedule changes.
 * - `dueOccurrence`: the sweep's catch-up rule, the same as scheduled tasks — of
 *   the occurrences missed since `next_fire_at`, only the latest within 24 h
 *   runs; older ones are skipped.
 */

import { Cron } from 'croner';
import type { AutomationScheduling } from '@greenhouse/db';
import { TABLE_AUTOMATION_LIMITS, type TableAutomationSchedule } from '@greenhouse/types/tables';

export const SCHEDULE_CATCH_UP_MS = 24 * 3600_000;
const MIN_INTERVAL_MS = TABLE_AUTOMATION_LIMITS.minScheduleIntervalMinutes * 60_000;

function cronFor(schedule: Pick<TableAutomationSchedule, 'cron' | 'timezone'>): Cron {
  // No callback: croner only computes occurrences, it never starts a timer.
  return new Cron(schedule.cron, { timezone: schedule.timezone });
}

/** Null when valid; otherwise why not. */
export function validateTablesSchedule(schedule: Pick<TableAutomationSchedule, 'cron' | 'timezone'>): string | null {
  if (!schedule.cron || schedule.cron.length > 100) return 'Schedule needs a cron expression';
  let job: Cron;
  try {
    job = cronFor(schedule);
  } catch (error) {
    return `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`;
  }
  const runs = job.nextRuns(12);
  if (runs.length === 0) return 'The schedule never fires';
  for (let index = 1; index < runs.length; index++) {
    if (runs[index]!.getTime() - runs[index - 1]!.getTime() < MIN_INTERVAL_MS) {
      return `A schedule may fire at most every ${TABLE_AUTOMATION_LIMITS.minScheduleIntervalMinutes} minutes`;
    }
  }
  return null;
}

export function nextOccurrence(schedule: TableAutomationSchedule, after: Date): Date | null {
  try {
    return cronFor(schedule).nextRun(after);
  } catch {
    return null;
  }
}

export const tablesScheduling = (now?: Date): AutomationScheduling => ({ nextOccurrence, now });

/**
 * For a rule due at `nextFireAt` (≤ `now`): the occurrence to run now (the
 * latest one ≤ `now` no older than 24 h, or null when every missed one is
 * older) and the following one to store as the new `next_fire_at`.
 */
export function dueOccurrence(
  schedule: TableAutomationSchedule,
  nextFireAt: Date,
  now: Date,
): { occurrence: Date | null; next: Date | null } {
  const floor = new Date(now.getTime() - SCHEDULE_CATCH_UP_MS);
  let candidate: Date | null = nextFireAt.getTime() >= floor.getTime() ? nextFireAt : nextOccurrence(schedule, floor);
  let occurrence: Date | null = null;
  // ≤ 24 h / 15 min occurrences: the loop is bounded by the interval floor.
  for (let guard = 0; candidate && candidate.getTime() <= now.getTime() && guard < 200; guard++) {
    occurrence = candidate;
    candidate = nextOccurrence(schedule, candidate);
  }
  return {
    occurrence,
    next: candidate && candidate.getTime() > now.getTime() ? candidate : nextOccurrence(schedule, now),
  };
}

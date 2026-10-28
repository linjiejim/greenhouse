/**
 * Automations (定时任务, `/api/tasks`, apps/api/src/routes/tasks.ts) as the phone reads them.
 * React-free (./model.test.ts): the wire shapes, which automations are mine, the last result of
 * one and of a run, when the next run is in words, and the saved offline copy.
 */

import { objectId } from '../lib/object-id';
import { calendarDate, dayKey, parseMs, zonedParts, type TimeWords } from '../data/time';

/** `GET /api/tasks` rows (packages/types `ScheduledTask`, the fields the phone reads). */
export interface Automation {
  id: string;
  user_id: string;
  owner_nickname?: string;
  name: string;
  profile_id: string;
  task_prompt: string;
  schedule: string;
  timezone: string;
  enabled: boolean;
  /** Plugin preference keys (`email`, `wecom`, `feishu` …) and the optional group-bot `webhook`. */
  notify?: { [preference: string]: boolean | string | null | undefined; webhook?: string | null } | null;
  quiet_when_empty?: boolean;
  /** The per-run tool-step budget (1–20). */
  max_steps?: number;
  /** Extra tools the owner granted to unattended runs (`@greenhouse/types/automation-tools`). */
  unattended_tools?: string[];
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
}

/** `GET /api/tasks/:id/runs` entries (packages/types `AutomationRunEntry`). */
export interface AutomationRun {
  session_id: string;
  title: string | null;
  created_at: string;
  run: {
    id: string;
    status: string;
    trigger: 'scheduled' | 'manual';
    error_message: string | null;
    started_at: string | null;
    ended_at: string | null;
    no_update?: boolean;
    outcome_unknown?: boolean;
  } | null;
}

/** How a run went, as a row shows it. */
export type RunResult = 'ok' | 'failed' | 'running' | 'quiet' | 'none';

/**
 * Mine only: a super's list holds every member's automations (the web's Team view); the phone
 * shows the member's own, newest first as the station sends them.
 */
export function myAutomations(list: readonly Automation[], userId: string | null | undefined): Automation[] {
  return userId ? list.filter((task) => task.user_id === userId) : [];
}

/** Statuses of a run still under way (`last_status` mirrors the Runtime run's). */
const UNDER_WAY = new Set(['running', 'pending', 'queued', 'claimed', 'waiting']);

/**
 * The last run's result: completed is ok, a run still under way is running, and anything else
 * (failed, interrupted, missed) did not do its job.
 */
export function lastResult(task: Pick<Automation, 'last_run_at' | 'last_status'>): RunResult {
  if (!task.last_status) return 'none';
  if (task.last_status === 'completed' || task.last_status === 'succeeded') return 'ok';
  if (task.last_status === 'no_update') return 'quiet';
  return UNDER_WAY.has(task.last_status) ? 'running' : 'failed';
}

/** One run's result; a legacy run (before the Runtime) has no status and counts as done. */
export function runResult(entry: AutomationRun): RunResult {
  const run = entry.run;
  if (!run) return 'ok';
  if (run.outcome_unknown) return 'failed';
  if (run.no_update) return 'quiet';
  if (run.status === 'succeeded' || run.status === 'completed') return 'ok';
  if (run.status === 'failed' || run.status === 'interrupted' || run.status === 'cancelled') return 'failed';
  return 'running';
}

export interface NextRunWords extends TimeWords {
  /** `{time}` today. */
  today: string;
  /** `{time}` tomorrow. */
  tomorrow: string;
  /** `{date}` `{time}` (a later day). */
  later: string;
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);

/**
 * When the next run is, in the phone's time zone: "今天 09:00", "明天 09:00", "10 月 30 日 09:00";
 * '' when there is none or it cannot be read.
 */
export function nextRunLabel(iso: string | null | undefined, words: NextRunWords, now: number, timeZone?: string): string {
  const ms = parseMs(iso);
  if (!Number.isFinite(ms)) return '';
  const at = zonedParts(ms, timeZone);
  const time = `${String(at.hour).padStart(2, '0')}:${String(at.minute).padStart(2, '0')}`;
  const day = dayKey(ms, timeZone);
  if (day === dayKey(now, timeZone)) return fill(words.today, { time });
  if (day === dayKey(now + 86_400_000, timeZone)) return fill(words.tomorrow, { time });
  return fill(words.later, { date: calendarDate(String(iso), words, timeZone, now), time });
}

/** Whether an automation runs as the default assistant (no run profile of its own). */
export function runsAsAssistant(profileId: string | null | undefined): boolean {
  return !profileId || !profileId.startsWith('custom:');
}

/** A saved copy of the list (offline), or null when it is not one. */
export function parseSavedAutomations(value: unknown): Automation[] | null {
  if (!Array.isArray(value)) return null;
  const rows = value.filter(
    (row): row is Automation =>
      !!row &&
      typeof row === 'object' &&
      objectId((row as { id?: unknown }).id) !== null &&
      typeof (row as Automation).name === 'string' &&
      typeof (row as Automation).schedule === 'string',
  );
  if (rows.length !== value.length) return null;
  return rows.map((row) => ({ ...row, id: objectId(row.id)! }));
}

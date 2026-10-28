/**
 * The automation editor's schedule rules. React-free (./cron.test.ts).
 *
 * - Presets (hourly, daily, weekdays, weekly, monthly) build a standard 5-field cron, and a cron
 *   reads back as the preset that writes exactly it, else as a custom expression.
 * - `parseCronSpec` reads the 5 fields into sets; `nextRuns` lists the next fire times in the
 *   automation's own time zone (the station runs croner in that zone); `firesTooOften` applies the
 *   station's 15-minute floor to them.
 *
 * The station stays the judge (apps/api/src/scheduler/task-center.ts `validateCron`): shapes this
 * cannot preview (seconds, `L`, `W`, `#`) come back `unsupported`, are not refused here, and are
 * left to the station.
 */

export type Frequency = 'hourly' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom';

/** The builder's choices, in the order the editor offers them. */
export const FREQUENCIES: readonly Frequency[] = ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'custom'];

/** The station's floor between two fires (apps/api/src/scheduler/task-limits.ts MIN_INTERVAL_MINUTES). */
export const MIN_INTERVAL_MINUTES = 15;

/** A new automation runs every day at 09:00. */
export const DEFAULT_CRON = '0 9 * * *';

export interface ScheduleState {
  freq: Frequency;
  /** `HH:MM`, for daily, weekdays, weekly and monthly. */
  time: string;
  /** Minute past the hour, for hourly. */
  minute: number;
  /** Days of the week, Sunday = 0, for weekly. */
  weekdays: number[];
  /** Day of the month (1–31), for monthly. */
  monthDay: number;
  /** The expression itself, for custom. */
  raw: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` → [hour, minute]; anything unreadable is 09:00. */
function clock(time: string): [number, number] {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 ? [hour, minute] : [9, 0];
}

/** The cron a builder state writes. */
export function buildCron(state: ScheduleState): string {
  if (state.freq === 'custom') return state.raw.trim().replace(/\s+/g, ' ');
  if (state.freq === 'hourly') return `${Math.min(59, Math.max(0, Math.trunc(state.minute) || 0))} * * * *`;
  const [hour, minute] = clock(state.time);
  switch (state.freq) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekdays':
      return `${minute} ${hour} * * 1-5`;
    case 'weekly': {
      const days = [...new Set(state.weekdays.map((d) => ((Math.trunc(d) % 7) + 7) % 7))].sort((a, b) => a - b);
      return `${minute} ${hour} * * ${days.length ? days.join(',') : '1'}`;
    }
    case 'monthly':
      return `${minute} ${hour} ${Math.min(31, Math.max(1, Math.trunc(state.monthDay) || 1))} * *`;
  }
}

/**
 * The builder state for a cron: the preset that writes exactly this expression, else `custom`
 * holding it. Fields a preset does not use keep their defaults (09:00, Monday, the 1st), so a
 * switch of frequency starts somewhere sensible.
 */
export function parseCron(cron: string): ScheduleState {
  const raw = cron.trim().replace(/\s+/g, ' ');
  const custom: ScheduleState = { freq: 'custom', time: '09:00', minute: 0, weekdays: [1], monthDay: 1, raw };
  const parts = raw.split(' ');
  if (parts.length !== 5) return custom;
  const [min, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (mon !== '*' || !/^\d{1,2}$/.test(min)) return custom;
  const minute = Number(min);
  let candidate: ScheduleState | null = null;
  if (hour === '*' && dom === '*' && dow === '*') candidate = { ...custom, freq: 'hourly', minute };
  else if (/^\d{1,2}$/.test(hour)) {
    const base = { ...custom, time: `${pad(Number(hour))}:${pad(minute)}` };
    if (dom === '*' && dow === '*') candidate = { ...base, freq: 'daily' };
    else if (dom === '*' && dow === '1-5') candidate = { ...base, freq: 'weekdays' };
    else if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow))
      candidate = { ...base, freq: 'weekly', weekdays: dow.split(',').map((d) => Number(d) % 7) };
    else if (dow === '*' && /^\d{1,2}$/.test(dom)) candidate = { ...base, freq: 'monthly', monthDay: Number(dom) };
  }
  // Only a preset that writes the same expression back may stand for it.
  return candidate && buildCron(candidate) === raw ? candidate : custom;
}

/** Move to another frequency: custom starts from the expression the builder showed. */
export function withFrequency(state: ScheduleState, freq: Frequency): ScheduleState {
  if (freq === state.freq) return state;
  return freq === 'custom' ? { ...state, freq, raw: buildCron(state) } : { ...state, freq };
}

// ─── Parsing ─────────────────────────────────────────────

export interface CronSpec {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** The day-of-month field was `*` (or `?`). */
  anyDay: boolean;
  /** The day-of-week field was `*` (or `?`). */
  anyWeekday: boolean;
}

export type CronParse =
  | { ok: true; spec: CronSpec }
  /** `empty`: nothing written; `invalid`: not a cron; `unsupported`: valid for the station, not previewable here. */
  | { ok: false; reason: 'empty' | 'invalid' | 'unsupported' };

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

interface FieldRule {
  min: number;
  max: number;
  names?: string[];
  /** The first name stands for this number (months start at 1). */
  nameBase?: number;
}

const FIELDS: FieldRule[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: MONTH_NAMES, nameBase: 1 },
  // 7 is Sunday too
  { min: 0, max: 7, names: DAY_NAMES, nameBase: 0 },
];

class Unsupported extends Error {}

function value(token: string, rule: FieldRule): number {
  const upper = token.toUpperCase();
  const named = rule.names?.indexOf(upper) ?? -1;
  if (named >= 0) return named + (rule.nameBase ?? 0);
  if (!/^\d{1,2}$/.test(token)) throw new Error('not a number');
  const n = Number(token);
  if (n < rule.min || n > rule.max) throw new Error('out of range');
  return n;
}

function field(text: string, rule: FieldRule): number[] {
  if (/[LW#]/i.test(text.replace(/[A-Z]{3}/gi, (name) => (rule.names?.includes(name.toUpperCase()) ? '' : name))))
    throw new Unsupported();
  const out = new Set<number>();
  for (const part of text.split(',')) {
    if (!part) throw new Error('empty item');
    const [range, stepText, extra] = part.split('/');
    if (extra !== undefined) throw new Error('two steps');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (stepText !== undefined && (!/^\d{1,2}$/.test(stepText) || step < 1)) throw new Error('bad step');
    let from: number;
    let to: number;
    if (range === '*' || range === '?') {
      from = rule.min;
      to = rule.max;
    } else if (range!.includes('-')) {
      const [a, b, more] = range!.split('-');
      if (more !== undefined || !a || !b) throw new Error('bad range');
      from = value(a, rule);
      to = value(b, rule);
      if (from > to) throw new Error('backwards range');
    } else {
      from = value(range!, rule);
      // `5/15` runs from 5 to the end of the field in steps
      to = stepText === undefined ? from : rule.max;
    }
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Read a 5-field cron the way the station's croner does (day of month OR day of week). */
export function parseCronSpec(cron: string): CronParse {
  const raw = cron.trim();
  if (!raw) return { ok: false, reason: 'empty' };
  if (raw.length > 100) return { ok: false, reason: 'invalid' };
  const parts = raw.split(/\s+/);
  if (parts.length === 6 || parts.length === 7) return { ok: false, reason: 'unsupported' };
  if (parts.length !== 5) return { ok: false, reason: 'invalid' };
  try {
    const [minutes, hours, days, months, weekdays] = parts.map((text, i) => field(text, FIELDS[i]!)) as [
      number[],
      number[],
      number[],
      number[],
      number[],
    ];
    const wild = (text: string) => text === '*' || text === '?';
    return {
      ok: true,
      spec: {
        minutes,
        hours,
        days: new Set(days),
        months: new Set(months),
        weekdays: new Set(weekdays.map((d) => d % 7)),
        anyDay: wild(parts[2]!),
        anyWeekday: wild(parts[4]!),
      },
    };
  } catch (error) {
    return { ok: false, reason: error instanceof Unsupported ? 'unsupported' : 'invalid' };
  }
}

// ─── Next runs ───────────────────────────────────────────

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Wall-clock parts of an instant in a zone; throws RangeError for an unknown zone. */
function wall(ms: number, timeZone: string): Wall {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, format);
  }
  const parts = format.formatToParts(new Date(ms));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    hour: part('hour') % 24,
    minute: part('minute'),
  };
}

/** Whether the station would accept this IANA zone (the same check as task-center `validateTimezone`). */
export function isTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone });
    return true;
  } catch {
    return false;
  }
}

const asUtc = (w: Wall) => Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);

/** The instant a wall-clock time names in a zone; null when the clock skips it (a DST gap). */
function instant(target: Wall, timeZone: string): number | null {
  const guess = asUtc(target);
  let ms = guess - (asUtc(wall(guess, timeZone)) - guess);
  const corrected = guess - (asUtc(wall(ms, timeZone)) - ms);
  if (corrected !== ms) ms = corrected;
  const back = wall(ms, timeZone);
  return back.day === target.day && back.hour === target.hour && back.minute === target.minute ? ms : null;
}

/**
 * The next `count` fire times (epoch ms) strictly after `from`, in `timeZone`; fewer when the
 * expression stops firing within eight years (`0 0 30 2 *` never does). An unknown zone throws.
 */
export function nextRuns(spec: CronSpec, timeZone: string, from: number, count: number): number[] {
  const start = Math.floor(from / 60_000) * 60_000 + 60_000;
  const first = wall(start, timeZone);
  const out: number[] = [];
  for (let offset = 0; offset < 366 * 8 && out.length < count; offset += 1) {
    const date = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!spec.months.has(month)) continue;
    const byDay = spec.days.has(day);
    const byWeekday = spec.weekdays.has(date.getUTCDay());
    // croner's default (and vixie cron's): when both are restricted, either one matches
    const matches =
      spec.anyDay && spec.anyWeekday ? true : spec.anyDay ? byWeekday : spec.anyWeekday ? byDay : byDay || byWeekday;
    if (!matches) continue;
    for (const hour of spec.hours) {
      if (offset === 0 && hour < first.hour) continue;
      for (const minute of spec.minutes) {
        if (offset === 0 && hour === first.hour && minute < first.minute) continue;
        const ms = instant({ year, month, day, hour, minute }, timeZone);
        if (ms === null || ms < start || out.includes(ms)) continue;
        out.push(ms);
        if (out.length >= count) return out;
      }
    }
  }
  return out;
}

/** Two of these fire times closer than the station's floor. */
export function firesTooOften(runs: readonly number[], minMinutes = MIN_INTERVAL_MINUTES): boolean {
  for (let i = 1; i < runs.length; i += 1) if (runs[i]! - runs[i - 1]! < minMinutes * 60_000) return true;
  return false;
}

export type ScheduleCheck =
  | { ok: true; runs: number[] }
  /** `unsupported`: the station decides; there is no preview. */
  | { ok: true; runs: null; unsupported: true }
  | { ok: false; error: 'cronEmpty' | 'cronInvalid' | 'cronNever' | 'cronTooOften' | 'timezoneInvalid' };

/** The editor's verdict on a schedule: its next runs (`count` of them), or why it cannot be saved. */
export function checkSchedule(cron: string, timeZone: string, from: number, count = 3): ScheduleCheck {
  if (!isTimeZone(timeZone)) return { ok: false, error: 'timezoneInvalid' };
  const parsed = parseCronSpec(cron);
  if (!parsed.ok) {
    if (parsed.reason === 'unsupported') return { ok: true, runs: null, unsupported: true };
    return { ok: false, error: parsed.reason === 'empty' ? 'cronEmpty' : 'cronInvalid' };
  }
  // enough fires to see the gaps an hour holds (`*/10 9 * * *` fires six times in one)
  const runs = nextRuns(parsed.spec, timeZone, from, Math.max(count, 6));
  if (!runs.length) return { ok: false, error: 'cronNever' };
  if (firesTooOften(runs)) return { ok: false, error: 'cronTooOften' };
  return { ok: true, runs: runs.slice(0, count) };
}

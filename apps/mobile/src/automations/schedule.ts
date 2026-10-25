/**
 * An automation's cron schedule in words ("每天 09:00", "Every Mon at 09:00"). Pure
 * (./schedule.test.ts): the words come in, so the rule runs without the app's i18n.
 *
 * Only the common shapes the web's schedule builder writes are worded (daily, weekdays,
 * weekends, chosen weekdays, a day of the month, hourly, every N hours, a few times a day);
 * anything else comes back as the raw cron. The time is the automation's own (its `timezone`),
 * as written in the cron, never converted to the phone's.
 */

export interface ScheduleWords {
  /** `{time}` every day. */
  daily: string;
  /** `{time}` Monday to Friday. */
  weekdays: string;
  /** `{time}` Saturday and Sunday. */
  weekends: string;
  /** `{days}` (joined names) at `{time}`. */
  weekly: string;
  /** Day `{day}` of every month at `{time}`. */
  monthly: string;
  /** Every hour at minute `{minute}` (two digits). */
  hourly: string;
  /** Every `{n}` hours. */
  everyHours: string;
  /** Day names, Sunday first (7 entries). */
  dayNames: readonly string[];
  /** Between day names and between times. */
  listSep: string;
}

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));

const pad = (n: number) => String(n).padStart(2, '0');

/** A whole number in [min, max] written plainly, or null. */
function num(raw: string, min: number, max: number): number | null {
  if (!/^\d{1,2}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

/** Comma-separated whole numbers in [min, max], or null when any is not one. */
function list(raw: string, min: number, max: number): number[] | null {
  const parts = raw.split(',').map((part) => num(part, min, max));
  return parts.every((n): n is number => n !== null) ? parts : null;
}

/** The weekdays a cron day-of-week field names (0–7, 7 = Sunday; ranges like 1-5), Sunday = 0; null otherwise. */
function weekdays(raw: string): number[] | null {
  const days = new Set<number>();
  for (const part of raw.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (from > to || to > 7) return null;
      for (let d = from; d <= to; d += 1) days.add(d % 7);
      continue;
    }
    const day = num(part, 0, 7);
    if (day === null) return null;
    days.add(day % 7);
  }
  return [...days].sort((a, b) => a - b);
}

/** The cron in words, or the cron itself when it is not a common shape. */
export function describeSchedule(cron: string, words: ScheduleWords): string {
  const raw = cron.trim();
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return raw;
  const [minField, hourField, domField, monField, dowField] = parts as [string, string, string, string, string];
  if (monField !== '*') return raw;
  const minute = num(minField, 0, 59);
  if (minute === null) return raw;

  if (domField === '*' && dowField === '*') {
    if (hourField === '*') return fill(words.hourly, { minute: pad(minute) });
    const every = /^\*\/(\d{1,2})$/.exec(hourField);
    if (every) {
      const n = Number(every[1]);
      return n >= 1 && n <= 23 ? fill(words.everyHours, { n }) : raw;
    }
  }

  const hours = list(hourField, 0, 23);
  if (!hours) return raw;
  const time = hours.map((hour) => `${pad(hour)}:${pad(minute)}`).join(words.listSep);

  if (domField === '*') {
    if (dowField === '*') return fill(words.daily, { time });
    const days = weekdays(dowField);
    if (!days || !days.length) return raw;
    if (days.length === 7) return fill(words.daily, { time });
    if (days.join() === '1,2,3,4,5') return fill(words.weekdays, { time });
    if (days.join() === '0,6') return fill(words.weekends, { time });
    // the week reads Monday first
    const ordered = [...days.filter((d) => d !== 0), ...days.filter((d) => d === 0)];
    return fill(words.weekly, { days: ordered.map((d) => words.dayNames[d] ?? String(d)).join(words.listSep), time });
  }

  if (dowField === '*') {
    const day = num(domField, 1, 31);
    if (day !== null) return fill(words.monthly, { day, time });
  }
  return raw;
}

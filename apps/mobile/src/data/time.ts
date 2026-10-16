/**
 * Times as the server writes them and as people read them. React-free (./time.test.ts).
 *
 * `parseMs`: Postgres-style strings like "2026-06-08 05:05:34.202+00" (a space instead of T,
 * "+00" instead of "+00:00") are what the API sends; Hermes' strict Date parser rejects them
 * (Invalid Date) even though browsers accept them.
 *
 * `relativeTime` follows docs/design-system/content.md: within the hour 「刚刚」「12 分钟前」;
 * the same day 「14:20」; yesterday 「昨天 14:20」; earlier 「10 月 3 日」; another year
 * 「2025 年 10 月 3 日」 — in the member's time zone.
 */

/** A timestamp in ms, or NaN. */
export function parseMs(iso?: string | null): number {
  if (!iso) return NaN;
  let s = String(iso).trim().replace(' ', 'T');
  // "+00" → "+00:00", "+0800" → "+08:00"; leave "+08:00" / "Z" untouched.
  s = s.replace(/([+-]\d{2})(\d{2})?$/, (_m, hh: string, mm?: string) => `${hh}:${mm || '00'}`);
  let ms = Date.parse(s);
  if (Number.isNaN(ms)) ms = Date.parse(iso);
  return ms;
}

/** The calendar parts of an instant in a time zone (the device's when the zone is unknown). */
export function zonedParts(
  ms: number,
  timeZone?: string,
): { year: number; month: number; day: number; hour: number; minute: number } {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const part = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
    return {
      year: part('year'),
      month: part('month'),
      day: part('day'),
      hour: part('hour') % 24,
      minute: part('minute'),
    };
  } catch {
    const date = new Date(ms);
    return {
      year: date.getFullYear(),
      month: date.getMonth() + 1,
      day: date.getDate(),
      hour: date.getHours(),
      minute: date.getMinutes(),
    };
  }
}

/** `YYYY-MM-DD` of an instant in a time zone: which day it belongs to. */
export function dayKey(ms: number, timeZone?: string): string {
  const { year, month, day } = zonedParts(ms, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export interface TimeWords {
  justNow: string;
  /** `{n}` minutes ago. */
  minutesAgo: string;
  /** `{time}` yesterday. */
  yesterday: string;
  /** `{month}` (or `{monthName}`) / `{day}` this year. */
  monthDay: string;
  /** `{year}` / `{month}` (or `{monthName}`) / `{day}`. */
  yearMonthDay: string;
  /** Short month names, January first (English); absent where months are numbers. */
  monthNames?: readonly string[];
}

const fill = (template: string, vars: Record<string, string | number>) =>
  template.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match));

/** Calendar dates use the dictionary even on devices with only English Intl data. */
export function calendarDate(iso: string, words: TimeWords, timeZone?: string, now = Date.now()): string {
  const ms = parseMs(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (!Number.isFinite(ms)) return '';
  const date = zonedParts(ms, iso.length === 10 ? 'UTC' : timeZone);
  const template = date.year === zonedParts(now, timeZone).year ? words.monthDay : words.yearMonthDay;
  return fill(template, { ...date, monthName: words.monthNames?.[date.month - 1] ?? date.month });
}

/** content.md's relative time, '' for an unreadable time. */
export function relativeTime(iso: string | null | undefined, words: TimeWords, now: number, timeZone?: string): string {
  const ms = parseMs(iso);
  if (Number.isNaN(ms)) return '';
  const diff = now - ms;
  if (diff < 60_000) return words.justNow;
  if (diff < 3_600_000) return fill(words.minutesAgo, { n: Math.floor(diff / 60_000) });
  const then = zonedParts(ms, timeZone);
  const clock = `${String(then.hour).padStart(2, '0')}:${String(then.minute).padStart(2, '0')}`;
  if (dayKey(ms, timeZone) === dayKey(now, timeZone)) return clock;
  if (dayKey(ms, timeZone) === dayKey(now - 86_400_000, timeZone)) return fill(words.yesterday, { time: clock });
  const today = zonedParts(now, timeZone);
  const date = { month: then.month, monthName: words.monthNames?.[then.month - 1] ?? then.month, day: then.day };
  if (then.year === today.year) return fill(words.monthDay, date);
  return fill(words.yearMonthDay, { ...date, year: then.year });
}

/** Relative times (../data/time.ts) in the app's language and the phone's time zone. */

import { calendarDate, parseMs, relativeTime, shortAge, zonedParts, type TimeWords } from '../data/time';
import { t } from './i18n';

/** The calendar words in the app's language (../data/time.ts). */
export function timeWords(): TimeWords {
  const months = t('time.months');
  return {
    justNow: t('time.justNow'),
    minutesAgo: t('time.minutesAgo'),
    yesterday: t('time.yesterday'),
    monthDay: t('time.monthDay'),
    yearMonthDay: t('time.yearMonthDay'),
    monthNames: months ? months.split(',') : undefined,
  };
}

/** content.md's relative time for this moment ('' for an unreadable time). */
export function relativeTimeNow(iso: string | null | undefined): string {
  return relativeTime(iso, timeWords(), Date.now(), undefined);
}

/** A compact age (3m, 8h, 1d, 2w; ../data/time.ts `shortAge`), '' for an unreadable time. */
export function shortAgeNow(iso: string | null | undefined): string {
  const age = shortAge(iso, Date.now());
  if (!age) return '';
  return age.unit === 'now' ? t('time.short.now') : t(`time.short.${age.unit}`, { n: age.n });
}

export function calendarDateLabel(iso: string): string {
  return calendarDate(iso, timeWords(), undefined);
}

/** A calendar date and clock time in the app's language — for future times (next run) and exact stamps. */
export function dateTimeLabel(iso: string | null | undefined): string {
  const ms = parseMs(iso);
  if (!iso || Number.isNaN(ms)) return '';
  const { hour, minute } = zonedParts(ms);
  return `${calendarDate(iso, timeWords(), undefined)} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

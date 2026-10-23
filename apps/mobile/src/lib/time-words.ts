/** Relative times (../data/time.ts) in the app's language and the phone's time zone. */

import { calendarDate, relativeTime, type TimeWords } from '../data/time';
import { t } from './i18n';

function words(): TimeWords {
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
  return relativeTime(iso, words(), Date.now(), undefined);
}

export function calendarDateLabel(iso: string): string {
  return calendarDate(iso, words(), undefined);
}

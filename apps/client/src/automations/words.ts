/** An automation's schedule and next run in the app's language (rules: ./schedule.ts, ./model.ts). */

import { t } from '../lib/i18n';
import { timeWords } from '../lib/time-words';
import { nextRunLabel } from './model';
import { describeSchedule, zonePlace } from './schedule';

/**
 * "每天 09:00", or the raw cron for an uncommon shape; the clock is the automation's own zone, so
 * a zone other than the phone's is named after it ("工作日 13:00 (Los Angeles)").
 */
export function scheduleLabel(cron: string, timeZone?: string | null): string {
  const place = zonePlace(timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
  const words = describeSchedule(cron, {
    daily: t('automations.schedule.daily'),
    weekdays: t('automations.schedule.weekdays'),
    weekends: t('automations.schedule.weekends'),
    weekly: t('automations.schedule.weekly'),
    monthly: t('automations.schedule.monthly'),
    hourly: t('automations.schedule.hourly'),
    everyHours: t('automations.schedule.everyHours'),
    dayNames: t('automations.schedule.dayNames').split(','),
    listSep: t('automations.schedule.listSep'),
  });
  return place ? `${words} (${place})` : words;
}

/** "明天 09:00" in the phone's time zone; '' without a next run. */
export function nextRunNow(iso: string | null | undefined): string {
  return nextRunLabel(
    iso,
    {
      ...timeWords(),
      today: t('automations.today'),
      tomorrow: t('automations.tomorrow'),
      later: t('automations.later'),
    },
    Date.now(),
  );
}

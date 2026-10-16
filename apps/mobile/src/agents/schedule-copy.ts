import type { TFunction } from '../lib/i18n';
import { readScheduleTime, scheduleFrequencies, type ScheduleFrequency } from '../data/schedule-time';
export function repeatLabel(frequency: ScheduleFrequency, t: TFunction): string {
  return t(
    (/^\d$/.test(frequency) ? `integration.day${frequency}` : `integration.${frequency}`) as 'integration.daily',
  );
}
export function repeatOptions(cron: string, t: TFunction) {
  return [
    ...(!readScheduleTime(cron) ? [{ value: 'custom', label: t('integration.customSchedule') }] : []),
    ...scheduleFrequencies.map((value) => ({ value, label: repeatLabel(value, t) })),
  ];
}
export function scheduleLabel(cron: string, t: TFunction): string {
  const time = readScheduleTime(cron);
  return time
    ? t('integration.scheduledAt', {
        repeat: repeatLabel(time.frequency, t),
        time: `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`,
      })
    : t('integration.customSchedule');
}

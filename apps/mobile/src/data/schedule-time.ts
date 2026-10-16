/** The phone edits common wall-clock schedules; other expressions stay opaque. */
export const scheduleFrequencies = ['daily', 'weekdays', 'weekend', '1', '2', '3', '4', '5', '6', '0'] as const;
export type ScheduleFrequency = (typeof scheduleFrequencies)[number];
export function readScheduleTime(cron: string): { frequency: ScheduleFrequency; hour: number; minute: number } | null {
  const match = /^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+(\*|1-5|0,6|6,0|[0-7])$/.exec(cron.trim());
  if (!match) return null;
  const minute = Number(match[1]),
    hour = Number(match[2]);
  if (minute > 59 || hour > 23) return null;
  const day = match[3]!;
  const frequency =
    day === '*'
      ? 'daily'
      : day === '1-5'
        ? 'weekdays'
        : ['0,6', '6,0'].includes(day)
          ? 'weekend'
          : day === '7'
            ? '0'
            : (day as ScheduleFrequency);
  return { frequency, hour, minute };
}
export function writeScheduleTime(frequency: ScheduleFrequency, hour: number, minute: number): string {
  const day =
    frequency === 'daily' ? '*' : frequency === 'weekdays' ? '1-5' : frequency === 'weekend' ? '0,6' : frequency;
  return `${minute} ${hour} * * ${day}`;
}

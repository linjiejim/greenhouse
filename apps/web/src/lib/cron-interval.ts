/**
 * Client-side hint for the Automation schedule editor: does a raw cron
 * expression obviously fire more often than the server's 15-minute floor?
 *
 * Only the minute field is inspected — two fires inside one hour closer than
 * the floor are too frequent whatever the other fields say. Shapes this does
 * not understand return false and are left to the server, which owns the real
 * check (`scheduler/task-center.validateCron`).
 */

export const AUTOMATION_MIN_INTERVAL_MINUTES = 15;

function minuteValues(field: string): number[] | null {
  if (field === '*') return Array.from({ length: 60 }, (_, i) => i);
  const step = /^\*\/(\d{1,2})$/.exec(field);
  if (step) {
    const n = Number(step[1]);
    if (n < 1) return null;
    return Array.from({ length: Math.ceil(60 / n) }, (_, i) => i * n).filter((m) => m < 60);
  }
  const range = /^(\d{1,2})-(\d{1,2})$/.exec(field);
  if (range) {
    const [from, to] = [Number(range[1]), Number(range[2])];
    if (from > to || to > 59) return null;
    return Array.from({ length: to - from + 1 }, (_, i) => from + i);
  }
  if (/^\d{1,2}(,\d{1,2})+$/.test(field)) {
    const values = [...new Set(field.split(',').map(Number))].sort((a, b) => a - b);
    return values.every((m) => m <= 59) ? values : null;
  }
  return null;
}

export function cronFiresTooOften(cron: string, minMinutes = AUTOMATION_MIN_INTERVAL_MINUTES): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const minutes = minuteValues(parts[0]!);
  if (!minutes || minutes.length < 2) return false;
  for (let i = 1; i < minutes.length; i += 1) {
    if (minutes[i]! - minutes[i - 1]! < minMinutes) return true;
  }
  // Wrap-around into the next hour only matters when every hour fires.
  return parts[1] === '*' && minutes[0]! + 60 - minutes[minutes.length - 1]! < minMinutes;
}

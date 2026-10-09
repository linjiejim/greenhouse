/**
 * An automation's cron in words, for a Bot's 定时 tab (./profile-tabs.tsx) —
 * the web Automations page's builder shapes (apps/web/src/pages/automations.tsx
 * `parseCron`): every day, weekdays, some weekdays, a day of the month, at
 * HH:MM. Anything else is shown as the cron itself (`null`). The server's
 * `schedule_desc` is only "Next: <ISO>" — not something to show.
 */

export type ScheduleWords =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'monthly'; day: number; time: string };

export function scheduleWords(cron: string): ScheduleWords | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  if (!/^\d{1,2}$/.test(min) || !/^\d{1,2}$/.test(hr) || mon !== '*') return null;
  if (Number(hr) > 23 || Number(min) > 59) return null;
  const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
  if (dom === '*' && dow === '*') return { kind: 'daily', time };
  if (dom === '*' && dow === '1-5') return { kind: 'weekdays', time };
  if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) {
    // 0 and 7 are both Sunday
    const days = [...new Set(dow.split(',').map((d) => Number(d) % 7))].sort((a, b) => a - b);
    return { kind: 'weekly', days, time };
  }
  if (dow === '*' && /^\d{1,2}$/.test(dom) && Number(dom) >= 1 && Number(dom) <= 31) {
    return { kind: 'monthly', day: Number(dom), time };
  }
  return null;
}

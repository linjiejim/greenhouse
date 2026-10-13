/**
 * The schedule forms speak in frequencies, not cron. These are the ones the form builds and can
 * read back; anything else is shown and edited as the raw five fields.
 */

export type Frequency =
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekdays'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number }
  | { kind: 'monthly'; day: number; hour: number; minute: number }
  | { kind: 'hourly'; minute: number }
  | { kind: 'custom'; cron: string };

export function toCron(frequency: Frequency): string {
  switch (frequency.kind) {
    case 'daily':
      return `${frequency.minute} ${frequency.hour} * * *`;
    case 'weekdays':
      return `${frequency.minute} ${frequency.hour} * * 1-5`;
    case 'weekly':
      return `${frequency.minute} ${frequency.hour} * * ${frequency.weekday}`;
    case 'monthly':
      return `${frequency.minute} ${frequency.hour} ${frequency.day} * *`;
    case 'hourly':
      return `${frequency.minute} * * * *`;
    case 'custom':
      return frequency.cron.trim();
  }
}

const int = (value: string, min: number, max: number) => {
  if (!/^\d{1,2}$/.test(value)) return null;
  const number = Number(value);
  return number >= min && number <= max ? number : null;
};

export function fromCron(cron: string): Frequency {
  const [m, h, dom, mon, dow, ...rest] = cron.trim().split(/\s+/);
  const custom: Frequency = { kind: 'custom', cron: cron.trim() };
  if (rest.length || mon !== '*') return custom;
  const minute = int(m ?? '', 0, 59);
  if (minute === null) return custom;
  if (h === '*' && dom === '*' && dow === '*') return { kind: 'hourly', minute };
  const hour = int(h ?? '', 0, 23);
  if (hour === null) return custom;
  if (dom === '*' && dow === '*') return { kind: 'daily', hour, minute };
  if (dom === '*' && dow === '1-5') return { kind: 'weekdays', hour, minute };
  if (dom === '*') {
    const weekday = int(dow ?? '', 0, 6);
    return weekday === null ? custom : { kind: 'weekly', weekday, hour, minute };
  }
  if (dow === '*') {
    const day = int(dom ?? '', 1, 28);
    return day === null ? custom : { kind: 'monthly', day, hour, minute };
  }
  return custom;
}

const pad = (value: number) => String(value).padStart(2, '0');

const WEEKDAYS = {
  zh: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'],
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
} as const;

export const weekdayName = (day: number, locale: 'zh' | 'en') => WEEKDAYS[locale][day] ?? String(day);

/** 「每天 09:00」, "Weekdays at 09:00", or the raw fields. */
export function describeCron(cron: string, locale: 'zh' | 'en'): string {
  const frequency = fromCron(cron);
  const zh = locale === 'zh';
  switch (frequency.kind) {
    case 'daily':
      return zh
        ? `每天 ${pad(frequency.hour)}:${pad(frequency.minute)}`
        : `Daily at ${pad(frequency.hour)}:${pad(frequency.minute)}`;
    case 'weekdays':
      return zh
        ? `工作日 ${pad(frequency.hour)}:${pad(frequency.minute)}`
        : `Weekdays at ${pad(frequency.hour)}:${pad(frequency.minute)}`;
    case 'weekly':
      return zh
        ? `每${weekdayName(frequency.weekday, locale)} ${pad(frequency.hour)}:${pad(frequency.minute)}`
        : `${weekdayName(frequency.weekday, locale)}s at ${pad(frequency.hour)}:${pad(frequency.minute)}`;
    case 'monthly':
      return zh
        ? `每月 ${frequency.day} 日 ${pad(frequency.hour)}:${pad(frequency.minute)}`
        : `Monthly on day ${frequency.day} at ${pad(frequency.hour)}:${pad(frequency.minute)}`;
    case 'hourly':
      return zh ? `每小时第 ${frequency.minute} 分` : `Hourly at :${pad(frequency.minute)}`;
    case 'custom':
      return frequency.cron;
  }
}

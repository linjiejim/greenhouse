/**
 * The schedule forms speak in frequencies, not cron. These are the ones the form builds and can
 * read back; custom expressions stay editable, while summaries always use words.
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

/** Human schedule copy shared by cards, directories and schedule forms. */
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
      return describeCustomCron(frequency.cron, locale);
  }
}

/** Keep all five constraints visible without exposing cron syntax or changing its OR semantics. */
function describeCustomCron(cron: string, locale: 'zh' | 'en'): string {
  const zh = locale === 'zh';
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) return zh ? '自定义时间' : 'Custom timing';
  const [minute, hour, day, month, weekday] = fields as [string, string, string, string, string];
  const interval = /^\*\/(\d+)$/.exec(minute);
  if (interval && hour === '*' && day === '*' && month === '*' && weekday === '*')
    return zh ? `每 ${Number(interval[1])} 分钟` : `Every ${Number(interval[1])} minutes`;
  const names = [
    zh ? '分钟' : 'Minute',
    zh ? '小时' : 'Hour',
    zh ? '日期' : 'Day',
    zh ? '月份' : 'Month',
    zh ? '星期' : 'Weekday',
  ];
  const value = (part: string, index: number): string => {
    const named = (n: string): string => {
      const dayNames = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
      const monthNames = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      const alias =
        index === 4 ? dayNames.indexOf(n.toUpperCase()) : index === 3 ? monthNames.indexOf(n.toUpperCase()) + 1 : -1;
      const number = /^\d+$/.test(n) ? Number(n) : alias;
      if (number >= 0) return index === 4 ? weekdayName(number % 7, locale) : String(number);
      if (n === 'L') return zh ? '最后一天' : 'last day';
      const nth = /^(\d|[a-z]{3})#([1-5L])$/i.exec(n);
      if (index === 4 && nth)
        return zh
          ? `每月第 ${nth[2] === 'L' ? '最后一个' : nth[2]} 个${named(nth[1]!)}`
          : `${named(nth[1]!)}, occurrence ${nth[2] === 'L' ? 'last' : nth[2]}`;
      const workday = /^(\d+)W$/.exec(n);
      if (workday) return zh ? `最接近 ${workday[1]} 日的工作日` : `weekday nearest day ${workday[1]}`;
      return zh ? '自定义日期' : 'custom date';
    };
    if (part === '*') return zh ? '每个' : 'every';
    return part
      .split(',')
      .map((item) => {
        const [range = '', step] = item.split('/');
        const span =
          range === '*'
            ? zh
              ? '每个'
              : 'every'
            : range
                .split('-')
                .map(named)
                .join(zh ? '至' : '–');
        return step ? `${span}${zh ? `，间隔 ${Number(step)}` : `, every ${Number(step)}`}` : span;
      })
      .join(zh ? '、' : ', ');
  };
  const parts = fields.flatMap((part, index) => (part === '*' ? [] : [`${names[index]}：${value(part, index)}`]));
  if (day !== '*' && weekday !== '*') {
    const a = `${names[2]}：${value(day, 2)}`;
    const b = `${names[4]}：${value(weekday, 4)}`;
    return [...parts.filter((p) => p !== a && p !== b), `${a}${zh ? '或' : ' or '}${b}`].join(' · ');
  }
  return parts.join(' · ') || (zh ? '每分钟' : 'Every minute');
}

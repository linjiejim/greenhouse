/**
 * Times as docs/design-system/content.md writes them: 刚刚, 12 分钟前, 14:20, 昨天 14:20,
 * 10 月 3 日, 2025 年 10 月 3 日 (and the English equivalents), in the member's time zone.
 */

export type TimeLocale = 'zh' | 'en';

const dayKey = (date: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export function relativeTime(iso: string, options: { locale: TimeLocale; timeZone: string; now?: Date }): string {
  const { locale, timeZone } = options;
  const now = options.now ?? new Date();
  const date = new Date(iso);
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return locale === 'zh' ? '刚刚' : 'just now';
  if (minutes < 60) return locale === 'zh' ? `${minutes} 分钟前` : `${minutes} min ago`;
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
  const day = dayKey(date, timeZone);
  if (day === dayKey(now, timeZone)) return clock;
  if (day === dayKey(new Date(now.getTime() - 86_400_000), timeZone)) {
    return locale === 'zh' ? `昨天 ${clock}` : `Yesterday ${clock}`;
  }
  const sameYear = day.slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  const [year, month, dayOfMonth] = day.split('-').map(Number) as [number, number, number];
  if (locale === 'zh') return sameYear ? `${month} 月 ${dayOfMonth} 日` : `${year} 年 ${month} 月 ${dayOfMonth} 日`;
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(date);
}

/** The full time, for a hover title. */
export function fullTime(iso: string, options: { locale: TimeLocale; timeZone: string }): string {
  return new Intl.DateTimeFormat(options.locale === 'zh' ? 'zh-CN' : 'en-US', {
    timeZone: options.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(new Date(iso));
}

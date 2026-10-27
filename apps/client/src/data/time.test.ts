import { describe, expect, it } from 'vitest';
import { calendarDate, dayKey, parseMs, relativeTime, shortAge, type TimeWords } from './time';

const zh: TimeWords = {
  justNow: '刚刚',
  minutesAgo: '{n} 分钟前',
  yesterday: '昨天 {time}',
  monthDay: '{month} 月 {day} 日',
  yearMonthDay: '{year} 年 {month} 月 {day} 日',
};
const en: TimeWords = {
  justNow: 'just now',
  minutesAgo: '{n} min ago',
  yesterday: 'yesterday {time}',
  monthDay: '{monthName} {day}',
  yearMonthDay: '{monthName} {day}, {year}',
  monthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

const TZ = 'Asia/Shanghai';
const now = Date.parse('2026-10-14T06:30:00.000Z'); // 14:30 in Shanghai

it('formats calendar dates with the app dictionary and preserves date-only days', () => {
  expect(calendarDate('2026-10-15', zh, 'Pacific/Honolulu', now)).toBe('10 月 15 日');
  expect(calendarDate('2026-10-15T20:00:00Z', zh, TZ, now)).toBe('10 月 16 日');
  expect(calendarDate('2026-10-15', en, TZ, now)).toBe('Oct 15');
  expect(calendarDate('2027-01-02', zh, TZ, now)).toBe('2027 年 1 月 2 日');
  expect(calendarDate('unreadable', zh, TZ, now)).toBe('');
});

describe('parseMs', () => {
  it('reads the Postgres shapes the API sends, which Hermes would refuse', () => {
    const want = Date.parse('2026-06-08T05:05:34.202Z');
    expect(parseMs('2026-06-08 05:05:34.202+00')).toBe(want);
    expect(parseMs('2026-06-08 13:05:34.202+0800')).toBe(want);
    expect(parseMs('2026-06-08T13:05:34.202+08:00')).toBe(want);
    expect(parseMs('2026-06-08T05:05:34.202Z')).toBe(want);
    expect(parseMs(null)).toBeNaN();
    expect(parseMs('soon')).toBeNaN();
  });
});

describe('relativeTime (docs/design-system/content.md)', () => {
  const at = (iso: string, words = zh) => relativeTime(iso, words, now, TZ);

  it('within the hour, then the clock, then yesterday, then the date', () => {
    expect(at('2026-10-14T06:29:30.000Z')).toBe('刚刚');
    expect(at('2026-10-14T06:18:00.000Z')).toBe('12 分钟前');
    expect(at('2026-10-14T01:05:00.000Z')).toBe('09:05');
    expect(at('2026-10-13T06:20:00.000Z')).toBe('昨天 14:20');
    expect(at('2026-10-03T02:00:00.000Z')).toBe('10 月 3 日');
    expect(at('2025-10-03T02:00:00.000Z')).toBe('2025 年 10 月 3 日');
    expect(at('2026-10-03T02:00:00.000Z', en)).toBe('Oct 3');
    expect(at('2025-10-03T02:00:00.000Z', en)).toBe('Oct 3, 2025');
    expect(at('later')).toBe('');
  });

  it('counts days in the member’s time zone', () => {
    // 23:30 UTC on the 13th is already the 14th in Shanghai
    expect(at('2026-10-13T23:30:00.000Z')).toBe('07:30');
    expect(dayKey(Date.parse('2026-10-13T23:30:00.000Z'), TZ)).toBe('2026-10-14');
    expect(dayKey(Date.parse('2026-10-13T23:30:00.000Z'), 'UTC')).toBe('2026-10-13');
  });
});

describe('shortAge', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('says 3m, 8h, 1d, 2w', () => {
    expect(shortAge(ago(20_000), now)).toEqual({ n: 0, unit: 'now' });
    expect(shortAge(ago(3 * 60_000), now)).toEqual({ n: 3, unit: 'm' });
    expect(shortAge(ago(8 * 3_600_000 + 59 * 60_000), now)).toEqual({ n: 8, unit: 'h' });
    expect(shortAge(ago(30 * 3_600_000), now)).toEqual({ n: 1, unit: 'd' });
    expect(shortAge(ago(6 * 86_400_000), now)).toEqual({ n: 6, unit: 'd' });
    expect(shortAge(ago(15 * 86_400_000), now)).toEqual({ n: 2, unit: 'w' });
    expect(shortAge(ago(400 * 86_400_000), now)).toEqual({ n: 1, unit: 'y' });
  });
  it('treats a clock ahead of the phone as now and an unreadable time as nothing', () => {
    expect(shortAge(new Date(now + 90_000).toISOString(), now)).toEqual({ n: 0, unit: 'now' });
    expect(shortAge('not a time', now)).toBeNull();
    expect(shortAge(null, now)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { describeCron, fromCron, toCron, type Frequency } from '../cron';

describe('schedule frequencies', () => {
  it('builds and reads back every frequency the form offers', () => {
    const frequencies: Frequency[] = [
      { kind: 'daily', hour: 9, minute: 0 },
      { kind: 'weekdays', hour: 18, minute: 30 },
      { kind: 'weekly', weekday: 1, hour: 9, minute: 15 },
      { kind: 'monthly', day: 28, hour: 7, minute: 5 },
      { kind: 'hourly', minute: 45 },
    ];
    for (const frequency of frequencies) expect(fromCron(toCron(frequency))).toEqual(frequency);
  });

  it('keeps anything else as raw fields', () => {
    expect(fromCron('*/30 * * * *')).toEqual({ kind: 'custom', cron: '*/30 * * * *' });
    expect(fromCron('0 9 1 1 *')).toEqual({ kind: 'custom', cron: '0 9 1 1 *' });
    expect(fromCron('0 9 31 * *')).toEqual({ kind: 'custom', cron: '0 9 31 * *' });
  });

  it('describes them in both languages', () => {
    expect(describeCron('0 9 * * *', 'zh')).toBe('每天 09:00');
    expect(describeCron('30 18 * * 1-5', 'en')).toBe('Weekdays at 18:30');
    expect(describeCron('15 9 * * 1', 'zh')).toBe('每周一 09:15');
    expect(describeCron('5 7 28 * *', 'en')).toBe('Monthly on day 28 at 07:05');
    expect(describeCron('45 * * * *', 'zh')).toBe('每小时第 45 分');
    expect(describeCron('*/30 * * * *', 'en')).toBe('Every 30 minutes');
  });
});

it('describes custom ranges, month aliases and the day-or-weekday condition without cron', () => {
  expect(describeCron('0 9 * JAN MON-FRI', 'zh')).toBe('分钟：0 · 小时：9 · 月份：1 · 星期：周一至周五');
  expect(describeCron('0 9 1 * 1', 'en')).toContain('Day：1 or Weekday：Monday');
  expect(describeCron('0 9 31 * *', 'zh')).toContain('日期：31');
});

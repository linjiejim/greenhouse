import { describe, expect, it } from 'vitest';
import { relativeTime } from '../time';

const now = new Date('2026-10-13T08:30:00Z'); // 16:30 in Shanghai
const zh = { locale: 'zh' as const, timeZone: 'Asia/Shanghai', now };
const en = { locale: 'en' as const, timeZone: 'Asia/Shanghai', now };

describe('relative times', () => {
  it('writes recent times as the content rules say', () => {
    expect(relativeTime('2026-10-13T08:29:40Z', zh)).toBe('刚刚');
    expect(relativeTime('2026-10-13T08:18:00Z', zh)).toBe('12 分钟前');
    expect(relativeTime('2026-10-13T06:20:00Z', zh)).toBe('14:20');
    expect(relativeTime('2026-10-12T06:20:00Z', zh)).toBe('昨天 14:20');
    expect(relativeTime('2026-10-03T06:20:00Z', zh)).toBe('10 月 3 日');
    expect(relativeTime('2025-10-03T06:20:00Z', zh)).toBe('2025 年 10 月 3 日');
  });

  it('uses the member time zone for the day boundary', () => {
    // 23:50 on the 12th in Shanghai is "yesterday" there, though it is the 12th 15:50 UTC.
    expect(relativeTime('2026-10-12T15:50:00Z', zh)).toBe('昨天 23:50');
    expect(relativeTime('2026-10-12T16:10:00Z', zh)).toBe('00:10');
  });

  it('has the English equivalents', () => {
    expect(relativeTime('2026-10-13T08:29:40Z', en)).toBe('just now');
    expect(relativeTime('2026-10-13T08:18:00Z', en)).toBe('12 min ago');
    expect(relativeTime('2026-10-12T06:20:00Z', en)).toBe('Yesterday 14:20');
    expect(relativeTime('2026-10-03T06:20:00Z', en)).toBe('Oct 3');
    expect(relativeTime('2025-10-03T06:20:00Z', en)).toBe('Oct 3, 2025');
  });
});

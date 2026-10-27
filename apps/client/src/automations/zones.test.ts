import { describe, expect, it } from 'vitest';
import { runLabel, timeZoneIds, zoneLabel, zoneOffset } from './zones';

const AT = Date.UTC(2026, 9, 28, 1, 0);

describe('zones', () => {
  it('lists UTC first and always includes the stored and device zones', () => {
    const ids = timeZoneIds('Asia/Taipei', 'Etc/GMT-3');
    expect(ids[0]).toBe('UTC');
    expect(ids).toContain('Asia/Taipei');
    expect(ids).toContain('Etc/GMT-3');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names a zone with its offset', () => {
    expect(zoneOffset('Asia/Taipei', AT)).toBe('GMT+8');
    expect(zoneLabel('Asia/Taipei', AT)).toBe('Asia/Taipei · GMT+8');
    expect(zoneLabel('Nowhere/Land', AT)).toBe('Nowhere/Land');
  });

  it('reads a fire time on the automation’s own clock', () => {
    expect(runLabel(AT, 'Asia/Taipei', 'en-US')).toBe('Wed, Oct 28, 09:00');
    expect(runLabel(AT, 'Asia/Taipei', 'zh-CN')).toMatch(/10月28日.*09:00/);
  });
});

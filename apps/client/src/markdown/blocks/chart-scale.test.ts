import { describe, expect, it } from 'vitest';
import { formatTick, niceScale } from './chart-scale';

describe('niceScale', () => {
  it('starts at zero and steps in round numbers', () => {
    expect(niceScale([4.3, 7.5, 8.5])).toEqual({ min: 0, max: 10, step: 2.5, ticks: [0, 2.5, 5, 7.5, 10] });
    expect(niceScale([120, 980, 455]).ticks).toEqual([0, 250, 500, 750, 1000]);
  });

  it('reaches below zero for negative values (bars grow down from the baseline)', () => {
    const scale = niceScale([-30, 45, 10]);
    expect(scale.min).toBeLessThanOrEqual(-30);
    expect(scale.max).toBeGreaterThanOrEqual(45);
    expect(scale.ticks).toContain(0);
  });

  it('survives a flat or empty series and float noise', () => {
    expect(niceScale([]).ticks).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(niceScale([0, 0]).max).toBe(1);
    expect(niceScale([0.1, 0.2, 0.3]).ticks.every((t) => String(t).length < 6)).toBe(true);
  });
});

describe('formatTick', () => {
  it('keeps axis labels short', () => {
    expect(formatTick(0)).toBe('0');
    expect(formatTick(2.5)).toBe('2.5');
    expect(formatTick(12500)).toBe('12.5k');
    expect(formatTick(3_400_000)).toBe('3.4M');
    expect(formatTick(-40)).toBe('-40');
  });
});

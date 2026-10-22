import { describe, expect, it } from 'vitest';
import { computeGanttRange } from './gantt-utils';

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('computeGanttRange focus', () => {
  it('opens on today while today falls inside the work', () => {
    const today = day('2026-06-15');
    const range = computeGanttRange([day('2026-06-01'), day('2026-07-31')], today);
    expect(range.focusDate).toBe(today);
  });

  it('opens on the first dated work when the work is over', () => {
    const range = computeGanttRange([day('2026-07-31'), day('2026-06-01')], day('2026-10-23'));
    expect(range.focusDate.toISOString().slice(0, 10)).toBe('2026-06-01');
    expect(range.endDate.getTime()).toBeGreaterThan(day('2026-10-23').getTime());
  });

  it('opens on the first dated work when the work has not started', () => {
    const range = computeGanttRange([day('2027-01-10')], day('2026-10-23'));
    expect(range.focusDate.toISOString().slice(0, 10)).toBe('2027-01-10');
  });

  it('opens on today when nothing is dated', () => {
    const today = day('2026-10-23');
    expect(computeGanttRange([], today).focusDate).toBe(today);
  });
});

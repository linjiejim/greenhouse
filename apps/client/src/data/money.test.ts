import { describe, expect, it } from 'vitest';
import { budgetLeft, budgetShare, formatUsd } from './money';

describe('money', () => {
  it('formats micros like the web', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1_234_560_000)).toBe('$1,234.56');
    expect(formatUsd(1_500)).toBe('$0.0015');
    expect(formatUsd(Number.NaN)).toBe('$0.00');
  });

  it('counts what is left of a budget', () => {
    expect(budgetLeft({ limit_usd_micros: 10_000_000, spent_usd_micros: 3_000_000, reserved_usd_micros: 1_000_000 })).toBe(6_000_000);
    expect(budgetLeft({ limit_usd_micros: 1, spent_usd_micros: 5, reserved_usd_micros: 0 })).toBe(0);
    expect(budgetShare({ limit_usd_micros: 0, spent_usd_micros: 1 })).toBe(1);
    expect(budgetShare({ limit_usd_micros: 4, spent_usd_micros: 1 })).toBe(0.25);
  });
});

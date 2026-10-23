import { describe, expect, it } from 'vitest';
import { formatUsd, formatUsdPrice, parseUsdInput, usedFraction } from './format';

describe('metering formatting', () => {
  it('formats micros as dollars without rounding small spend to zero', () => {
    expect(formatUsd(12_345_678)).toBe('$12.35');
    expect(formatUsd(4_200)).toBe('$0.0042');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(2_000_000_000)).toBe('$2,000.00');
  });

  it('prints config prices as written', () => {
    expect(formatUsdPrice(0.008)).toBe('$0.008');
    expect(formatUsdPrice(0.28)).toBe('$0.28');
  });

  it('parses an admin amount into micros, refusing anything else', () => {
    expect(parseUsdInput('50')).toBe(50_000_000);
    expect(parseUsdInput('$12.5')).toBe(12_500_000);
    expect(parseUsdInput('0')).toBe(0);
    expect(parseUsdInput('-1')).toBeNull();
    expect(parseUsdInput('1e3')).toBeNull();
    expect(parseUsdInput('')).toBeNull();
  });

  it('reads a zero limit with spend as used up', () => {
    expect(usedFraction(50, 100)).toBe(0.5);
    expect(usedFraction(0, 0)).toBe(0);
    expect(usedFraction(1, 0)).toBe(1);
  });
});

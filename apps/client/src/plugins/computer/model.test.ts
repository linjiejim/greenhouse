import { describe, expect, it } from 'vitest';
import { canStart, canStop, computerCosts, computerState, formatUsd, startRefusal, type MyComputerReport } from './model';

const report = (over: Partial<MyComputerReport> = {}): MyComputerReport => ({
  enabled: true,
  configured: true,
  price_per_minute_usd: 0.0021,
  idle_minutes: 15,
  computer: null,
  minutes_this_month: 42,
  period: { start: '2026-10-01T00:00:00.000Z', end: '2026-11-01T00:00:00.000Z' },
  ...over,
});
const computer = (status: NonNullable<MyComputerReport['computer']>['status']) => ({
  id: 'mc_1',
  status,
  started_at: '2026-10-29T08:00:00.000Z',
  last_used_at: '2026-10-29T08:10:00.000Z',
  stopped_at: null,
  stop_reason: null,
  minutes_billed: 10,
  client: 'mcp',
});

describe('computerState', () => {
  it('reads the switch, then the key, then the computer', () => {
    expect(computerState(report({ enabled: false }))).toBe('off');
    expect(computerState(report({ enabled: false, configured: false }))).toBe('off');
    expect(computerState(report({ configured: false }))).toBe('unconfigured');
    expect(computerState(report())).toBe('stopped');
    expect(computerState(report({ computer: computer('running') }))).toBe('running');
    expect(computerState(report({ computer: computer('starting') }))).toBe('starting');
  });
  it('shows a computer still running after the switch went off, and ignores finished ones', () => {
    expect(computerState(report({ enabled: false, computer: computer('running') }))).toBe('running');
    expect(computerState(report({ computer: computer('failed') }))).toBe('stopped');
  });
  it('starts only a stopped computer and stops only a running one', () => {
    expect(canStart('stopped')).toBe(true);
    expect(canStart('off')).toBe(false);
    expect(canStart('running')).toBe(false);
    expect(canStop('running')).toBe(true);
    expect(canStop('starting')).toBe(false);
  });
});

describe('money', () => {
  it('keeps a per-minute price from rounding to zero', () => {
    expect(formatUsd(0.0021, 'en-US', true)).toBe('$0.0021');
    expect(formatUsd(0.000028, 'en-US', true)).toBe('$0.000028');
    expect(formatUsd(0.15, 'en-US', true)).toBe('$0.15');
    expect(formatUsd(0.05, 'en-US', true)).toBe('$0.05');
    expect(formatUsd(0.088, 'en-US')).toBe('$0.09');
    expect(formatUsd(0.0042, 'en-US')).toBe('$0.0042');
    expect(formatUsd(12, 'en-US')).toBe('$12.00');
    expect(formatUsd(0, 'en-US')).toBe('$0.00');
  });
  it('names the currency in the app language', () => {
    expect(formatUsd(0.0021, 'zh-CN', true)).toBe('US$0.0021');
  });
  it('prices a minute, an hour and this month, or nothing when unpriced', () => {
    expect(computerCosts(report(), 'en-US')).toEqual({ perMinute: '$0.0021', perHour: '$0.13', thisMonth: '$0.09' });
    expect(computerCosts(report({ price_per_minute_usd: null }), 'en-US')).toBeNull();
  });
});

it('turns start refusals into the screen words', () => {
  expect(startRefusal('disabled')).toBe('off');
  expect(startRefusal('not_configured')).toBe('unconfigured');
  expect(startRefusal('full')).toBe('full');
  expect(startRefusal('busy')).toBe('busy');
  expect(startRefusal('usage_budget_exceeded')).toBe('budget');
  expect(startRefusal('unavailable')).toBeNull();
});

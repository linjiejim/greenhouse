import { afterEach, expect, it, vi } from 'vitest';
import { createTimerScope } from '../timers.js';

afterEach(() => vi.useRealTimers());

it('disposes pending merge, wake, heartbeat and deadline callbacks before teardown', () => {
  vi.useFakeTimers();
  const timers = createTimerScope();
  const callback = vi.fn();
  timers.timeout(callback, 40);
  timers.timeout(callback, 120_000);
  timers.interval(callback, 10_000);
  timers.dispose();
  // A suspended turn may resume after shutdown; it cannot start another timer.
  timers.timeout(callback, 40);
  timers.interval(callback, 10_000);
  vi.advanceTimersByTime(1_000_000);
  expect(callback).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('unrefs timers and removes callbacks that fire or are explicitly cleared', () => {
  const timers = createTimerScope();
  const timeout = timers.timeout(() => {}, 1000);
  const interval = timers.interval(() => {}, 1000);
  expect(timeout.hasRef()).toBe(false);
  expect(interval.hasRef()).toBe(false);
  timers.clear(timeout);
  timers.clear(interval);
  timers.dispose();
});

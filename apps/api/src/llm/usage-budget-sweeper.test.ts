import { afterEach, describe, expect, it, vi } from 'vitest';
import { startUsageBudgetSweeper } from './usage-budget-sweeper.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('usage budget stale-reservation sweeper', () => {
  it('runs on boot, repeats on an unref interval, and stops cleanly', async () => {
    vi.useFakeTimers();
    const expireStaleReservations = vi.fn().mockResolvedValue(0);
    const handle = await startUsageBudgetSweeper({ usageBudget: { expireStaleReservations } } as never, {
      intervalMs: 1_000,
    });

    expect(expireStaleReservations).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(expireStaleReservations).toHaveBeenCalledTimes(2);

    handle.stop();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(expireStaleReservations).toHaveBeenCalledTimes(2);
  });

  it('collapses overlapping ticks and retries after the in-flight pass ends', async () => {
    vi.useFakeTimers();
    let finishSecond!: (value: number) => void;
    const expireStaleReservations = vi
      .fn()
      .mockResolvedValueOnce(0)
      .mockImplementationOnce(() => new Promise<number>((resolve) => (finishSecond = resolve)))
      .mockResolvedValue(0);
    const handle = await startUsageBudgetSweeper({ usageBudget: { expireStaleReservations } } as never, {
      intervalMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(expireStaleReservations).toHaveBeenCalledTimes(2);
    finishSecond(0);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(expireStaleReservations).toHaveBeenCalledTimes(3);
    handle.stop();
  });

  it('contains a boot failure so a later interval can reconcile', async () => {
    vi.useFakeTimers();
    const expireStaleReservations = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(1);
    const handle = await startUsageBudgetSweeper({ usageBudget: { expireStaleReservations } } as never, {
      intervalMs: 1_000,
      batchSize: 10,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(expireStaleReservations).toHaveBeenCalledTimes(2);
    handle.stop();
  });
});

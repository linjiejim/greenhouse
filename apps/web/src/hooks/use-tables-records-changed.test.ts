/**
 * The realtime refetch coalescer: a burst of `tables:records_changed` events
 * (an import commits ~20 chunks) costs one refetch per quiet period or per
 * `maxWaitMs`, refetches never overlap, and what arrives during one runs once
 * more after it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRefetchCoalescer, matchesRecordsChanged } from './use-tables-records-changed';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createRefetchCoalescer', () => {
  it('runs once after the burst goes quiet', async () => {
    const run = vi.fn();
    const coalescer = createRefetchCoalescer<number>(run, { delayMs: 1000, maxWaitMs: 3000 });
    for (let event = 0; event < 5; event += 1) {
      coalescer.push(event);
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith([0, 1, 2, 3, 4]);
  });

  it('runs at most every maxWaitMs during a long burst', async () => {
    const run = vi.fn();
    const coalescer = createRefetchCoalescer<number>(run, { delayMs: 1000, maxWaitMs: 3000 });
    // An import: an event every 250 ms for 9 s.
    for (let event = 0; event < 36; event += 1) {
      coalescer.push(event);
      await vi.advanceTimersByTimeAsync(250);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.mock.calls.length).toBeLessThanOrEqual(4);
    expect(run.mock.calls.flatMap(([events]) => events)).toHaveLength(36);
  });

  it('never overlaps runs and runs once more for what arrived meanwhile', async () => {
    let finish: () => void = () => undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const coalescer = createRefetchCoalescer<number>(run, { delayMs: 100, maxWaitMs: 300 });
    coalescer.push(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(1);

    // The refetch is slow; more events come and their timers fire meanwhile.
    for (let event = 2; event <= 6; event += 1) {
      coalescer.push(event);
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(run).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run).toHaveBeenLastCalledWith([2, 3, 4, 5, 6]);
    finish();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failed run and stops when disposed', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const coalescer = createRefetchCoalescer<number>(run, { delayMs: 100, maxWaitMs: 300 });
    coalescer.push(1);
    await vi.advanceTimersByTimeAsync(100);
    coalescer.push(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    coalescer.push(3);
    coalescer.dispose();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('matchesRecordsChanged', () => {
  it('filters by base, table and record', () => {
    const event = { type: 'tables:records_changed' as const, baseId: 3, tableId: 7, recordIds: [5] };
    expect(matchesRecordsChanged(event, { tableId: 7 })).toBe(true);
    expect(matchesRecordsChanged(event, { tableId: 8 })).toBe(false);
    expect(matchesRecordsChanged(event, { baseId: 3, recordIds: [4] })).toBe(false);
  });
});

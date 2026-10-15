import { expect, it, vi } from 'vitest';
import { createTestServices } from '../../../testing.js';

it('keeps the worker alive after a failed watch sweep and checks again on the next tick', async () => {
  vi.useFakeTimers();
  const services = createTestServices();
  const watches = vi
    .spyOn(services.computers, 'checkWatches')
    .mockRejectedValueOnce(new Error('Database unavailable'))
    .mockResolvedValue(undefined);
  const idle = vi.spyOn(services.computers, 'stopIdle').mockResolvedValue(undefined);
  try {
    services.computers.startWatching(async () => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watches).toHaveBeenCalledTimes(1);
    expect(idle).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watches).toHaveBeenCalledTimes(2);
    expect(idle).toHaveBeenCalledTimes(1);
  } finally {
    services.computers.stopWatching();
    vi.restoreAllMocks();
    vi.useRealTimers();
  }
});

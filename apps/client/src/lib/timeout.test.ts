import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { withTimeout } from './timeout';

describe('waiting a limited time', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('gives the value when it comes in time', async () => {
    await expect(withTimeout(Promise.resolve('names'), 1000)).resolves.toBe('names');
  });

  it('gives null when it does not', async () => {
    const late = withTimeout(new Promise<string>(() => {}), 1000);
    vi.advanceTimersByTime(1000);
    await expect(late).resolves.toBeNull();
  });

  it('passes a failure on', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });
});

import { logger } from '@greenhouse/utils/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerExtensionHooks, emitExtensionEvent } from '../events.js';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
describe('observational plugin events', () => {
  it('defers subscribers, isolates errors and caps each observation at five seconds', async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const observed: unknown[] = [];
    registerExtensionHooks('broken', (hooks) =>
      hooks.on('user.created', () => {
        throw new Error('broken');
      }),
    );
    registerExtensionHooks('slow', (hooks) => hooks.on('user.created', () => new Promise(() => {})));
    registerExtensionHooks('healthy', (hooks) =>
      hooks.on('user.created', (payload) => {
        observed.push(payload);
      }),
    );
    emitExtensionEvent('user.created', { userId: 'committed-user' });
    expect(observed).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toEqual([{ userId: 'committed-user' }]);
    await vi.advanceTimersByTimeAsync(4999);
    expect(warning.mock.calls.some((call) => JSON.stringify(call).includes('timed out'))).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(warning.mock.calls.some((call) => JSON.stringify(call).includes('timed out after 5000 ms'))).toBe(true);
    emitExtensionEvent('user.created', { userId: 'next-user' });
    await vi.advanceTimersByTimeAsync(0);
    expect(observed).toContainEqual({ userId: 'next-user' });
    await vi.advanceTimersByTimeAsync(5000);
  });
  it('rejects events outside the approved observational set', () => {
    expect(() => registerExtensionHooks('bad', (hooks) => hooks.on('before.write' as never, () => {}))).toThrow(
      /Unsupported/,
    );
  });
});

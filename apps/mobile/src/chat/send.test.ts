/**
 * `sendMessage` (./send.ts): a station that does not start answering within the connection
 * deadline gets its request cancelled — not left running to land after the message was queued —
 * and the send says nothing came back (status 0, delivery unknown). The API client is mocked.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const seen: { signal?: AbortSignal | null } = {};
vi.mock('expo/fetch', () => ({ fetch: vi.fn() }));
vi.mock('../api/client', () => ({
  seg: (id: string) => encodeURIComponent(id),
  toResult: async () => ({ ok: false, status: 500, code: 'internal', message: '' }),
  api: (_path: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      seen.signal = init.signal;
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }),
}));

const { sendMessage } = await import('./send');
const { CONNECTION_TIMEOUT_MS } = await import('../api/connection-deadline');

afterEach(() => {
  vi.useRealTimers();
});

describe('sending a message', () => {
  it('cancels the request when the station does not answer in time', async () => {
    vi.useFakeTimers();
    const sending = sendMessage('ses_1', 'Hello', () => {});
    await vi.advanceTimersByTimeAsync(CONNECTION_TIMEOUT_MS + 1);
    expect(await sending).toMatchObject({ ok: false, status: 0 });
    expect(seen.signal?.aborted).toBe(true);
  });

  it('cancels the request when the caller does', async () => {
    const outer = new AbortController();
    const sending = sendMessage('ses_1', 'Hello', () => {}, outer.signal);
    outer.abort();
    expect(await sending).toMatchObject({ ok: false, status: 0 });
    expect(seen.signal?.aborted).toBe(true);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { EXPO_PUSH_SEND_URL } from './config.js';
import { EXPO_CHUNK_SIZE, sendExpoPush, type ExpoMessage, type FetchLike } from './expo.js';

const msg = (to: string): ExpoMessage => ({ to, title: 'Sprouty', body: '回复了你', data: { v: 1 } });

function reply(status: number, body: unknown): Awaited<ReturnType<FetchLike>> {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('sendExpoPush', () => {
  it('sends one project per request in chunks of at most 100, and maps tickets back in input order', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (_url, init) => {
      const sent = JSON.parse(init.body) as ExpoMessage[];
      return reply(200, { data: sent.map((m) => ({ status: 'ok', id: `ticket-${m.to}` })) });
    });
    const items = [
      ...Array.from({ length: EXPO_CHUNK_SIZE + 5 }, (_, i) => ({ projectId: 'project-a', message: msg(`a${i}`) })),
      { projectId: 'project-b', message: msg('b0') },
    ];
    const outcomes = await sendExpoPush(items, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const sizes = fetchImpl.mock.calls
      .map(([, init]) => (JSON.parse(init.body) as ExpoMessage[]).length)
      .sort((a, b) => a - b);
    expect(sizes).toEqual([1, 5, EXPO_CHUNK_SIZE]);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe(EXPO_PUSH_SEND_URL);
      // no access token: enhanced push security stays off
      expect(init.headers).not.toHaveProperty('authorization');
      const projects = new Set((JSON.parse(init.body) as ExpoMessage[]).map((m) => m.to[0]));
      expect(projects.size).toBe(1);
    }
    expect(outcomes[0]).toEqual({ status: 'ok', id: 'ticket-a0' });
    expect(outcomes[EXPO_CHUNK_SIZE + 2]).toEqual({ status: 'ok', id: `ticket-a${EXPO_CHUNK_SIZE + 2}` });
    expect(outcomes.at(-1)).toEqual({ status: 'ok', id: 'ticket-b0' });
  });

  it('reports a refused message with its code', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () =>
      reply(200, {
        data: [
          { status: 'ok', id: 't1' },
          { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } },
        ],
      }),
    );
    expect(
      await sendExpoPush(
        [
          { projectId: 'p', message: msg('x') },
          { projectId: 'p', message: msg('y') },
        ],
        fetchImpl,
      ),
    ).toEqual([
      { status: 'ok', id: 't1' },
      { status: 'error', code: 'DeviceNotRegistered', message: 'not registered' },
    ]);
  });

  it('retries what may pass later and gives up on what will not', async () => {
    const one = [{ projectId: 'p', message: msg('x') }];
    const status = async (fetchImpl: FetchLike) => (await sendExpoPush(one, fetchImpl))[0]!.status;

    expect(
      await status(async () => reply(429, { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'slow down' }] })),
    ).toBe('retry');
    expect(await status(async () => reply(503, null))).toBe('retry');
    expect(
      await status(async () => {
        throw new Error('ECONNRESET');
      }),
    ).toBe('retry');
    // a ticket missing from the reply is not a delivery
    expect(await status(async () => reply(200, { data: [] }))).toBe('retry');
    expect(await status(async () => reply(401, { errors: [{ code: 'UNAUTHORIZED', message: 'push security' }] }))).toBe(
      'fatal',
    );
    expect(await status(async () => reply(400, { errors: [{ code: 'VALIDATION_ERROR', message: 'bad' }] }))).toBe(
      'fatal',
    );
  });
});

import { describe, expect, it } from 'vitest';
import { afterAttempt, deliveryOf, dequeue, enqueue, heldByStation, MAX_QUEUED, nextToSend, parseOutbox, type QueuedTurn } from './outbox';

const turn = (id: string, sessionId: string | null, createdAt: number): QueuedTurn => ({ id, sessionId, text: id, images: [], createdAt });

describe('the outbox', () => {
  it('keeps what it can read', () => {
    expect(parseOutbox([turn('a', 's', 1), { id: 1 }, null, { id: 'b', text: 'x', createdAt: 2, images: [{ id: 'i' }] }])).toEqual([
      turn('a', 's', 1),
      { id: 'b', sessionId: null, text: 'x', images: [], createdAt: 2 },
    ]);
    expect(parseOutbox('x')).toEqual([]);
  });

  it('refuses a message when full instead of dropping the oldest', () => {
    let list: QueuedTurn[] = [];
    for (let i = 0; i < MAX_QUEUED; i += 1) list = enqueue(list, turn(`t${i}`, 's', i))!;
    expect(list).toHaveLength(MAX_QUEUED);
    expect(enqueue(list, turn('late', 's', 99))).toBeNull();
    expect(list[0]!.id).toBe('t0');
    expect(dequeue(list, 't0')[0]!.id).toBe('t1');
    expect(enqueue(dequeue(list, 't0'), turn('late', 's', 99))).toHaveLength(MAX_QUEUED);
  });

  it('keeps retryable refusals with a growing wait, and permanent ones as failed', () => {
    expect(deliveryOf({ ok: true })).toBe('sent');
    expect(deliveryOf({ ok: false, status: 0 })).toBe('unknown');
    expect(deliveryOf({ ok: false, status: 409 })).toBe('retry');
    expect(deliveryOf({ ok: false, status: 503 })).toBe('retry');
    expect(deliveryOf({ ok: false, status: 400 })).toBe('rejected');
    const first = afterAttempt(turn('a', 's', 1), 'retry', '', 1000);
    const second = afterAttempt({ ...turn('a', 's', 1), ...first }, 'retry', '', 1000);
    expect(second.attempts).toBe(2);
    expect(second.retryAt! - 1000).toBeGreaterThan(first.retryAt! - 1000);
    expect(afterAttempt(turn('a', 's', 1), 'rejected', 'Too long')).toMatchObject({ status: 'failed', error: 'Too long' });
    expect(afterAttempt(turn('a', 's', 1), 'unknown', '')).toEqual({ status: 'unknown' });
  });

  it('holds a failed or waiting message, and the ones after it in its conversation', () => {
    const list = [{ ...turn('a', 's1', 1), status: 'failed' as const }, turn('b', 's1', 2), { ...turn('c', 's2', 3), retryAt: 50 }, turn('d', 's3', 4)];
    expect(nextToSend(list, new Set(), 10).map((t) => t.id)).toEqual(['d']);
    expect(nextToSend(list, new Set(), 60).map((t) => t.id)).toEqual(['c', 'd']);
    expect(parseOutbox(list)).toEqual(list);
  });

  it('finds a message sent without an answer in the conversation', () => {
    const queued = { ...turn('q', 's', Date.parse('2026-10-25T10:00:00Z')), text: 'Ship it' };
    const page = (content: string, at: string) => ({
      messages: [
        { id: 'm1', role: 'user', content, seq: 1, created_at: at },
        { id: 'm2', role: 'assistant', content: 'ok', seq: 2, created_at: at },
      ],
      has_more: false,
      next_before_seq: null,
    });
    expect(heldByStation(page('Ship it ', '2026-10-25T10:00:03Z'), queued)).toBe(true);
    expect(heldByStation(page('Hold it', '2026-10-25T10:00:03Z'), queued)).toBe(false);
    // the same words sent long before this one was written are another message
    expect(heldByStation(page('Ship it', '2026-10-24T10:00:00Z'), queued)).toBe(false);
  });

  it('sends one message per conversation at a time, oldest first, skipping open ones', () => {
    const list = [turn('b', 's1', 2), turn('a', 's1', 1), turn('n', null, 3), turn('c', 's2', 4)];
    expect(nextToSend(list, new Set()).map((t) => t.id)).toEqual(['a', 'n', 'c']);
    expect(nextToSend(list, new Set(['s1'])).map((t) => t.id)).toEqual(['n', 'c']);
  });
});

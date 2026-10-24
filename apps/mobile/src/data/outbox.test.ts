import { describe, expect, it } from 'vitest';
import { afterAttempt, deliveryOf, dequeue, enqueue, MAX_QUEUED, newTurnId, nextToSend, parseOutbox, type QueuedTurn } from './outbox';

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

  it('counts a turn the station already saved as delivered', () => {
    expect(deliveryOf({ ok: false, status: 409, code: 'duplicate_turn' })).toBe('sent');
    expect(deliveryOf({ ok: false, status: 409, code: 'conflict' })).toBe('retry');
  });

  it('makes turn ids the station accepts as client_turn_id', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newTurnId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });

});

import { describe, expect, it } from 'vitest';
import { dequeue, enqueue, MAX_QUEUED, nextToSend, parseOutbox, type QueuedTurn } from './outbox';

const turn = (id: string, sessionId: string | null, createdAt: number): QueuedTurn => ({ id, sessionId, text: id, images: [], createdAt });

describe('the outbox', () => {
  it('keeps what it can read', () => {
    expect(parseOutbox([turn('a', 's', 1), { id: 1 }, null, { id: 'b', text: 'x', createdAt: 2, images: [{ id: 'i' }] }])).toEqual([
      turn('a', 's', 1),
      { id: 'b', sessionId: null, text: 'x', images: [], createdAt: 2 },
    ]);
    expect(parseOutbox('x')).toEqual([]);
  });

  it('adds and removes, keeping at most MAX_QUEUED', () => {
    let list: QueuedTurn[] = [];
    for (let i = 0; i < MAX_QUEUED + 2; i += 1) list = enqueue(list, turn(`t${i}`, 's', i));
    expect(list).toHaveLength(MAX_QUEUED);
    expect(list[0]!.id).toBe('t2');
    expect(dequeue(list, 't2')[0]!.id).toBe('t3');
  });

  it('sends one message per conversation at a time, oldest first, skipping open ones', () => {
    const list = [turn('b', 's1', 2), turn('a', 's1', 1), turn('n', null, 3), turn('c', 's2', 4)];
    expect(nextToSend(list, new Set()).map((t) => t.id)).toEqual(['a', 'n', 'c']);
    expect(nextToSend(list, new Set(['s1'])).map((t) => t.id)).toEqual(['n', 'c']);
  });
});

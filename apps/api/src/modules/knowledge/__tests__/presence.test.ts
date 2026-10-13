import { describe, expect, it } from 'vitest';
import { createPresence, PRESENCE_TTL_MS } from '../presence.js';

describe('presence', () => {
  it('lists who has a doc open, says when that changed, and forgets the silent', () => {
    let now = 1_000_000;
    const presence = createPresence(() => now);
    expect(presence.beat('doc_1', { id: 'mbr_a', name: 'Ann' }, 'viewing')).toMatchObject({ changed: true });
    now += 10_000;
    // The same state again is only a heartbeat.
    expect(presence.beat('doc_1', { id: 'mbr_a', name: 'Ann' }, 'viewing').changed).toBe(false);
    const editing = presence.beat('doc_1', { id: 'mbr_b', name: 'Bo' }, 'editing');
    expect(editing.changed).toBe(true);
    expect(editing.items.map((item) => [item.member_id, item.state])).toEqual([
      ['mbr_a', 'viewing'],
      ['mbr_b', 'editing'],
    ]);
    expect(presence.watchers('doc_1')).toEqual(['mbr_a', 'mbr_b']);

    // Ann stops beating; Bo's next beat drops her and reports the change.
    now += PRESENCE_TTL_MS + 1;
    const next = presence.beat('doc_1', { id: 'mbr_b', name: 'Bo' }, 'editing');
    expect(next).toMatchObject({ changed: true, items: [expect.objectContaining({ member_id: 'mbr_b' })] });

    expect(presence.leave('doc_1', 'mbr_b')).toEqual({ items: [], changed: true });
    expect(presence.leave('doc_1', 'mbr_b').changed).toBe(false);
    expect(presence.list('doc_2')).toEqual([]);
  });
});

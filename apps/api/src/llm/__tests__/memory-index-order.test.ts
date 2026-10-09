/**
 * The memory index sits in the system prompt, so its bytes are the start of
 * the cached prefix. Recall touches `last_used_at`; when the index was written
 * in recency order, every recall reordered it and the next turn lost the
 * provider's prefix cache for the whole conversation. Selection still follows
 * recency (what fits the budget), the written order does not (spec 20261009 D7).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return {
    ...actual,
    getDb: () => ({ userMemories: { listForIndex: vi.fn(async () => state.rows) } }),
  };
});

import { buildMemoryIndexBlock } from '../memory.js';

function row(id: number, title: string, pinned = false) {
  return {
    id,
    user_id: 'u1',
    category: 'fact',
    title,
    content: 'c',
    pinned,
    status: 'active',
    source: 'agent',
    bot_id: null,
    last_used_at: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    superseded_by: null,
  };
}

const a = row(1, 'Alpha');
const b = row(2, 'Bravo');
const c = row(3, 'Charlie');
const p = row(9, 'Pinned rule', true);

beforeEach(() => {
  state.rows = [];
});

describe('memory index order', () => {
  it('is the same bytes whichever memory was used last', async () => {
    state.rows = [p, c, a, b]; // pinned, then most recently used
    const before = await buildMemoryIndexBlock('u1');
    state.rows = [p, b, c, a]; // a recall just touched Bravo
    const after = await buildMemoryIndexBlock('u1');
    expect(after).toBe(before);
  });

  it('writes pinned first, then by id', async () => {
    state.rows = [p, c, a, b];
    const block = (await buildMemoryIndexBlock('u1'))!;
    const order = ['Pinned rule', 'Alpha', 'Bravo', 'Charlie'].map((t) => block.indexOf(t));
    expect([...order].sort((x, y) => x - y)).toEqual(order);
  });
});

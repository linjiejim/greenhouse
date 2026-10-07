/**
 * Rolling digest (design review R6): cuts only at chain boundaries keeping the
 * last two chains, strict JSON validation, bounded rendering, failure keeps
 * the old digest and backs off.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { estimateTokens } from '@greenhouse/agent-core';
import type { ProjectionRow } from '../projection.js';
import {
  _resetDigestStateForTest,
  chooseChunkCut,
  chooseDigestCut,
  compactConversation,
  DIGEST_CHUNK_TOKENS,
  DIGEST_RENDER_MAX_CHARS,
  emptyDigest,
  parseDigestAnswer,
  renderDigest,
  scheduleDigestCheck,
} from '../digest.js';
import { setBotsEngineDepsForTest } from '../deps.js';

let seq = 0;
function rows(spec: Array<['user' | 'assistant' | 'system', number]>): ProjectionRow[] {
  return spec.map(([role, chars]) => {
    seq += 1;
    return {
      id: `m${seq}`,
      seq,
      role,
      content: 'x'.repeat(chars),
      bot_id: role === 'assistant' ? 'bot_a' : null,
      bot_event: null,
    };
  });
}

describe('chooseDigestCut', () => {
  it('folds nothing when there are two chains or fewer', () => {
    seq = 0;
    expect(
      chooseDigestCut(
        rows([
          ['user', 10],
          ['assistant', 10],
          ['user', 10],
          ['assistant', 10],
        ]),
      ),
    ).toBeNull();
  });

  it('cuts right before a member message and keeps at least the last two chains', () => {
    seq = 0;
    // Chain sizes ≈ 20k tokens each: only the last two can be kept, even over 8k.
    const tail = rows([
      ['user', 4000],
      ['assistant', 76000],
      ['user', 4000],
      ['assistant', 76000],
      ['system', 100], // a hand-off line stays with its chain
      ['user', 4000],
      ['assistant', 76000],
    ]);
    const cut = chooseDigestCut(tail)!;
    expect(cut.boundary.seq).toBe(2);
    expect(cut.summarize.map((r) => r.seq)).toEqual([1, 2]);
  });

  it('keeps as many small chains as fit in the raw budget', () => {
    seq = 0;
    const tail = rows([
      ['user', 40],
      ['assistant', 40000], // ≈10k — folded
      ['user', 40],
      ['assistant', 400],
      ['user', 40],
      ['assistant', 400],
      ['user', 40],
      ['assistant', 400],
    ]);
    const cut = chooseDigestCut(tail)!;
    expect(cut.boundary.seq).toBe(2);
  });
});

describe('digest JSON', () => {
  it('accepts a fenced answer and rejects anything that does not validate', () => {
    const good = parseDigestAnswer(
      '```json\n{"goals":["ship v1"],"decisions":[],"facts":[{"text":"price is 3","seq":4}],"open_items":[],"artifacts":[]}\n```',
    );
    expect(good?.goals).toEqual(['ship v1']);
    expect(good?.facts[0]).toEqual({ text: 'price is 3', seq: 4 });
    expect(parseDigestAnswer('Sure! Here is a summary of the chat.')).toBeNull();
    expect(parseDigestAnswer('{"goals": "not an array"}')).toBeNull();
    expect(parseDigestAnswer(`{"goals": [${Array.from({ length: 50 }, () => '"g"').join(',')}]}`)).toBeNull();
  });

  it('renders within 1500 chars, dropping closed items and the oldest facts first', () => {
    const doc = {
      ...emptyDigest(),
      goals: ['Plan the launch'],
      open_items: [
        { text: 'done thing', done: true },
        { text: 'still open', owner_bot_id: 'bot_a' },
      ],
      facts: Array.from({ length: 30 }, (_, i) => ({ text: `fact ${i} ${'f'.repeat(80)}` })),
    };
    const text = renderDigest(doc, 'en', new Map([['bot_a', 'Sage']]));
    expect(text.length).toBeLessThanOrEqual(DIGEST_RENDER_MAX_CHARS);
    expect(text).toContain('still open — Sage');
    expect(text).not.toContain('done thing');
    expect(text).toContain('fact 29');
    expect(text).not.toContain('fact 0 ');
  });
});

describe('compaction failures', () => {
  afterEach(() => {
    _resetDigestStateForTest();
  });

  function fakeDb(setDigest: ReturnType<typeof vi.fn>): DatabaseProvider {
    seq = 0;
    const tail = rows([
      ['user', 4000],
      ['assistant', 40000],
      ['user', 4000],
      ['assistant', 40000],
      ['user', 4000],
      ['assistant', 40000],
    ]).map((r) => ({ ...r, session_id: 's1', created_at: '2026-10-05T00:00:00Z', bot_event: null }));
    return {
      sessions: {
        getById: async () => ({ id: 's1', user_id: 'u1', channel: 'bots' }),
        getMessagePage: async () => ({ messages: tail, has_more: false, next_before_seq: null }),
      },
      users: { getById: async () => ({ id: 'u1', nickname: 'Jim', locale: 'en', status: 'active' }) },
      bots: {
        getConversation: async () => ({ session_id: 's1', digest: '', digest_upto_seq: 0, digest_updated_at: null }),
        listBots: async () => [],
        setDigest,
      },
    } as unknown as DatabaseProvider;
  }

  it('keeps the old digest when the model answers with something invalid, and backs off', async () => {
    const setDigest = vi.fn();
    const summarize = vi.fn(async () => 'I cannot do that');
    const restore = setBotsEngineDepsForTest({
      summarize,
      resolveProfile: async () => ({ model: { id: 'mock' } }) as never,
    });
    try {
      const outcome = await compactConversation('s1', { db: fakeDb(setDigest) });
      expect(outcome.status).toBe('failed');
      expect(setDigest).not.toHaveBeenCalled();
      // Backoff: the post-chain check does not retry immediately.
      scheduleDigestCheck('s1', async () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(summarize).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  it('writes a valid digest with compare-and-set on the old boundary and draws the divider', async () => {
    const setDigest = vi.fn(async () => true);
    const restore = setBotsEngineDepsForTest({
      summarize: async () => '{"goals":["g"],"decisions":[],"facts":[],"open_items":[],"artifacts":[]}',
      resolveProfile: async () => ({ model: { id: 'mock' } }) as never,
    });
    const divider = vi.fn(async () => undefined);
    try {
      const outcome = await compactConversation('s1', { db: fakeDb(setDigest), onDivider: divider });
      expect(outcome.status).toBe('compacted');
      expect(setDigest).toHaveBeenCalledWith('s1', 0, expect.objectContaining({ upto_seq: 2, upto_message_id: 'm2' }));
      expect(divider).toHaveBeenCalledWith(2, 'en');
      expect(outcome.digest?.text).toContain('Goals:');
    } finally {
      restore();
    }
  });
});

describe('oversized backlog', () => {
  afterEach(() => {
    _resetDigestStateForTest();
  });

  /** A session store that honours getMessagePage's cursor, like the real one. */
  function backlogDb(total: number, boundary: number) {
    const messages = Array.from({ length: total }, (_, i) => ({
      id: `m${i}`,
      session_id: 's1',
      seq: i,
      // A chain every 6 rows: member message, then Bot rows (CJK-ish bulk to weigh ~500 tokens each).
      role: i % 6 === 0 ? 'user' : 'assistant',
      content: i % 6 === 0 ? `question ${i}` : `${'答'.repeat(400)} ${i}`,
      bot_id: i % 6 === 0 ? null : 'bot_a',
      bot_event: null,
      images: '[]',
      created_at: '2026-10-05T00:00:00Z',
    }));
    const state = { upto: boundary, digest: '{"goals":[],"decisions":[],"facts":[],"open_items":[],"artifacts":[]}' };
    const db = {
      sessions: {
        getById: async () => ({ id: 's1', user_id: 'u1', channel: 'bots' }),
        getLatestMessage: async () => messages.at(-1),
        getMessagePage: async (_id: string, opts: { limit?: number; beforeSeq?: number }) => {
          const limit = opts.limit ?? 50;
          const below = messages.filter((m) => opts.beforeSeq === undefined || m.seq < opts.beforeSeq);
          const page = below.slice(-limit);
          const hasMore = below.length > limit;
          return { messages: page, has_more: hasMore, next_before_seq: hasMore ? page[0]!.seq : null };
        },
      },
      users: { getById: async () => ({ id: 'u1', nickname: 'Jim', locale: 'en', status: 'active' }) },
      bots: {
        getConversation: async () => ({
          session_id: 's1',
          digest: state.digest,
          digest_upto_seq: state.upto,
          digest_updated_at: null,
        }),
        listBots: async () => [],
        setDigest: vi.fn(async (_id: string, expected: number, next: { upto_seq: number; text: string }) => {
          if (expected !== state.upto) return false;
          state.upto = next.upto_seq;
          state.digest = next.text;
          return true;
        }),
      },
    };
    return { db: db as unknown as DatabaseProvider, state };
  }

  it('folds forward from the old boundary in bounded chunks: no message is skipped, no prompt is oversized', async () => {
    const boundary = 99;
    const { db, state } = backlogDb(1600, boundary);
    const prompts: string[] = [];
    const restore = setBotsEngineDepsForTest({
      summarize: async ({ prompt }) => {
        prompts.push(prompt);
        return '{"goals":["g"],"decisions":[],"facts":[],"open_items":[],"artifacts":[]}';
      },
      resolveProfile: async () => ({ model: { id: 'mock' } }) as never,
    });
    try {
      // Several jobs (each folds a few chunks, then yields) until the tail is back under the trigger.
      for (let job = 0; job < 20; job += 1) {
        const outcome = await compactConversation('s1', { db });
        if (outcome.status === 'nothing') break;
        expect(outcome.status).toBe('compacted');
      }
    } finally {
      restore();
    }
    expect(prompts.length).toBeGreaterThan(1);
    const folded = new Set<number>();
    for (const prompt of prompts) {
      const body = prompt.split('<new_messages>\n')[1]!.split('\n</new_messages>')[0]!;
      expect(estimateTokens(body)).toBeLessThanOrEqual(DIGEST_CHUNK_TOKENS * 1.2);
      for (const match of body.matchAll(/^#(\d+) /gm)) folded.add(Number(match[1]));
    }
    // Every seq from just after the old boundary to the final boundary was summarized, in order.
    for (let seqNo = boundary + 1; seqNo <= state.upto; seqNo += 1) expect(folded.has(seqNo)).toBe(true);
    expect(state.upto).toBeGreaterThan(1400);
  });

  it('a chunk cuts at its last chain boundary, never right after a hand-off line', () => {
    seq = 0;
    const chunk = rows([
      ['user', 10],
      ['assistant', 10],
      ['user', 10],
      ['assistant', 10],
    ]);
    expect(chooseChunkCut(chunk)!.boundary.seq).toBe(2);
    seq = 0;
    const oneChain = rows([
      ['user', 10],
      ['assistant', 10],
      ['system', 10],
    ]);
    oneChain[2]!.bot_event = { kind: 'ask', from: 'bot_a', to: 'bot_b' };
    expect(chooseChunkCut(oneChain)!.boundary.seq).toBe(2);
  });
});

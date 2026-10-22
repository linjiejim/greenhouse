/**
 * Rolling digest — fold trigger, fold planning, the digest call and the
 * compare-and-set hand-off. The SQL side of the CAS (forward-only, boundary
 * check, reset on edit) is pinned against a real database in
 * tests/db/session-digest.db.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider, SequencedChatMessage } from '@greenhouse/db';

vi.mock('../llm/complete.js', () => ({
  complete: vi.fn(async () => {
    throw new Error('the real completion path must not run in unit tests');
  }),
}));

import {
  DIGEST_MAX_CHARS,
  DIGEST_MAX_FOLD_TOKENS,
  buildDigestRequest,
  cleanDigest,
  foldSessionDigest,
  formatDigestSection,
  planDigestFold,
  scheduleDigestFold,
  type DigestCompletion,
} from './digest.js';

/** ~`tokens` estimated tokens of latin text (4 chars per token). */
function text(tokens: number, tag = 'x'): string {
  return `${tag} `.repeat(tokens * 2).slice(0, tokens * 4);
}

/** Alternating user/assistant messages, seq from `startSeq`, each ~`tokens` tokens. */
function transcript(count: number, tokens: number, startSeq = 0): SequencedChatMessage[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m${startSeq + i}`,
    seq: startSeq + i,
    role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: text(tokens, `t${startSeq + i}`),
    created_at: '2026-10-01T00:00:00.000Z',
  }));
}

describe('planDigestFold (when and what to fold)', () => {
  it('does nothing while the unfolded history is within the trigger', () => {
    expect(planDigestFold(transcript(10, 1_000), { triggerTokens: 10_000 })).toBeNull();
  });

  it('folds everything before the last two exchanges once the trigger is passed', () => {
    const messages = transcript(12, 1_000); // 12k tokens, 6 exchanges
    const plan = planDigestFold(messages, { triggerTokens: 8_000, minFoldTokens: 1 })!;
    expect(plan.pendingTokens).toBe(12_000);
    // The last two exchanges (seq 8–11) stay verbatim.
    expect(plan.fold.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.uptoSeq).toBe(7);
    expect(plan.foldTokens).toBe(8_000);
  });

  it('keeps the last two exchanges verbatim even when they alone pass the trigger', () => {
    const messages = transcript(4, 5_000); // two exchanges, 20k tokens
    expect(planDigestFold(messages, { triggerTokens: 8_000, minFoldTokens: 1 })).toBeNull();
  });

  it('folds at most a bounded chunk per pass, ending on an assistant reply', () => {
    const messages = transcript(40, 1_000); // 40k tokens
    const plan = planDigestFold(messages, { triggerTokens: 8_000, maxFoldTokens: 9_500, minFoldTokens: 1 })!;
    // 9 messages fit in 9.5k; the chunk is cut back to end on the assistant at seq 7.
    expect(plan.fold.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(plan.fold.at(-1)!.role).toBe('assistant');
    expect(plan.foldTokens).toBeLessThanOrEqual(9_500);
  });

  it('uses the default chunk bound', () => {
    const plan = planDigestFold(transcript(200, 1_000), { triggerTokens: 8_000 })!;
    expect(plan.foldTokens).toBeLessThanOrEqual(DIGEST_MAX_FOLD_TOKENS);
    expect(plan.foldTokens).toBeGreaterThan(DIGEST_MAX_FOLD_TOKENS - 2_000);
  });

  it('still folds a question larger than the chunk bound (with its answer), so the fold can move past it', () => {
    const messages = transcript(6, 100);
    messages[0] = { ...messages[0]!, content: text(30_000) };
    const plan = planDigestFold(messages, { triggerTokens: 8_000, maxFoldTokens: 10_000, minFoldTokens: 1 })!;
    expect(plan.fold.map((m) => m.seq)).toEqual([0, 1]);
  });

  it('skips a fold too small to be worth a prompt-cache miss', () => {
    // Two tiny old messages ahead of two huge kept exchanges.
    const messages = [...transcript(2, 100), ...transcript(4, 5_000, 2)];
    expect(planDigestFold(messages, { triggerTokens: 8_000, minFoldTokens: 4_000 })).toBeNull();
  });
});

describe('digest text', () => {
  it('feeds the previous digest and numbered, sanitised messages to the model', () => {
    const request = buildDigestRequest('### Goals\n- ship v1.4', [
      { id: 'a', seq: 4, role: 'user', content: '预算多少？', created_at: '' },
      { id: 'b', seq: 5, role: 'assistant', content: '120 万。', created_at: '' },
    ]);
    expect(request).toContain('<current_digest>\n### Goals\n- ship v1.4\n</current_digest>');
    expect(request).toContain('[#4 user]\n预算多少？');
    expect(request).toContain('[#5 assistant]\n120 万。');
  });

  it('marks an empty previous digest explicitly', () => {
    expect(buildDigestRequest(null, [])).toContain('<current_digest>\n(empty)\n</current_digest>');
  });

  it('unwraps a fenced answer, rejects an empty one and caps the length', () => {
    expect(cleanDigest('```markdown\n### Goals\n- a\n```')).toBe('### Goals\n- a');
    expect(cleanDigest('   \n')).toBeNull();
    const long = cleanDigest(`### Facts\n${'- fact line\n'.repeat(2_000)}`)!;
    expect(long.length).toBeLessThanOrEqual(DIGEST_MAX_CHARS + 4);
    expect(long.endsWith('- …')).toBe(true);
  });

  it('formats the closing system-prompt section and offers recovery only when the tool is there', () => {
    const withSearch = formatDigestSection('### Goals\n- a', { canSearch: true });
    expect(withSearch.startsWith('\n\n## Earlier in this conversation\n')).toBe(true);
    expect(withSearch).toContain('conversation_search');
    expect(withSearch.endsWith('### Goals\n- a')).toBe(true);
    expect(formatDigestSection('### Goals\n- a', { canSearch: false })).not.toContain('conversation_search');
  });
});

function fakeDb(overrides: {
  session?: Record<string, unknown> | undefined;
  pending?: SequencedChatMessage[];
  advance?: boolean;
}) {
  const sessions = {
    getById: vi.fn(async () => overrides.session),
    listChatMessagesAfter: vi.fn(async () => overrides.pending ?? []),
    advanceDigest: vi.fn(async () => overrides.advance ?? true),
  };
  return { db: { sessions } as unknown as DatabaseProvider, sessions };
}

describe('foldSessionDigest', () => {
  let completion: ReturnType<typeof vi.fn<DigestCompletion>>;

  beforeEach(() => {
    completion = vi.fn<DigestCompletion>(async () => ({ text: '### Goals\n- keep going' }));
  });

  it('folds through complete() with digest usage accounting and advances by compare-and-set', async () => {
    const pending = transcript(40, 1_500, 10); // 60k tokens after digest_upto_seq 9
    const { db, sessions } = fakeDb({ session: { id: 's1', digest: 'old', digest_upto_seq: 9 }, pending });

    const result = await foldSessionDigest({ sessionId: 's1', userId: 'u1', db, completion });

    expect(result.status).toBe('folded');
    expect(sessions.listChatMessagesAfter).toHaveBeenCalledWith('s1', 9);
    expect(completion).toHaveBeenCalledWith(
      'team',
      expect.objectContaining({ caller: 'digest', userId: 'u1', sessionId: 's1', maxTokens: expect.any(Number) }),
    );
    const request = completion.mock.calls[0]![1].messages[0]!.content;
    expect(request).toContain('<current_digest>\nold\n</current_digest>');
    const call = sessions.advanceDigest.mock.calls[0] as unknown as [string, Record<string, unknown>];
    expect(call[0]).toBe('s1');
    expect(call[1]).toMatchObject({ expectedUptoSeq: 9, digest: '### Goals\n- keep going' });
    expect(call[1].uptoSeq).toBe(result.uptoSeq);
    expect(call[1].uptoSeq as number).toBeGreaterThan(9);
    const boundary = pending.find((m) => m.seq === call[1].uptoSeq)!;
    expect(call[1].boundary).toEqual({ id: boundary.id, content: boundary.content });
  });

  it('does not call the model below the trigger', async () => {
    const { db, sessions } = fakeDb({ session: { id: 's1' }, pending: transcript(6, 100) });
    expect((await foldSessionDigest({ sessionId: 's1', userId: 'u1', db, completion })).status).toBe('below_trigger');
    expect(sessions.listChatMessagesAfter).toHaveBeenCalledWith('s1', null);
    expect(completion).not.toHaveBeenCalled();
  });

  it('reports a lost compare-and-set without writing anything else', async () => {
    const { db } = fakeDb({ session: { id: 's1' }, pending: transcript(40, 1_500), advance: false });
    expect((await foldSessionDigest({ sessionId: 's1', userId: 'u1', db, completion })).status).toBe('lost_race');
  });

  it('never stores an empty digest', async () => {
    completion.mockResolvedValueOnce({ text: '  ' });
    const { db, sessions } = fakeDb({ session: { id: 's1' }, pending: transcript(40, 1_500) });
    expect((await foldSessionDigest({ sessionId: 's1', userId: 'u1', db, completion })).status).toBe('empty_output');
    expect(sessions.advanceDigest).not.toHaveBeenCalled();
  });
});

describe('scheduleDigestFold', () => {
  it('swallows provider failures so the finished turn is never affected', async () => {
    const { db, sessions } = fakeDb({ session: { id: 's-fail' }, pending: transcript(40, 1_500) });
    const completion = vi.fn<DigestCompletion>(async () => {
      throw new Error('monthly budget exhausted');
    });
    await expect(scheduleDigestFold({ sessionId: 's-fail', userId: 'u1', db, completion })).resolves.toBeUndefined();
    expect(sessions.advanceDigest).not.toHaveBeenCalled();
  });

  it('runs one fold at a time per session and keeps folding while there is a backlog', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { db, sessions } = fakeDb({ session: { id: 's-busy' }, pending: transcript(40, 1_500) });
    const completion = vi.fn<DigestCompletion>(async () => {
      await gate;
      return { text: '### Goals\n- a' };
    });

    const first = scheduleDigestFold({ sessionId: 's-busy', userId: 'u1', db, completion });
    expect(first).not.toBeNull();
    expect(scheduleDigestFold({ sessionId: 's-busy', userId: 'u1', db, completion })).toBeNull();
    release();
    await first;
    // The fake never shrinks the backlog, so the run stops at its pass limit.
    expect(sessions.advanceDigest.mock.calls.length).toBeGreaterThan(1);
    expect(sessions.advanceDigest.mock.calls.length).toBeLessThanOrEqual(3);
    // Once it is done, the session can be scheduled again.
    const again = scheduleDigestFold({ sessionId: 's-busy', userId: 'u1', db, completion });
    expect(again).not.toBeNull();
    await again;
  });
});

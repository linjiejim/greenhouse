/**
 * Rolling digest storage + conversation content search, against PostgreSQL.
 *
 * - `advanceDigest` is a compare-and-set: forward only, loses to a concurrent
 *   fold or a reset, and refuses a digest of a transcript that changed under it.
 * - Editing or truncating messages at or below `digest_upto_seq` resets it.
 * - `buildChatMessages({ afterSeq })` returns only the unfolded part.
 * - Content search (jieba terms) stays inside the caller's own sessions.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, messageSearchTerms, readSessionDigest } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A session owned by `userId` with `count` alternating user/assistant messages (seq 0..count-1). */
async function seededSession(userId: string, contents: string[]): Promise<string> {
  const session = await db.sessions.create('Digest test', 'team', userId);
  for (const [i, content] of contents.entries()) {
    await db.sessions.addMessage({ session_id: session.id, role: i % 2 === 0 ? 'user' : 'assistant', content });
  }
  return session.id;
}

async function messageAt(sessionId: string, seq: number) {
  const rows = await db.sessions.listChatMessagesAfter(sessionId, seq - 1);
  return rows.find((m) => m.seq === seq)!;
}

async function digestOf(sessionId: string) {
  return readSessionDigest(await db.sessions.getById(sessionId));
}

describe('session digest compare-and-set', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  it('advances from no digest, then only forward from the value it read', async () => {
    const sessionId = await seededSession(uid('u'), ['q0', 'a1', 'q2', 'a3', 'q4', 'a5']);
    const a1 = await messageAt(sessionId, 1);
    const a3 = await messageAt(sessionId, 3);

    expect(
      await db.sessions.advanceDigest(sessionId, {
        expectedUptoSeq: null,
        uptoSeq: 1,
        boundary: a1,
        digest: '### Goals\n- first',
      }),
    ).toBe(true);
    expect(await digestOf(sessionId)).toEqual({ text: '### Goals\n- first', uptoSeq: 1 });

    // A fold that started before the first one committed (expected null) loses.
    expect(
      await db.sessions.advanceDigest(sessionId, { expectedUptoSeq: null, uptoSeq: 3, boundary: a3, digest: 'stale' }),
    ).toBe(false);
    // Never backwards, never sideways.
    expect(
      await db.sessions.advanceDigest(sessionId, { expectedUptoSeq: 1, uptoSeq: 1, boundary: a1, digest: 'same' }),
    ).toBe(false);
    expect(
      await db.sessions.advanceDigest(sessionId, { expectedUptoSeq: 1, uptoSeq: 3, boundary: a3, digest: 'second' }),
    ).toBe(true);
    expect(await digestOf(sessionId)).toEqual({ text: 'second', uptoSeq: 3 });

    const row = await db.sessions.getById(sessionId);
    expect(row?.digest_updated_at).toBeTruthy();
  });

  it('refuses a digest of a transcript that changed under the fold', async () => {
    const sessionId = await seededSession(uid('u'), ['q0', 'a1', 'q2', 'a3']);
    const q2 = await messageAt(sessionId, 2);
    await db.sessions.editUserMessageAndTruncate(sessionId, q2.id, 'q2 edited');

    expect(
      await db.sessions.advanceDigest(sessionId, {
        expectedUptoSeq: null,
        uptoSeq: 2,
        boundary: { id: q2.id, content: 'q2' },
        digest: 'summary of the old q2',
      }),
    ).toBe(false);
    // The truncated message is gone entirely.
    expect(
      await db.sessions.advanceDigest(sessionId, {
        expectedUptoSeq: null,
        uptoSeq: 3,
        boundary: { id: 'whatever', content: 'a3' },
        digest: 'x',
      }),
    ).toBe(false);
    expect(await digestOf(sessionId)).toBeNull();
  });

  it('rejects an empty digest outright', async () => {
    const sessionId = await seededSession(uid('u'), ['q0', 'a1']);
    await expect(
      db.sessions.advanceDigest(sessionId, {
        expectedUptoSeq: null,
        uptoSeq: 1,
        boundary: await messageAt(sessionId, 1),
        digest: '  ',
      }),
    ).rejects.toThrow(/empty/);
  });
});

describe('session digest reset on edit', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  async function foldedThrough3(): Promise<string> {
    const sessionId = await seededSession(uid('u'), ['q0', 'a1', 'q2', 'a3', 'q4', 'a5', 'q6', 'a7']);
    const a3 = await messageAt(sessionId, 3);
    expect(
      await db.sessions.advanceDigest(sessionId, { expectedUptoSeq: null, uptoSeq: 3, boundary: a3, digest: 'D' }),
    ).toBe(true);
    return sessionId;
  }

  it('resets when a user message at or below digest_upto_seq is edited', async () => {
    const sessionId = await foldedThrough3();
    const q2 = await messageAt(sessionId, 2);
    await db.sessions.editUserMessageAndTruncate(sessionId, q2.id, 'q2 rewritten');
    expect(await digestOf(sessionId)).toBeNull();
    expect((await db.sessions.getById(sessionId))?.digest_upto_seq).toBeNull();
  });

  it('keeps the digest when the edit is after the folded range', async () => {
    const sessionId = await foldedThrough3();
    const q4 = await messageAt(sessionId, 4);
    await db.sessions.editUserMessageAndTruncate(sessionId, q4.id, 'q4 rewritten');
    expect(await digestOf(sessionId)).toEqual({ text: 'D', uptoSeq: 3 });
  });

  it('resets when the transcript is truncated into the folded range', async () => {
    const sessionId = await foldedThrough3();
    await db.sessions.deleteMessagesAfterSeq(sessionId, 6);
    expect(await digestOf(sessionId)).toEqual({ text: 'D', uptoSeq: 3 });
    await db.sessions.deleteMessagesAfterSeq(sessionId, 3);
    expect(await digestOf(sessionId)).toBeNull();
  });

  it('resets when a folded message is rewritten in place', async () => {
    const sessionId = await foldedThrough3();
    await db.sessions.updateMessageContent((await messageAt(sessionId, 1)).id, 'a1 corrected');
    expect(await digestOf(sessionId)).toBeNull();
  });
});

describe('prompt history after a digest', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  it('buildChatMessages(afterSeq) returns only the unfolded messages', async () => {
    const sessionId = await seededSession(uid('u'), ['q0', 'a1', 'q2', 'a3', 'q4']);
    const unfolded = await db.sessions.buildChatMessages(sessionId, { afterSeq: 1 });
    expect(unfolded.map((m) => m.content)).toEqual(['q2', 'a3', 'q4']);
    expect((await db.sessions.buildChatMessages(sessionId)).length).toBe(5);
  });

  it('a fork that keeps the folded range inherits the digest; an earlier cut does not', async () => {
    const userId = uid('u');
    const sessionId = await seededSession(userId, ['q0', 'a1', 'q2', 'a3', 'q4', 'a5']);
    await db.sessions.advanceDigest(sessionId, {
      expectedUptoSeq: null,
      uptoSeq: 3,
      boundary: await messageAt(sessionId, 3),
      digest: 'D',
    });

    const full = await db.sessions.fork({ sourceSessionId: sessionId, userId });
    expect(await digestOf(full!.id)).toEqual({ text: 'D', uptoSeq: 3 });
    const early = await db.sessions.fork({ sourceSessionId: sessionId, userId, throughSeq: 1 });
    expect(await digestOf(early!.id)).toBeNull();
  });

  it('session lists do not carry the digest text', async () => {
    const userId = uid('u');
    const sessionId = await seededSession(userId, ['q0', 'a1']);
    await db.sessions.advanceDigest(sessionId, {
      expectedUptoSeq: null,
      uptoSeq: 1,
      boundary: await messageAt(sessionId, 1),
      digest: 'D',
    });
    const [listed] = await db.sessions.list({ userId });
    expect(listed!.id).toBe(sessionId);
    expect(listed).not.toHaveProperty('digest');
  });
});

describe('conversation content search', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  it('segments CJK queries with jieba and drops single-character terms from the recall pass', () => {
    const { all, recall } = messageSearchTerms('蓝色方案的预算');
    expect(all).toEqual(expect.arrayContaining(['蓝色', '方案', '预算']));
    expect(recall).not.toContain('的');
  });

  it('finds Chinese and Latin details inside one conversation, best matches first', async () => {
    const sessionId = await seededSession(uid('u'), [
      '蓝色方案的预算是多少？',
      '蓝色方案预算 120 万，绿色方案 100 万。',
      'What about the LPH64 sensor?',
      'The LPH64 water-level sensor reports every 5 minutes.',
    ]);

    const cjk = await db.sessions.searchConversation(sessionId, '蓝色 预算');
    expect(cjk.map((h) => h.seq)).toEqual([1, 0]); // both terms; newest first on ties
    expect(cjk[0]!.snippet).toContain('120 万');

    const latin = await db.sessions.searchConversation(sessionId, 'lph64 water');
    expect(latin[0]!.seq).toBe(3); // matches both terms
    expect(latin.map((h) => h.seq)).toContain(2); // recall pass: one term

    expect(await db.sessions.searchConversation(sessionId, '不存在的词')).toEqual([]);
  });

  it('cross-conversation search only sees the caller’s own sessions', async () => {
    const alice = uid('alice');
    const bob = uid('bob');
    const marker = `zebra${Math.random().toString(36).slice(2, 8)}`;
    const own = await seededSession(alice, [`where is the ${marker} file?`, 'in drive']);
    const foreign = await seededSession(bob, [`${marker} secret plan`, 'ok']);
    // Sharing grants read access in the inbox, never search reach.
    await db.sessionShares.createMany([{ session_id: foreign, shared_by: bob, shared_with: '__team__' }]);

    const hits = await db.sessions.searchMessages(alice, marker);
    expect(hits.map((h) => h.session_id)).toEqual([own]);
    expect(hits[0]).toMatchObject({ seq: 0, role: 'user', title: 'Digest test', channel: 'web' });
    expect((await db.sessions.searchMessages(bob, marker)).map((h) => h.session_id)).toEqual([foreign]);
  });
});

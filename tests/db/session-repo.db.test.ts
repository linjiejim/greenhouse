/**
 * Session Repository integration tests.
 *
 * Tests session CRUD and message operations against a real PostgreSQL database.
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { MessageRow } from '@greenhouse/types/session';

let db: DatabaseProvider;

describe('Session Repository', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  // ─── Session CRUD ──────────────────────────────────────

  it('creates a session and retrieves by id', async () => {
    const session = await db.sessions.create('Test Session', 'team', 'user-1');
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('Test Session');
    expect(session.profile_id).toBe('team');

    const found = await db.sessions.getById(session.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Test Session');
  });

  it('creates a session without title', async () => {
    const session = await db.sessions.create(undefined, 'team');
    expect(session.id).toBeTruthy();
    expect(session.title).toBeNull();
  });

  it('lists sessions with pagination', async () => {
    await db.sessions.create('S1', 'team', 'u1');
    await db.sessions.create('S2', 'team', 'u1');
    await db.sessions.create('S3', 'team', 'u1');

    const all = await db.sessions.list({ limit: 10 });
    expect(all.length).toBe(3);

    const page = await db.sessions.list({ limit: 2 });
    expect(page.length).toBe(2);
  });

  it('hides excluded channels but keeps them reachable by explicit filter', async () => {
    await db.sessions.create('Chat', 'team', 'u1', undefined, 'web');
    await db.sessions.create('[workflow] node-a #1', 'team', 'u1', undefined, 'workflow');

    const visible = await db.sessions.list({ excludeChannels: ['workflow'] });
    expect(visible.map((s) => s.title)).toEqual(['Chat']);

    const internals = await db.sessions.list({ channel: 'workflow' });
    expect(internals.map((s) => s.title)).toEqual(['[workflow] node-a #1']);

    const unfiltered = await db.sessions.list({});
    expect(unfiltered.length).toBe(2);
  });

  it('updates session title', async () => {
    const session = await db.sessions.create(undefined, 'team');
    await db.sessions.updateTitle(session.id, 'New Title');

    const found = await db.sessions.getById(session.id);
    expect(found!.title).toBe('New Title');
  });

  it('updates session status', async () => {
    const session = await db.sessions.create('Test', 'team');
    await db.sessions.updateStatus(session.id, 'archived');

    const found = await db.sessions.getById(session.id);
    expect(found!.status).toBe('archived');
  });

  it('updates session with multiple fields', async () => {
    const session = await db.sessions.create('Test', 'team');
    const updated = await db.sessions.update(session.id, {
      rating: 5,
      comment: 'Great session',
      status: 'completed',
    });

    expect(updated).toBeDefined();
    expect(updated!.rating).toBe(5);
    expect(updated!.comment).toBe('Great session');
    expect(updated!.status).toBe('completed');
  });

  it('deletes a session', async () => {
    const session = await db.sessions.create('Delete Me', 'team');
    await db.sessions.delete(session.id);

    const found = await db.sessions.getById(session.id);
    expect(found).toBeUndefined();
  });

  it('returns undefined for non-existent session', async () => {
    const found = await db.sessions.getById('non-existent-id');
    expect(found).toBeUndefined();
  });

  // ─── Messages ──────────────────────────────────────────

  it('adds and retrieves messages', async () => {
    const session = await db.sessions.create('Chat', 'team');

    const msg1 = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Hello',
    });
    expect(msg1.id).toBeTruthy();
    expect(msg1.role).toBe('user');
    expect(msg1.content).toBe('Hello');

    const msg2 = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Hi there!',
    });

    const messages = await db.sessions.getMessages(session.id);
    expect(messages.length).toBe(2);
    expect(messages[0].content).toBe('Hello');
    expect(messages[1].content).toBe('Hi there!');
  });

  it('adds a server-owned message idempotently by stable id', async () => {
    const session = await db.sessions.create('Outcome', 'team');
    const id = 'cloud-agent-outcome:car_test';
    const first = await db.sessions.addMessageOnce(id, {
      session_id: session.id,
      role: 'assistant',
      content: 'Done',
    });
    const retried = await db.sessions.addMessageOnce(id, {
      session_id: session.id,
      role: 'assistant',
      content: 'A retry must not overwrite the frozen outcome',
    });
    expect(retried.id).toBe(first.id);
    expect(retried.content).toBe('Done');
    expect(await db.sessions.getMessageCount(session.id)).toBe(1);
  });

  it('pages backward by exclusive sequence cursor without gaps or duplicates', async () => {
    const session = await db.sessions.create('Paged chat', 'team');
    const inserted: MessageRow[] = [];
    for (let index = 0; index < 6; index++) {
      inserted.push(
        await db.sessions.addMessage({
          session_id: session.id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `Message ${index}`,
        }),
      );
    }

    const newest = await db.sessions.getMessagePage(session.id, { limit: 2 });
    expect(newest.messages.map((message) => message.id)).toEqual([inserted[4].id, inserted[5].id]);
    expect(newest.messages.map((message) => message.seq)).toEqual(
      [...newest.messages].map((message) => message.seq).sort((a, b) => a - b),
    );
    expect(newest.has_more).toBe(true);
    expect(newest.next_before_seq).toBe(inserted[4].seq);

    const middle = await db.sessions.getMessagePage(session.id, {
      limit: 2,
      beforeSeq: newest.next_before_seq!,
    });
    expect(middle.messages.map((message) => message.id)).toEqual([inserted[2].id, inserted[3].id]);
    expect(middle.has_more).toBe(true);
    expect(middle.next_before_seq).toBe(inserted[2].seq);

    const oldest = await db.sessions.getMessagePage(session.id, {
      limit: 2,
      beforeSeq: middle.next_before_seq!,
    });
    expect(oldest.messages.map((message) => message.id)).toEqual([inserted[0].id, inserted[1].id]);
    expect(oldest.has_more).toBe(false);
    expect(oldest.next_before_seq).toBeNull();

    const ids = [...newest.messages, ...middle.messages, ...oldest.messages].map((message) => message.id);
    expect(new Set(ids).size).toBe(inserted.length);

    const beforeFirst = await db.sessions.getMessagePage(session.id, {
      limit: 2,
      beforeSeq: inserted[0].seq,
    });
    expect(beforeFirst).toEqual({ messages: [], has_more: false, next_before_seq: null });
  });

  it('counts messages', async () => {
    const session = await db.sessions.create('Chat', 'team');

    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'A' });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'B' });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'C' });

    const count = await db.sessions.getMessageCount(session.id);
    expect(count).toBe(3);
  });

  it('builds chat messages for LLM context', async () => {
    const session = await db.sessions.create('Chat', 'team');

    await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Q1',
      images: [{ id: 'upload-1.png', url: '/api/upload/upload-1.png' }],
    });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'A1' });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Q2' });

    const chatMessages = await db.sessions.buildChatMessages(session.id);
    expect(chatMessages.length).toBe(3);
    expect(chatMessages[0].role).toBe('user');
    expect(chatMessages[0].content).toBe('Q1');
    expect(chatMessages[0].images).toEqual([{ id: 'upload-1.png', url: '/api/upload/upload-1.png' }]);
    expect(chatMessages[1].images).toEqual([]);
    expect(chatMessages[2].role).toBe('user');
    expect(chatMessages[2].content).toBe('Q2');
  });

  it('validates, excludes, and atomically replaces only the selected tail assistant', async () => {
    const session = await db.sessions.create('Regenerate', 'team');
    const user = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: '',
      images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
    });
    const assistant = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Old answer',
    });

    await expect(db.sessions.prepareRegeneration(session.id, assistant.id)).resolves.toEqual({
      ok: true,
      last_user: {
        id: user.id,
        content: '',
        images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
      },
    });
    // Validation is deliberately non-destructive: provider/quota/transport
    // failures between this preflight and generation must retain the old reply.
    await expect(db.sessions.prepareRegeneration(session.id, assistant.id)).resolves.toEqual({
      ok: true,
      last_user: {
        id: user.id,
        content: '',
        images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
      },
    });
    await expect(db.sessions.getMessages(session.id)).resolves.toEqual([user, assistant]);

    await expect(db.sessions.buildChatMessages(session.id, { excludeMessageId: assistant.id })).resolves.toEqual([
      {
        role: 'user',
        content: '',
        created_at: user.created_at,
        images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
      },
    ]);

    const replacement = await db.sessions.replaceLatestAssistant(session.id, assistant.id, {
      session_id: session.id,
      role: 'assistant',
      content: 'Better answer',
    });
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) throw new Error('Expected replacement to succeed');
    expect(replacement.message.id).not.toBe(assistant.id);
    expect(replacement.message.seq).toBe(assistant.seq);

    const remaining = await db.sessions.getMessages(session.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toEqual(user);
    expect(remaining[1]).toEqual(replacement.message);

    await expect(
      db.sessions.replaceLatestAssistant(session.id, assistant.id, {
        session_id: session.id,
        role: 'assistant',
        content: 'Stale answer',
      }),
    ).resolves.toEqual({ ok: false, reason: 'assistant_not_latest' });
  });

  it('does not delete a stale assistant selection when a newer turn exists', async () => {
    const session = await db.sessions.create('Stale regenerate', 'team');
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'First' });
    const staleAssistant = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Old answer',
    });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Second' });
    const latestAssistant = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Latest answer',
    });

    await expect(db.sessions.prepareRegeneration(session.id, staleAssistant.id)).resolves.toEqual({
      ok: false,
      reason: 'assistant_not_latest',
    });

    const remaining = await db.sessions.getMessages(session.id);
    expect(remaining.map((message) => message.id)).toContain(staleAssistant.id);
    expect(remaining.map((message) => message.id)).toContain(latestAssistant.id);
    expect(remaining).toHaveLength(4);
  });

  it('appends an assistant only while the exact transcript tail is unchanged', async () => {
    const session = await db.sessions.create('Tail CAS', 'team');
    const user = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Original prompt',
    });

    const appended = await db.sessions.appendAssistantIfTail(
      session.id,
      { id: user.id, content: user.content },
      {
        session_id: session.id,
        role: 'assistant',
        content: 'Current answer',
      },
    );
    expect(appended.ok).toBe(true);

    await expect(
      db.sessions.appendAssistantIfTail(
        session.id,
        { id: user.id, content: user.content },
        {
          session_id: session.id,
          role: 'assistant',
          content: 'Stale answer',
        },
      ),
    ).resolves.toEqual({ ok: false, reason: 'transcript_changed' });
  });

  it('edits a user message and truncates every dependent turn atomically', async () => {
    const session = await db.sessions.create('Edit', 'team');
    const user = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Old prompt',
    });
    await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Old answer',
    });
    await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Follow-up',
    });

    const edited = await db.sessions.editUserMessageAndTruncate(session.id, user.id, 'New prompt');
    expect(edited.ok).toBe(true);
    if (!edited.ok) throw new Error('Expected edit to succeed');
    expect(edited.message.id).toBe(user.id);
    expect(edited.message.content).toBe('New prompt');
    await expect(db.sessions.getMessages(session.id)).resolves.toEqual([edited.message]);

    await expect(
      db.sessions.appendAssistantIfTail(
        session.id,
        { id: user.id, content: 'Old prompt' },
        {
          session_id: session.id,
          role: 'assistant',
          content: 'Answer based on stale prompt',
        },
      ),
    ).resolves.toEqual({ ok: false, reason: 'transcript_changed' });
  });

  it('updates message content', async () => {
    const session = await db.sessions.create('Chat', 'team');
    const msg = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Original',
    });

    await db.sessions.updateMessageContent(msg.id, 'Updated content');

    const found = await db.sessions.getMessageById(msg.id);
    expect(found).toBeDefined();
    expect(found!.content).toBe('Updated content');
  });

  it('deletes messages after sequence number', async () => {
    const session = await db.sessions.create('Chat', 'team');

    const m1 = await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Keep 1' });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'Keep 2' });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Delete 3' });

    // Delete messages after seq 2 (keep first 2)
    await db.sessions.deleteMessagesAfterSeq(session.id, 2);

    const remaining = await db.sessions.getMessages(session.id);
    expect(remaining.length).toBe(2);
  });

  it('forks a session through an Agent reply without sharing mutable message ids', async () => {
    const source = await db.sessions.create('Source', 'team', 'source-owner');
    await db.sessions.addMessage({ session_id: source.id, role: 'user', content: 'Question 1' });
    const firstReply = await db.sessions.addMessage({
      session_id: source.id,
      role: 'assistant',
      content: 'Answer 1',
      reasoning: 'Reasoning 1',
      pipeline: [{ step: 1, tool: 'knowledge_query', input: {}, output: { ok: true }, duration_ms: 12 }],
    });
    await db.sessions.addMessage({ session_id: source.id, role: 'user', content: 'Question 2' });
    await db.sessions.addMessage({ session_id: source.id, role: 'assistant', content: 'Answer 2' });

    const fork = await db.sessions.fork({
      sourceSessionId: source.id,
      userId: 'fork-owner',
      throughSeq: firstReply.seq,
      sourceMessageId: firstReply.id,
    });

    expect(fork).toMatchObject({
      title: 'Source (Fork)',
      user_id: 'fork-owner',
      profile_id: 'team',
      channel: 'web',
      parent_session_id: source.id,
    });
    expect(JSON.parse(fork!.metadata)).toEqual({
      forked_from_session_id: source.id,
      forked_from_message_id: firstReply.id,
    });

    const forkMessages = await db.sessions.getMessages(fork!.id);
    expect(forkMessages.map((message) => message.content)).toEqual(['Question 1', 'Answer 1']);
    expect(forkMessages.map((message) => message.id)).not.toContain(firstReply.id);
    expect(forkMessages[1].reasoning).toBe('Reasoning 1');
    expect(JSON.parse(forkMessages[1].pipeline)).toEqual([
      { step: 1, tool: 'knowledge_query', input: {}, output: { ok: true }, duration_ms: 12 },
    ]);
  });

  // ─── Session Usage ─────────────────────────────────────

  it('returns zero usage for empty session', async () => {
    const session = await db.sessions.create('Empty', 'team');
    const usage = await db.sessions.getUsage(session.id);
    expect(Number(usage.messageCount)).toBe(0);
    expect(Number(usage.totalInputTokens)).toBe(0);
    expect(Number(usage.totalOutputTokens)).toBe(0);
  });

  // ─── Scope filters (sidebar: mine / shared / team) ─────

  describe('scope filters', () => {
    async function scopeFixture() {
      const alice = await db.users.create({
        email: `alice-${Date.now()}@scope.test`,
        password_hash: 'h',
        nickname: 'Alice',
        role: 'team',
      });
      const bob = await db.users.create({
        email: `bob-${Date.now()}@scope.test`,
        password_hash: 'h',
        nickname: 'Bob',
        role: 'team',
      });
      const mine = await db.sessions.create('Mine', 'team', alice.id);
      const theirs = await db.sessions.create('Theirs', 'team', bob.id);
      // Owner-less sessions are real: historical rows and engine-created ones.
      const ownerless = await db.sessions.create('Ownerless', 'team');
      return { alice, bob, mine, theirs, ownerless };
    }

    it('keeps NULL-owner sessions in the team scope', async () => {
      const { alice, mine, theirs, ownerless } = await scopeFixture();

      const rows = await db.sessions.list({ excludeUserId: alice.id, status: 'all', limit: 500 });
      const ids = rows.map((r) => r.id);

      // `user_id <> $1` is NULL-blind and would have dropped this row silently,
      // so "everyone else's" would quietly mean "everyone else who has an owner".
      expect(ids).toContain(ownerless.id);
      expect(ids).toContain(theirs.id);
      expect(ids).not.toContain(mine.id);
    });

    it('returns sessions shared directly and team-wide, but never your own', async () => {
      const { alice, bob, mine, theirs } = await scopeFixture();
      const teamWide = await db.sessions.create('Team wide', 'team', bob.id);

      await db.sessionShares.createMany([
        { session_id: theirs.id, shared_with: alice.id, shared_by: bob.id },
        { session_id: teamWide.id, shared_with: '__team__', shared_by: bob.id },
        // Alice sharing her own session out must not make it "shared with me".
        { session_id: mine.id, shared_with: '__team__', shared_by: alice.id },
      ]);

      const ids = (await db.sessions.listSharedWith(alice.id, { status: 'all', limit: 500 })).map((r) => r.id);

      expect(ids).toContain(theirs.id);
      expect(ids).toContain(teamWide.id);
      expect(ids).not.toContain(mine.id);
    });

    it('returns a doubly-shared session exactly once', async () => {
      const { alice, bob, theirs } = await scopeFixture();

      await db.sessionShares.createMany([
        { session_id: theirs.id, shared_with: alice.id, shared_by: bob.id },
        { session_id: theirs.id, shared_with: '__team__', shared_by: bob.id },
      ]);

      const ids = (await db.sessions.listSharedWith(alice.id, { status: 'all', limit: 500 })).map((r) => r.id);
      expect(ids.filter((id) => id === theirs.id)).toHaveLength(1);
    });

    it('applies the same status filter as the owner query', async () => {
      const { alice, bob, theirs } = await scopeFixture();
      await db.sessions.updateStatus(theirs.id, 'archived');
      await db.sessionShares.createMany([{ session_id: theirs.id, shared_with: alice.id, shared_by: bob.id }]);

      const active = await db.sessions.listSharedWith(alice.id, { status: 'active', limit: 500 });
      const archived = await db.sessions.listSharedWith(alice.id, { status: 'archived', limit: 500 });

      expect(active.map((r) => r.id)).not.toContain(theirs.id);
      expect(archived.map((r) => r.id)).toContain(theirs.id);
    });
  });
});

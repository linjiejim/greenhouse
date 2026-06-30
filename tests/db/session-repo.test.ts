/**
 * Session Repository integration tests.
 *
 * Tests session CRUD and message operations against a real PostgreSQL database.
 * Requires: PostgreSQL running at localhost:5432 with greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

describe('Session Repository', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  // ─── Session CRUD ──────────────────────────────────────

  it('creates a session and retrieves by id', async () => {
    const session = await db.sessions.create('Test Session', 'default', 'user-1');
    expect(session.id).toBeTruthy();
    expect(session.title).toBe('Test Session');
    expect(session.profile_id).toBe('default');

    const found = await db.sessions.getById(session.id);
    expect(found).toBeDefined();
    expect(found!.title).toBe('Test Session');
  });

  it('creates a session without title', async () => {
    const session = await db.sessions.create(undefined, 'default');
    expect(session.id).toBeTruthy();
    expect(session.title).toBeNull();
  });

  it('lists sessions with pagination', async () => {
    await db.sessions.create('S1', 'default', 'u1');
    await db.sessions.create('S2', 'default', 'u1');
    await db.sessions.create('S3', 'default', 'u1');

    const all = await db.sessions.list({ limit: 10 });
    expect(all.length).toBe(3);

    const page = await db.sessions.list({ limit: 2 });
    expect(page.length).toBe(2);
  });

  it('updates session title', async () => {
    const session = await db.sessions.create(undefined, 'default');
    await db.sessions.updateTitle(session.id, 'New Title');

    const found = await db.sessions.getById(session.id);
    expect(found!.title).toBe('New Title');
  });

  it('updates session status', async () => {
    const session = await db.sessions.create('Test', 'default');
    await db.sessions.updateStatus(session.id, 'archived');

    const found = await db.sessions.getById(session.id);
    expect(found!.status).toBe('archived');
  });

  it('updates session with multiple fields', async () => {
    const session = await db.sessions.create('Test', 'default');
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
    const session = await db.sessions.create('Delete Me', 'default');
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
    const session = await db.sessions.create('Chat', 'default');

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

  it('counts messages', async () => {
    const session = await db.sessions.create('Chat', 'default');

    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'A' });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'B' });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'C' });

    const count = await db.sessions.getMessageCount(session.id);
    expect(count).toBe(3);
  });

  it('builds chat messages for LLM context', async () => {
    const session = await db.sessions.create('Chat', 'default');

    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Q1' });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'A1' });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Q2' });

    const chatMessages = await db.sessions.buildChatMessages(session.id);
    expect(chatMessages.length).toBe(3);
    expect(chatMessages[0].role).toBe('user');
    expect(chatMessages[0].content).toBe('Q1');
    expect(chatMessages[2].role).toBe('user');
    expect(chatMessages[2].content).toBe('Q2');
  });

  it('updates message content', async () => {
    const session = await db.sessions.create('Chat', 'default');
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
    const session = await db.sessions.create('Chat', 'default');

    const m1 = await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Keep 1' });
    await db.sessions.addMessage({ session_id: session.id, role: 'assistant', content: 'Keep 2' });
    await db.sessions.addMessage({ session_id: session.id, role: 'user', content: 'Delete 3' });

    // Delete messages after seq 2 (keep first 2)
    await db.sessions.deleteMessagesAfterSeq(session.id, 2);

    const remaining = await db.sessions.getMessages(session.id);
    expect(remaining.length).toBe(2);
  });

  // ─── Session Usage ─────────────────────────────────────

  it('returns zero usage for empty session', async () => {
    const session = await db.sessions.create('Empty', 'default');
    const usage = await db.sessions.getUsage(session.id);
    expect(Number(usage.messageCount)).toBe(0);
    expect(Number(usage.totalInputTokens)).toBe(0);
    expect(Number(usage.totalOutputTokens)).toBe(0);
  });
});

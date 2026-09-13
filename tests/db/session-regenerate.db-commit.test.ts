/**
 * Session message concurrency integration tests.
 *
 * @db-commit-reason Concurrent connections must contend on the same session
 * row and observe each other's committed sequence allocation/transcript rewrite.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;
const createdSessionIds: string[] = [];

describe('Session message concurrency', () => {
  beforeAll(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterAll(async () => {
    for (const sessionId of createdSessionIds) {
      await db.sessions.delete(sessionId);
    }
    await db.close();
    _resetProvider();
  });

  it('lets exactly one rapid request atomically replace the selected assistant tail', async () => {
    const session = await db.sessions.create(`Regenerate race ${randomUUID()}`, 'team');
    createdSessionIds.push(session.id);
    const user = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Try this again',
    });
    const assistant = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'First answer',
    });

    const results = await Promise.all([
      db.sessions.replaceLatestAssistant(session.id, assistant.id, {
        session_id: session.id,
        role: 'assistant',
        content: 'Replacement A',
      }),
      db.sessions.replaceLatestAssistant(session.id, assistant.id, {
        session_id: session.id,
        role: 'assistant',
        content: 'Replacement B',
      }),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, reason: 'assistant_not_latest' }]);
    const remaining = await db.sessions.getMessages(session.id);
    expect(remaining).toHaveLength(2);
    expect(remaining[0]).toEqual(user);
    expect(remaining[1].id).not.toBe(assistant.id);
    expect(remaining[1].seq).toBe(assistant.seq);
    expect(['Replacement A', 'Replacement B']).toContain(remaining[1].content);
  });

  it('allocates a unique contiguous sequence for concurrent appenders', async () => {
    const session = await db.sessions.create(`Append race ${randomUUID()}`, 'team');
    createdSessionIds.push(session.id);

    await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        db.sessions.addMessage({
          session_id: session.id,
          role: index % 2 === 0 ? 'user' : 'assistant',
          content: `Concurrent ${index}`,
        }),
      ),
    );

    const persisted = await db.sessions.getMessages(session.id);
    expect(persisted).toHaveLength(12);
    expect(persisted.map((message) => message.seq)).toEqual(Array.from({ length: 12 }, (_, index) => index));
    expect(new Set(persisted.map((message) => message.seq)).size).toBe(12);
  });

  it('never retains an assistant generated from a concurrently edited prompt', async () => {
    const session = await db.sessions.create(`Edit race ${randomUUID()}`, 'team');
    createdSessionIds.push(session.id);
    const user = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Old prompt',
    });

    await Promise.all([
      db.sessions.appendAssistantIfTail(
        session.id,
        { id: user.id, content: user.content },
        {
          session_id: session.id,
          role: 'assistant',
          content: 'Answer based on old prompt',
        },
      ),
      db.sessions.editUserMessageAndTruncate(session.id, user.id, 'Edited prompt'),
    ]);

    const persisted = await db.sessions.getMessages(session.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: user.id,
      role: 'user',
      content: 'Edited prompt',
      seq: 0,
    });
  });

  it('serializes assistant replacement against prompt editing and truncation', async () => {
    const session = await db.sessions.create(`Replacement edit race ${randomUUID()}`, 'team');
    createdSessionIds.push(session.id);
    const user = await db.sessions.addMessage({
      session_id: session.id,
      role: 'user',
      content: 'Old prompt',
    });
    const assistant = await db.sessions.addMessage({
      session_id: session.id,
      role: 'assistant',
      content: 'Old answer',
    });

    await Promise.all([
      db.sessions.replaceLatestAssistant(session.id, assistant.id, {
        session_id: session.id,
        role: 'assistant',
        content: 'Replacement based on old prompt',
      }),
      db.sessions.editUserMessageAndTruncate(session.id, user.id, 'Edited prompt'),
    ]);

    const persisted = await db.sessions.getMessages(session.id);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: user.id,
      role: 'user',
      content: 'Edited prompt',
      seq: 0,
    });
  });
});

/**
 * POST /api/chat `client_turn_id`: a resend of a turn the session already has is
 * refused with 409 duplicate_turn — no second message, no second run.
 *
 * The cross-instance race (no shared in-memory run claim) is covered on separate
 * connections in tests/db/client-turn.db-commit.test.ts.
 *
 * The turn is stopped right after the user message is saved (the transcript read
 * that follows is stubbed empty → 400), so no model is ever called.
 */

import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { AppEnv } from '../../app-env.js';
import type { ToolRegistry } from '../../agent.js';
import { createChatRoute } from '../chat.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: user.id, role: user.role as 'team' });
    return next();
  });
  app.route('/api/chat', createChatRoute({} as ToolRegistry));
  return app;
}

function send(app: Hono<AppEnv>, sessionId: string, message: Record<string, unknown>) {
  return app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, messages: [{ role: 'user', ...message }] }),
  });
}

const turnRows = (sessionId: string) => db.sessions.getMessages(sessionId);

describe('POST /api/chat client_turn_id', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    user = await createInternalTestUser(db, { email: `client-turn-${Date.now()}-${Math.random()}@test.local` });
    // Stop every turn right after the user message is saved.
    vi.spyOn(db.sessions, 'buildChatMessages').mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    _resetProvider();
  });

  it('saves the first send and refuses a repeat with 409 duplicate_turn', async () => {
    const app = createApp();
    const session = await db.sessions.create('t', 'team', user.id);
    const first = await send(app, session.id, { content: 'same words', client_turn_id: 'turn_0001-abc' });
    expect(first.status).toBe(400); // passed admission; stopped by the stubbed transcript read
    const [saved] = await turnRows(session.id);
    expect(saved).toMatchObject({ role: 'user', content: 'same words', client_turn_id: 'turn_0001-abc' });

    const repeat = await send(app, session.id, { content: 'same words', client_turn_id: 'turn_0001-abc' });
    expect(repeat.status).toBe(409);
    expect(await repeat.json()).toEqual({
      error: 'This turn was already sent',
      code: 'duplicate_turn',
      message_id: saved!.id,
    });
    expect(await turnRows(session.id)).toHaveLength(1);
    // No run started for the repeat: only the first send read the transcript.
    expect(db.sessions.buildChatMessages).toHaveBeenCalledTimes(1);
  });

  it('keeps the same words sent as a new turn, and works without an id', async () => {
    const app = createApp();
    const session = await db.sessions.create('t', 'team', user.id);
    await send(app, session.id, { content: 'again', client_turn_id: 'turn_0002-aaa' });
    await send(app, session.id, { content: 'again', client_turn_id: 'turn_0002-bbb' });
    await send(app, session.id, { content: 'again' });
    await send(app, session.id, { content: 'again' });
    expect((await turnRows(session.id)).map((m) => m.client_turn_id ?? null)).toEqual([
      'turn_0002-aaa',
      'turn_0002-bbb',
      null,
      null,
    ]);
  });

  it('saves exactly one message for two concurrent sends of one turn', async () => {
    const app = createApp();
    const session = await db.sessions.create('t', 'team', user.id);
    const responses = await Promise.all([
      send(app, session.id, { content: 'race', client_turn_id: 'turn_0003-race' }),
      send(app, session.id, { content: 'race', client_turn_id: 'turn_0003-race' }),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([400, 409]);
    expect(await turnRows(session.id)).toHaveLength(1);
  });

  it('rejects a malformed client_turn_id', async () => {
    const app = createApp();
    const session = await db.sessions.create('t', 'team', user.id);
    for (const bad of ['short', 'has space in it', 'x'.repeat(65), 42]) {
      const res = await send(app, session.id, { content: 'x', client_turn_id: bad });
      expect(res.status).toBe(400);
    }
    expect(await turnRows(session.id)).toHaveLength(0);
  });
});

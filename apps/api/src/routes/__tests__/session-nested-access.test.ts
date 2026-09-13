import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    getById: vi.fn(),
    getMessageById: vi.fn(),
    fork: vi.fn(),
  },
  sessionShares: {
    getSharedSessionIds: vi.fn(),
    deleteOne: vi.fn(),
  },
  chatEval: {
    getByMessageId: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => mocks,
}));

vi.mock('../../llm/title.js', () => ({
  generateSessionTitle: vi.fn(),
}));

import sessionRoutes from '../sessions.js';

function makeSession(id = 'session-a'): SessionRow {
  return {
    id,
    title: 'Session',
    status: 'active',
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'team',
    user_id: 'owner',
    app_id: null,
    channel: 'web',
    parent_session_id: null,
    metadata: '{}',
    created_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
  };
}

function createApp(userId = 'owner') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: userId, role: 'team' });
    return next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.getById.mockResolvedValue(makeSession());
  mocks.sessions.fork.mockResolvedValue(makeSession('forked-session'));
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
});

describe('session nested-resource authorization', () => {
  it('does not delete a share row that belongs to another session', async () => {
    mocks.sessionShares.deleteOne.mockResolvedValue(false);

    const response = await createApp().request('/api/sessions/session-a/shares/99', {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Share not found' });
    expect(mocks.sessionShares.deleteOne).toHaveBeenCalledWith(99, 'session-a');
  });

  it('does not return an eval for a message from another session', async () => {
    mocks.sessions.getMessageById.mockResolvedValue({ id: 'message-b', session_id: 'session-b' });

    const response = await createApp().request('/api/sessions/session-a/messages/message-b/eval');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: false });
    expect(mocks.chatEval.getByMessageId).not.toHaveBeenCalled();
  });

  it('does not return an eval record whose parent session does not match the path', async () => {
    mocks.sessions.getMessageById.mockResolvedValue({ id: 'message-a', session_id: 'session-a' });
    mocks.chatEval.getByMessageId.mockResolvedValue({
      message_id: 'message-a',
      session_id: 'session-b',
    });

    const response = await createApp().request('/api/sessions/session-a/messages/message-a/eval');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ exists: false });
  });

  it('lets a read-only share recipient fork through an Agent reply into an owned session', async () => {
    mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['session-a']);
    mocks.sessions.getMessageById.mockResolvedValue({
      id: 'assistant-1',
      session_id: 'session-a',
      role: 'assistant',
      seq: 3,
    });

    const response = await createApp('reader').request('/api/sessions/session-a/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 'assistant-1' }),
    });

    expect(response.status).toBe(201);
    expect(mocks.sessions.fork).toHaveBeenCalledWith({
      sourceSessionId: 'session-a',
      userId: 'reader',
      throughSeq: 3,
      sourceMessageId: 'assistant-1',
    });
  });

  it('does not reveal or fork an inaccessible session', async () => {
    const response = await createApp('other').request('/api/sessions/session-a/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(404);
    expect(mocks.sessions.fork).not.toHaveBeenCalled();
  });

  it('rejects a fork boundary that is not an Agent reply', async () => {
    mocks.sessions.getMessageById.mockResolvedValue({
      id: 'user-1',
      session_id: 'session-a',
      role: 'user',
      seq: 2,
    });

    const response = await createApp().request('/api/sessions/session-a/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message_id: 'user-1' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.sessions.fork).not.toHaveBeenCalled();
  });
});

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    getById: vi.fn(),
    editUserMessageAndTruncate: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => mocks,
}));

vi.mock('../../llm/title.js', () => ({
  generateSessionTitle: vi.fn(),
}));

import sessionRoutes from '../sessions.js';

function makeSession(): SessionRow {
  return {
    id: 'session-a',
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
    created_at: '2026-07-31T00:00:00.000Z',
    updated_at: '2026-07-31T00:00:00.000Z',
  };
}

function editMessage(content = ' Edited prompt ') {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'owner', role: 'team' });
    return next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app.request('/api/sessions/session-a/messages/user-message', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.getById.mockResolvedValue(makeSession());
  mocks.sessions.editUserMessageAndTruncate.mockResolvedValue({
    ok: true,
    message: { id: 'user-message' },
  });
});

describe('PATCH /api/sessions/:id/messages/:msgId', () => {
  it('delegates editing and dependent-tail deletion to one atomic service operation', async () => {
    const response = await editMessage();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.sessions.editUserMessageAndTruncate).toHaveBeenCalledWith(
      'session-a',
      'user-message',
      'Edited prompt',
    );
  });

  it('preserves the role validation response', async () => {
    mocks.sessions.editUserMessageAndTruncate.mockResolvedValue({
      ok: false,
      reason: 'not_user',
    });

    const response = await editMessage();

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Can only edit user messages' });
  });

  it('returns not found when the message disappeared before the locked edit', async () => {
    mocks.sessions.editUserMessageAndTruncate.mockResolvedValue({
      ok: false,
      reason: 'message_not_found',
    });

    const response = await editMessage();

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Message not found' });
  });
});

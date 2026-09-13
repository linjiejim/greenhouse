import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    getById: vi.fn(),
    prepareRegeneration: vi.fn(),
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

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: c.req.header('x-user-id') ?? 'owner',
      role: c.req.header('x-user-role') === 'super' ? 'super' : 'team',
    });
    return next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app;
}

function regenerate(body: unknown, userId = 'owner') {
  return createApp().request('/api/sessions/session-a/regenerate', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': userId,
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.getById.mockResolvedValue(makeSession());
});

describe('POST /api/sessions/:id/regenerate', () => {
  it.each([{}, { assistant_message_id: '' }, { assistant_message_id: 42 }])(
    'requires an assistant_message_id: %j',
    async (body) => {
      const response = await regenerate(body);

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'assistant_message_id is required',
      });
      expect(mocks.sessions.prepareRegeneration).not.toHaveBeenCalled();
    },
  );

  it('returns a structured image-only last_user without using content truthiness', async () => {
    mocks.sessions.prepareRegeneration.mockResolvedValue({
      ok: true,
      last_user: {
        id: 'user-message',
        content: '',
        images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
      },
    });

    const response = await regenerate({ assistant_message_id: ' assistant-message ' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      last_user: {
        id: 'user-message',
        content: '',
        images: [{ id: 'image-only.png', url: '/api/upload/image-only.png' }],
      },
    });
    expect(mocks.sessions.prepareRegeneration).toHaveBeenCalledWith('session-a', 'assistant-message');
  });

  it('returns 409 when the selected assistant is no longer the transcript tail', async () => {
    mocks.sessions.prepareRegeneration.mockResolvedValue({
      ok: false,
      reason: 'assistant_not_latest',
    });

    const response = await regenerate({ assistant_message_id: 'stale-assistant' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Assistant message is no longer the latest message',
    });
  });

  it('does not enter the transcript transaction for a read-only viewer', async () => {
    const response = await regenerate({ assistant_message_id: 'assistant-message' }, 'viewer');

    expect(response.status).toBe(403);
    expect(mocks.sessions.prepareRegeneration).not.toHaveBeenCalled();
  });
});

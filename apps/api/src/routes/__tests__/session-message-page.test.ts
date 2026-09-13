import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionMessagePage, SessionRow } from '@greenhouse/types/session';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    getById: vi.fn(),
    getMessages: vi.fn(),
    getMessagePage: vi.fn(),
    getUsage: vi.fn(),
  },
  sessionShares: {
    getSharedSessionIds: vi.fn(),
    getSharesForSession: vi.fn(),
  },
  sessionTags: {
    getSessionTags: vi.fn(),
  },
  users: {
    getById: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => mocks,
}));

vi.mock('../../llm/title.js', () => ({
  generateSessionTitle: vi.fn(),
}));

import sessionRoutes from '../sessions.js';

const emptyPage: SessionMessagePage = {
  messages: [],
  has_more: false,
  next_before_seq: null,
};

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
    const id = c.req.header('x-user-id') ?? 'owner';
    const role = c.req.header('x-user-role') === 'super' ? 'super' : 'team';
    c.set('user', { id, role });
    return next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app;
}

function requestMessages(userId: string, role: 'team' | 'super' = 'team', query = '') {
  return createApp().request(`/api/sessions/session-a/messages${query}`, {
    headers: {
      'x-user-id': userId,
      'x-user-role': role,
    },
  });
}

function requestDetail(query = '') {
  return createApp().request(`/api/sessions/session-a${query}`, {
    headers: {
      'x-user-id': 'owner',
      'x-user-role': 'team',
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.getById.mockResolvedValue(makeSession());
  mocks.sessions.getMessages.mockResolvedValue([]);
  mocks.sessions.getMessagePage.mockResolvedValue(emptyPage);
  mocks.sessions.getUsage.mockResolvedValue({ input: 0, output: 0, cached: 0, reasoning: 0 });
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
  mocks.sessionShares.getSharesForSession.mockResolvedValue([]);
  mocks.sessionTags.getSessionTags.mockResolvedValue([]);
});

describe('GET /api/sessions/:id metadata mode', () => {
  it('skips the legacy unbounded message read when include_messages=0', async () => {
    const response = await requestDetail('?include_messages=0');

    expect(response.status).toBe(200);
    expect(mocks.sessions.getMessages).not.toHaveBeenCalled();
    expect((await response.json()).messages).toEqual([]);
  });

  it('keeps messages in the backwards-compatible default response', async () => {
    const response = await requestDetail();

    expect(response.status).toBe(200);
    expect(mocks.sessions.getMessages).toHaveBeenCalledWith('session-a');
  });

  it('rejects an invalid include_messages value', async () => {
    const response = await requestDetail('?include_messages=false');

    expect(response.status).toBe(400);
    expect(mocks.sessions.getById).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id/messages', () => {
  it.each([
    ['owner', 'owner', 'team'] as const,
    ['shared reader', 'reader', 'team'] as const,
    ['super user', 'admin', 'super'] as const,
  ])('allows the %s to read a page', async (_label, userId, role) => {
    if (userId === 'reader') {
      mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['session-a']);
    }

    const response = await requestMessages(userId, role, '?limit=25&before_seq=40');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(emptyPage);
    expect(mocks.sessions.getMessagePage).toHaveBeenCalledWith('session-a', {
      limit: 25,
      beforeSeq: 40,
    });
  });

  it('uses the latest 50 messages by default', async () => {
    const response = await requestMessages('owner');

    expect(response.status).toBe(200);
    expect(mocks.sessions.getMessagePage).toHaveBeenCalledWith('session-a', {
      limit: 50,
      beforeSeq: undefined,
    });
  });

  it('returns the same 404 for an inaccessible session and does not read messages', async () => {
    const response = await requestMessages('other');

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Session not found' });
    expect(mocks.sessions.getMessagePage).not.toHaveBeenCalled();
  });

  it.each([
    '?limit=0',
    '?limit=101',
    '?limit=1.5',
    '?limit=NaN',
    '?before_seq=-1',
    '?before_seq=1.5',
    '?before_seq=NaN',
  ])('rejects invalid cursor parameters: %s', async (query) => {
    const response = await requestMessages('owner', 'team', query);

    expect(response.status).toBe(400);
    expect(mocks.sessions.getMessagePage).not.toHaveBeenCalled();
  });

  it('accepts the upper limit and zero as an exclusive cursor', async () => {
    const response = await requestMessages('owner', 'team', '?limit=100&before_seq=0');

    expect(response.status).toBe(200);
    expect(mocks.sessions.getMessagePage).toHaveBeenCalledWith('session-a', {
      limit: 100,
      beforeSeq: 0,
    });
  });
});

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
  customProfiles: {
    getById: vi.fn(),
    getVersion: vi.fn(),
  },
}));

vi.mock('../../profiles/profile.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProfileAsync: vi.fn(async (id: string) => ({ id, access: { level: 'full' } })),
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
    profile_id: 'team',
    user_id: 'owner',
    app_id: null,
    channel: 'web',
    metadata: {},
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

    const response = await createApp().request('/api/sessions/session-a/shares/csh_other', {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Share not found' });
    expect(mocks.sessionShares.deleteOne).toHaveBeenCalledWith('csh_other', 'session-a');
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

  it('keeps your own pinned Agent version when you fork, and checks a shared one against the current version', async () => {
    mocks.customProfiles.getById.mockResolvedValue({
      id: '7',
      user_id: 'agent-owner',
      is_shared: true,
      version: 3,
    });
    mocks.customProfiles.getVersion.mockImplementation(async (_id: string, version: number) => ({ version }));
    mocks.sessions.getById.mockResolvedValue({ ...makeSession(), profile_id: 'custom:7@1' });

    const own = await createApp('owner').request('/api/sessions/session-a/fork', { method: 'POST' });
    expect(own.status).toBe(201);
    expect(mocks.customProfiles.getVersion).toHaveBeenLastCalledWith('7', 1);

    mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['session-a']);
    const shared = await createApp('reader').request('/api/sessions/session-a/fork', { method: 'POST' });
    expect(shared.status).toBe(201);
    expect(mocks.customProfiles.getVersion).toHaveBeenLastCalledWith('7', 3);
  });
});

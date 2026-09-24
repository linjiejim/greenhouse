/**
 * The extension's conversations live on their own `browser` channel: POST
 * /api/sessions accepts exactly that client-supplied channel (every other one is
 * server-assigned), and the panel's channel-filtered history is "my sessions on
 * this channel" with nothing from the sidebar folded in.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
import type { UserRole } from '@greenhouse/types/api';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    create: vi.fn(),
    list: vi.fn(),
    listSharedWith: vi.fn(),
    getById: vi.fn(),
  },
  users: {
    getById: vi.fn(),
  },
  sessionShares: {
    getSharedSessionIds: vi.fn(),
  },
  sessionGroups: {
    getOrganizedSessionIds: vi.fn(),
    getMembershipsForUser: vi.fn(),
  },
  sessionTags: {
    getTagsBySessionIds: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => mocks,
}));

vi.mock('../../llm/title.js', () => ({
  generateSessionTitle: vi.fn(),
}));

vi.mock('../../profiles/access.js', () => ({
  pinProfileIdForUser: vi.fn(async (_user: unknown, profileId: string | undefined) => profileId ?? 'sprouty'),
  ProfileAccessError: class ProfileAccessError extends Error {
    status = 403 as const;
  },
}));

vi.mock('../../profiles/profile.js', () => ({
  resolveProfileAsync: vi.fn(async (id: string) => ({ id, access: { level: 'internal', rich_output: true } })),
}));

import sessionRoutes from '../sessions.js';

function makeSession(id: string, channel: SessionRow['channel'] = 'web'): SessionRow {
  return {
    id,
    title: id,
    status: 'active',
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'sprouty',
    user_id: 'owner',
    app_id: null,
    channel,
    parent_session_id: null,
    metadata: '{}',
    created_at: '2026-09-24T00:00:00.000Z',
    updated_at: '2026-09-24T00:00:00.000Z',
  };
}

function createApp(user: { id: string; role: UserRole } = { id: 'owner', role: 'team' }) {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', user);
    return next();
  });
  app.route('/api/sessions', sessionRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.create.mockImplementation(
    async (_t: unknown, _p: unknown, _u: unknown, _a: unknown, channel?: string) =>
      makeSession('new-session', (channel ?? 'web') as SessionRow['channel']),
  );
  mocks.sessions.list.mockResolvedValue([]);
  mocks.sessions.listSharedWith.mockResolvedValue([]);
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
  mocks.sessionGroups.getOrganizedSessionIds.mockResolvedValue(['pinned-web-session']);
  mocks.sessionGroups.getMembershipsForUser.mockResolvedValue(new Map());
  mocks.sessionTags.getTagsBySessionIds.mockResolvedValue(new Map());
  mocks.sessions.getById.mockResolvedValue(makeSession('pinned-web-session'));
});

function createSession(body: Record<string, unknown>) {
  return createApp().request('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/sessions channel', () => {
  it('files an extension conversation on the browser channel', async () => {
    const response = await createSession({ profile_id: 'sprouty', channel: 'browser' });

    expect(response.status).toBe(201);
    expect(mocks.sessions.create).toHaveBeenCalledWith(undefined, 'sprouty', 'owner', undefined, 'browser');
    await expect(response.json()).resolves.toMatchObject({ channel: 'browser' });
  });

  it('ignores any other client-supplied channel', async () => {
    for (const channel of ['feishu', 'task', 'workflow', 'web', 42]) {
      mocks.sessions.create.mockClear();
      const response = await createSession({ profile_id: 'sprouty', channel });

      expect(response.status).toBe(201);
      expect(mocks.sessions.create).toHaveBeenCalledWith(undefined, 'sprouty', 'owner', undefined, undefined);
    }
  });
});

describe('GET /api/sessions channel-filtered list', () => {
  it("is the caller's own sessions on that channel, with no sidebar backfill", async () => {
    mocks.sessions.list.mockResolvedValue([makeSession('browser-session', 'browser')]);

    const response = await createApp().request('/api/sessions?scope=mine&channel=browser&limit=30');

    expect(response.status).toBe(200);
    expect(mocks.sessions.list).toHaveBeenCalledWith(expect.objectContaining({ channel: 'browser', userId: 'owner' }));
    expect(mocks.sessionGroups.getOrganizedSessionIds).not.toHaveBeenCalled();
    const body = (await response.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions.map((s) => s.id)).toEqual(['browser-session']);
  });

  it('still backfills filed sessions into the unfiltered sidebar list', async () => {
    const response = await createApp().request('/api/sessions?scope=mine');

    expect(response.status).toBe(200);
    expect(mocks.sessionGroups.getOrganizedSessionIds).toHaveBeenCalledWith('owner');
    const body = (await response.json()) as { sessions: Array<{ id: string }> };
    expect(body.sessions.map((s) => s.id)).toEqual(['pinned-web-session']);
  });
});

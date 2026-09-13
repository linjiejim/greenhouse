import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
import type { UserRole } from '@greenhouse/types/api';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    list: vi.fn(),
    listSharedWith: vi.fn(),
    getById: vi.fn(),
    update: vi.fn(),
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

import sessionRoutes from '../sessions.js';

function makeSession(id: string, userId = 'owner', updatedAt = '2026-07-31T00:00:00.000Z'): SessionRow {
  return {
    id,
    title: id,
    status: 'active',
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'team',
    user_id: userId,
    app_id: null,
    channel: 'web',
    parent_session_id: null,
    metadata: '{}',
    created_at: updatedAt,
    updated_at: updatedAt,
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
  mocks.sessions.list.mockResolvedValue([]);
  mocks.sessions.listSharedWith.mockResolvedValue([]);
  mocks.sessions.getById.mockResolvedValue(undefined);
  mocks.sessions.update.mockResolvedValue(undefined);
  mocks.users.getById.mockResolvedValue(undefined);
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
  mocks.sessionGroups.getOrganizedSessionIds.mockResolvedValue([]);
  mocks.sessionGroups.getMembershipsForUser.mockResolvedValue(new Map());
  mocks.sessionTags.getTagsBySessionIds.mockResolvedValue(new Map());
});

describe('PATCH /api/sessions/:id status boundary', () => {
  it('rejects a team user promoting an ordinary conversation into Eval', async () => {
    mocks.sessions.getById.mockResolvedValue(makeSession('session-a'));

    const response = await createApp().request('/api/sessions/session-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'eval' }),
    });

    expect(response.status).toBe(400);
    expect(mocks.sessions.update).not.toHaveBeenCalled();
  });

  it('keeps normal archive lifecycle updates available', async () => {
    const session = makeSession('session-a');
    mocks.sessions.getById.mockResolvedValue(session);
    mocks.sessions.update.mockResolvedValue({ ...session, status: 'archived' });

    const response = await createApp().request('/api/sessions/session-a', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'archived' }),
    });

    expect(response.status).toBe(200);
    expect(mocks.sessions.update).toHaveBeenCalledWith('session-a', { status: 'archived' });
  });
});

describe('GET /api/sessions list pagination metadata', () => {
  it('preserves the legacy response and exact database limit without page_meta=1', async () => {
    mocks.sessions.list.mockResolvedValue([makeSession('session-a'), makeSession('session-b')]);

    const response = await createApp().request('/api/sessions?limit=2&offset=3');
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).not.toHaveProperty('page');
    expect((body.sessions as Array<{ id: string }>).map((session) => session.id)).toEqual(['session-a', 'session-b']);
    expect(mocks.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 2,
        offset: 3,
      }),
    );
  });

  it('does not silently clamp the legacy Web history limit', async () => {
    const response = await createApp().request('/api/sessions?limit=500');

    expect(response.status).toBe(200);
    expect(mocks.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 500,
      }),
    );
  });

  it('derives the page cursor from trimmed base rows before enriching shared and organized sessions', async () => {
    mocks.sessions.list.mockResolvedValue([
      makeSession('base-a', 'owner', '2026-07-31T04:00:00.000Z'),
      makeSession('base-b', 'owner', '2026-07-31T03:00:00.000Z'),
      makeSession('lookahead', 'owner', '2026-07-31T02:00:00.000Z'),
    ]);
    mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['shared-old']);
    mocks.sessionGroups.getOrganizedSessionIds.mockResolvedValue(['organized-old']);
    mocks.sessions.listSharedWith.mockResolvedValue([
      makeSession('shared-old', 'another-user', '2026-07-31T01:00:00.000Z'),
    ]);
    mocks.sessions.getById.mockImplementation(async (id: string) => {
      if (id === 'organized-old') return makeSession(id, 'owner', '2026-07-31T00:00:00.000Z');
      return undefined;
    });

    const response = await createApp().request('/api/sessions?limit=2&offset=5&page_meta=1');
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>;
      page: { has_more: boolean; next_offset: number };
    };

    expect(response.status).toBe(200);
    expect(mocks.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 3,
        offset: 5,
      }),
    );
    expect(body.page).toEqual({
      has_more: true,
      next_offset: 7,
    });
    expect(body.sessions.map((session) => session.id)).toEqual(['base-a', 'base-b', 'shared-old', 'organized-old']);
    expect(body.sessions.map((session) => session.id)).not.toContain('lookahead');
    expect(mocks.sessionTags.getTagsBySessionIds).toHaveBeenCalledWith([
      'base-a',
      'base-b',
      'shared-old',
      'organized-old',
    ]);
  });

  it('advances by only the available base rows on the final page', async () => {
    mocks.sessions.list.mockResolvedValue([makeSession('base-last')]);
    mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['shared-old']);
    mocks.sessions.listSharedWith.mockResolvedValue([makeSession('shared-old', 'another-user')]);

    const response = await createApp().request('/api/sessions?limit=20&offset=40&page_meta=1');
    const body = (await response.json()) as {
      sessions: Array<{ id: string }>;
      page: { has_more: boolean; next_offset: number };
    };

    expect(response.status).toBe(200);
    expect(body.sessions).toHaveLength(2);
    expect(body.page).toEqual({
      has_more: false,
      next_offset: 41,
    });
  });

  it.each([
    ['limit', '0', 'limit must be a positive integer'],
    ['limit', '-1', 'limit must be a positive integer'],
    ['limit', '1.5', 'limit must be a positive integer'],
    ['limit', 'NaN', 'limit must be a positive integer'],
    ['offset', '-1', 'offset must be a non-negative integer'],
    ['offset', '1.5', 'offset must be a non-negative integer'],
    ['offset', 'NaN', 'offset must be a non-negative integer'],
    ['offset', '9007199254740992', 'offset must be a non-negative integer'],
  ])('rejects invalid %s=%s before querying the database', async (parameter, value, error) => {
    const response = await createApp().request(`/api/sessions?${parameter}=${value}&page_meta=1`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error });
    expect(mocks.sessions.list).not.toHaveBeenCalled();
  });

  it('clamps an oversized historical limit while keeping the request compatible', async () => {
    const response = await createApp().request('/api/sessions?limit=999999&offset=0&page_meta=1');

    expect(response.status).toBe(200);
    expect(mocks.sessions.list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 201,
        offset: 0,
      }),
    );
  });
});

describe('GET /api/sessions?scope=', () => {
  const superUser = { id: 'boss', role: 'super' as const };

  it('rejects an unknown scope before touching the database', async () => {
    const response = await createApp().request('/api/sessions?scope=everything');

    expect(response.status).toBe(400);
    expect(mocks.sessions.list).not.toHaveBeenCalled();
    expect(mocks.sessions.listSharedWith).not.toHaveBeenCalled();
  });

  it('denies scope=team to a non-super user instead of returning an empty page', async () => {
    const response = await createApp().request('/api/sessions?scope=team');

    expect(response.status).toBe(403);
    expect(mocks.sessions.list).not.toHaveBeenCalled();
  });

  it('pins scope=mine to the caller even for a super', async () => {
    await createApp(superUser).request('/api/sessions?scope=mine');

    expect(mocks.sessions.list).toHaveBeenCalledWith(expect.objectContaining({ userId: 'boss' }));
    expect(mocks.sessions.list).not.toHaveBeenCalledWith(expect.objectContaining({ excludeUserId: expect.anything() }));
  });

  it('keeps shared conversations out of scope=mine', async () => {
    mocks.sessions.list.mockResolvedValue([makeSession('own-one', 'owner')]);
    mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['shared-one']);

    const response = await createApp().request('/api/sessions?scope=mine');
    const body = (await response.json()) as { sessions: Array<{ id: string }> };

    expect(body.sessions.map((s) => s.id)).toEqual(['own-one']);
    expect(mocks.sessions.listSharedWith).not.toHaveBeenCalled();
  });

  it('still surfaces a pinned or filed conversation in scope=mine', async () => {
    mocks.sessions.list.mockResolvedValue([]);
    mocks.sessionGroups.getOrganizedSessionIds.mockResolvedValue(['filed-old']);
    mocks.sessions.getById.mockResolvedValue(makeSession('filed-old', 'owner'));

    const response = await createApp().request('/api/sessions?scope=mine');
    const body = (await response.json()) as { sessions: Array<{ id: string }> };

    expect(body.sessions.map((s) => s.id)).toEqual(['filed-old']);
  });

  it('excludes the caller by owner for scope=team, and skips the organized backfill', async () => {
    await createApp(superUser).request('/api/sessions?scope=team');

    expect(mocks.sessions.list).toHaveBeenCalledWith(expect.objectContaining({ excludeUserId: 'boss' }));
    expect(mocks.sessionGroups.getOrganizedSessionIds).not.toHaveBeenCalled();
  });

  it('reads scope=shared from the share query, not the owner query', async () => {
    mocks.sessions.listSharedWith.mockResolvedValue([makeSession('from-someone', 'another-user')]);

    const response = await createApp().request('/api/sessions?scope=shared&limit=10');
    const body = (await response.json()) as { sessions: Array<{ id: string; shared: boolean }> };

    expect(mocks.sessions.listSharedWith).toHaveBeenCalledWith('owner', expect.objectContaining({ limit: 10 }));
    expect(mocks.sessions.list).not.toHaveBeenCalled();
    expect(body.sessions.map((s) => s.id)).toEqual(['from-someone']);
  });

  it("names the owner on rows the caller doesn't own, and leaves their own rows bare", async () => {
    mocks.sessions.list.mockResolvedValue([makeSession('theirs', 'another-user'), makeSession('mine', 'boss')]);
    mocks.users.getById.mockResolvedValue({ id: 'another-user', nickname: 'Ada' });

    const response = await createApp(superUser).request('/api/sessions?scope=team');
    const body = (await response.json()) as { sessions: Array<{ id: string; owner_nickname?: string }> };

    expect(body.sessions.find((s) => s.id === 'theirs')?.owner_nickname).toBe('Ada');
    expect(body.sessions.find((s) => s.id === 'mine')).not.toHaveProperty('owner_nickname');
    expect(mocks.users.getById).toHaveBeenCalledTimes(1);
  });

  it('leaves the unscoped list on the legacy rule: a super sees every owner', async () => {
    await createApp(superUser).request('/api/sessions');

    expect(mocks.sessions.list).toHaveBeenCalledWith(expect.objectContaining({ userId: undefined }));
  });
});

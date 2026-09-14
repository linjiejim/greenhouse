/**
 * /api/chat persisted-session authorization regression tests.
 *
 * Session shares are read-only: a recipient may inspect the shared transcript
 * through /api/sessions, but may not continue it through /api/chat.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
import type { AuthUser } from '../../auth/token.js';
import type { AppEnv } from '../../app-env.js';
import type { ToolRegistry } from '../../agent.js';

const mocks = vi.hoisted(() => ({
  sessions: {
    getById: vi.fn(),
    addMessage: vi.fn(),
    buildChatMessages: vi.fn(),
    updateTitle: vi.fn(),
  },
  sessionShares: {
    getSharedSessionIds: vi.fn(),
  },
  customProfiles: {
    getById: vi.fn(),
  },
  users: {
    getById: vi.fn(),
  },
  usage: {
    countTodayMessages: vi.fn(),
    sumMonthTokens: vi.fn(),
  },
  generateSessionTitle: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return {
    ...actual,
    getDb: () => mocks,
  };
});

vi.mock('../../llm/title.js', () => ({
  generateSessionTitle: mocks.generateSessionTitle,
}));

import { createChatRoute, isTrustedEvalExecution } from '../chat.js';
import { canAccessSession, canWriteSession } from '../../sessions/access.js';

function makeSession(ownerId = 'owner'): SessionRow {
  return {
    id: 'session-1',
    title: 'Existing title',
    status: 'active',
    rating: null,
    comment: null,
    feedback: null,
    profile_id: 'team',
    user_id: ownerId,
    app_id: null,
    channel: 'web',
    parent_session_id: null,
    metadata: '{}',
    created_at: '2026-07-21T00:00:00.000Z',
    updated_at: '2026-07-21T00:00:00.000Z',
  };
}

describe('Eval execution provenance', () => {
  it('never lets a team-owned mutable session status select the Eval budget pool', () => {
    expect(isTrustedEvalExecution({ role: 'team' }, 'eval')).toBe(false);
    expect(isTrustedEvalExecution({ role: 'super' }, 'eval')).toBe(true);
    expect(isTrustedEvalExecution({ role: 'super' }, 'active')).toBe(false);
  });
});

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const id = c.req.header('x-user-id') ?? 'owner';
    const role = c.req.header('x-user-role') === 'super' ? 'super' : 'team';
    c.set('user', { id, role });
    return next();
  });
  app.route('/api/chat', createChatRoute({} as ToolRegistry));
  return app;
}

async function continueSession(app: ReturnType<typeof createApp>, user: AuthUser) {
  return app.request('/api/chat', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': user.id,
      'x-user-role': user.role,
    },
    body: JSON.stringify({
      session_id: 'session-1',
      messages: [{ role: 'user', content: 'Continue this session' }],
    }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.getById.mockResolvedValue(makeSession());
  mocks.sessions.addMessage.mockImplementation(async (input) => ({
    id: 'persisted-user-message',
    content: input.content,
  }));
  // Stop an authorized request before model/tool setup; reaching this read is
  // sufficient to prove it passed the session write gate.
  mocks.sessions.buildChatMessages.mockResolvedValue([]);
  mocks.sessions.updateTitle.mockResolvedValue(undefined);
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
  mocks.customProfiles.getById.mockResolvedValue(undefined);
  mocks.generateSessionTitle.mockResolvedValue('Generated title');
  mocks.users.getById.mockResolvedValue({
    id: 'owner',
    role: 'team',
    status: 'active',
    monthly_token_limit: 20_000_000,
  });
  mocks.usage.sumMonthTokens.mockResolvedValue(0);
});

describe('session access policy', () => {
  it('keeps shares read-only while allowing owner and super writes', async () => {
    const session = makeSession();
    const owner: AuthUser = { id: 'owner', role: 'team' };
    const other: AuthUser = { id: 'other', role: 'team' };
    const shared: AuthUser = { id: 'shared-reader', role: 'team' };
    const superUser: AuthUser = { id: 'admin', role: 'super' };

    mocks.sessionShares.getSharedSessionIds.mockImplementation(async (userId: string) =>
      userId === shared.id ? [session.id] : [],
    );

    await expect(canAccessSession(owner, session)).resolves.toBe(true);
    await expect(canAccessSession(other, session)).resolves.toBe(false);
    await expect(canAccessSession(shared, session)).resolves.toBe(true);
    await expect(canAccessSession(superUser, session)).resolves.toBe(true);

    expect(canWriteSession(owner, session)).toBe(true);
    expect(canWriteSession(other, session)).toBe(false);
    expect(canWriteSession(shared, session)).toBe(false);
    expect(canWriteSession(superUser, session)).toBe(true);
  });
});

describe('POST /api/chat session authorization', () => {
  it('rechecks custom-profile access when continuing an existing session', async () => {
    mocks.sessions.getById.mockResolvedValue({ ...makeSession(), profile_id: 'custom:7' });
    mocks.customProfiles.getById.mockResolvedValue({
      id: 7,
      user_id: 'profile-owner',
      is_shared: false,
    });

    const response = await continueSession(createApp(), { id: 'owner', role: 'team' });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: 'You do not have access to this custom profile',
    });
    expect(mocks.sessions.addMessage).not.toHaveBeenCalled();
    expect(mocks.sessions.buildChatMessages).not.toHaveBeenCalled();
  });

  it.each([
    ['another team user', { id: 'other', role: 'team' as const }],
    ['a read-only share recipient', { id: 'shared-reader', role: 'team' as const }],
  ])('rejects %s before reading or mutating session content', async (_label, user) => {
    // If the write gate regresses, this setup would make the route start its
    // asynchronous title update after loading the private transcript.
    mocks.sessions.getById.mockResolvedValue({ ...makeSession(), title: null });
    mocks.sessions.buildChatMessages.mockResolvedValue([{ role: 'user', content: 'Private transcript' }]);
    if (user.id === 'shared-reader') {
      mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['session-1']);
    }

    const response = await continueSession(createApp(), user);

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: 'Session not found' });
    expect(mocks.sessions.addMessage).not.toHaveBeenCalled();
    expect(mocks.sessions.buildChatMessages).not.toHaveBeenCalled();
    expect(mocks.generateSessionTitle).not.toHaveBeenCalled();
    expect(mocks.sessions.updateTitle).not.toHaveBeenCalled();
  });

  it.each([
    ['the owner', { id: 'owner', role: 'team' as const }],
    ['a super user', { id: 'admin', role: 'super' as const }],
  ])('allows %s to enter the session write path', async (_label, user) => {
    const response = await continueSession(createApp(), user);

    // The fake history is empty, so the route intentionally stops before any
    // model call after proving the caller passed the authorization boundary.
    expect(response.status).toBe(400);
    expect(mocks.sessions.addMessage).toHaveBeenCalledWith({
      session_id: 'session-1',
      role: 'user',
      content: 'Continue this session',
      images: undefined,
    });
    expect(mocks.sessions.buildChatMessages).toHaveBeenCalledWith('session-1');
  });

  it('does not consult or enforce the retired daily-message quota', async () => {
    mocks.users.getById.mockResolvedValue({
      id: 'owner',
      role: 'team',
      status: 'active',
      daily_message_limit: 0,
      monthly_token_limit: 20_000_000,
    });
    mocks.usage.countTodayMessages.mockResolvedValue(999);

    const response = await continueSession(createApp(), { id: 'owner', role: 'team' });

    expect(response.status).toBe(400);
    expect(mocks.usage.countTodayMessages).not.toHaveBeenCalled();
    expect(mocks.usage.sumMonthTokens).not.toHaveBeenCalled();
  });
});

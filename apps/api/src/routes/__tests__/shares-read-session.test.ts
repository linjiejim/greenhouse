/**
 * /api/shares/read-session — the web client fires this on every session open,
 * so "nothing is shared with you here" must be an ordinary success, not a 404.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  sessionShares: {
    markAllReadInSession: vi.fn(),
    countUnread: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => mocks };
});

import shareRoutes from '../shares.js';

function client() {
  return new Hono<AppEnv>()
    .use('*', async (c, next) => {
      c.set('user', { id: 'user-1', role: 'team', email: 'u@example.com' } as never);
      await next();
    })
    .route('/api/shares', shareRoutes);
}

async function readSession(sessionId: string) {
  return client().request('/api/shares/read-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId }),
  });
}

describe('POST /api/shares/read-session', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionShares.countUnread.mockResolvedValue(0);
  });

  it('succeeds when the session has nothing shared with this user', async () => {
    mocks.sessionShares.markAllReadInSession.mockResolvedValue(false);

    const res = await readSession('session-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('marks the shares read and refreshes the unread count when there are some', async () => {
    mocks.sessionShares.markAllReadInSession.mockResolvedValue(true);

    const res = await readSession('session-2');

    expect(res.status).toBe(200);
    expect(mocks.sessionShares.markAllReadInSession).toHaveBeenCalledWith('user-1', 'session-2');
    expect(mocks.sessionShares.countUnread).toHaveBeenCalledWith('user-1');
  });

  it('still rejects a request without a session', async () => {
    const res = await client().request('/api/shares/read-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });
});

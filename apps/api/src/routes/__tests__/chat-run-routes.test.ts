/**
 * /api/chat background-run endpoint tests — the 409 duplicate-send guard,
 * probe/list/stop authorization, and the reconnect stream's replay + live-tail
 * contract. The agent engine is never reached: runs are driven directly
 * through the registry singleton the route shares.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRow } from '@greenhouse/types/session';
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
  bots: {
    getBotById: vi.fn(),
    getByLegacyCustomId: vi.fn(),
    getVersion: vi.fn(),
    listBots: vi.fn(),
    createBot: vi.fn(),
  },
  users: {
    getById: vi.fn(),
  },
  usage: {
    sumMonthTokens: vi.fn(),
  },
}));

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return {
    ...actual,
    getDb: () => mocks,
  };
});

import { createChatRoute } from '../chat.js';
import { chatRunRegistry } from '../../chat/runs.js';

let seq = 0;
const uniqueSession = () => `run-route-${++seq}-${Math.random().toString(36).slice(2)}`;

function makeSession(id: string, ownerId = 'owner'): SessionRow {
  return {
    id,
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
  app.route('/api/chat', createChatRoute({} as ToolRegistry));
  return app;
}

const asUser = (id: string, role: 'team' | 'super' = 'team') => ({
  'x-user-id': id,
  'x-user-role': role,
});

function sproutyBot() {
  return {
    id: 'bot_0000000000000001',
    user_id: 'owner',
    name: 'Sprouty',
    name_key: 'sprouty',
    role: 'Main assistant',
    description: '',
    instructions: '',
    avatar: '{}',
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: 'sprouty',
    status: 'active',
    current_version: 1,
    legacy_custom_id: null,
    last_active_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sessions.addMessage.mockImplementation(async (input: { content: string }) => ({
    id: 'persisted-user',
    content: input.content,
  }));
  mocks.sessions.buildChatMessages.mockResolvedValue([]);
  mocks.sessions.updateTitle.mockResolvedValue(undefined);
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
  mocks.bots.getBotById.mockResolvedValue(undefined);
  mocks.bots.getByLegacyCustomId.mockResolvedValue(undefined);
  // The member's Sprouty Bot is the default identity (resolved per turn).
  mocks.bots.listBots.mockResolvedValue([sproutyBot()]);
  mocks.users.getById.mockResolvedValue({
    id: 'owner',
    role: 'team',
    status: 'active',
    monthly_token_limit: 20_000_000,
  });
});

describe('POST /api/chat duplicate-send guard', () => {
  it('409s while a run is active — before persisting the user message', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const run = chatRunRegistry.claim(sessionId, 'owner')!;

    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asUser('owner') },
      body: JSON.stringify({ session_id: sessionId, messages: [{ role: 'user', content: 'dup' }] }),
    });

    expect(response.status).toBe(409);
    expect(mocks.sessions.addMessage).not.toHaveBeenCalled();
    chatRunRegistry.finish(run, 'completed');
  });

  it('releases the claim when a pre-stream check fails, freeing the session', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    // Empty history → the route 400s AFTER claiming; the claim must be released.
    const response = await createApp().request('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...asUser('owner') },
      body: JSON.stringify({ session_id: sessionId, messages: [{ role: 'user', content: 'hello' }] }),
    });

    expect(response.status).toBe(400);
    expect(chatRunRegistry.getActive(sessionId)).toBeUndefined();
    expect(chatRunRegistry.claim(sessionId, 'owner')).not.toBeNull();
    chatRunRegistry.release(chatRunRegistry.getActive(sessionId)!);
  });
});

describe('GET /api/chat/runs/:sessionId (probe)', () => {
  it('404s for non-owners without leaking run existence', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const run = chatRunRegistry.claim(sessionId, 'owner')!;

    const response = await createApp().request(`/api/chat/runs/${sessionId}`, { headers: asUser('other') });
    expect(response.status).toBe(404);
    chatRunRegistry.finish(run, 'completed');
  });

  it('reports inactive when no run exists, active with seq while running', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const app = createApp();

    const none = await app.request(`/api/chat/runs/${sessionId}`, { headers: asUser('owner') });
    await expect(none.json()).resolves.toEqual({ active: false });

    const run = chatRunRegistry.claim(sessionId, 'owner')!;
    run.emit({ type: 'text-delta', text: 'a' });
    const active = await app.request(`/api/chat/runs/${sessionId}`, { headers: asUser('owner') });
    const body = (await active.json()) as { active: boolean; run: { next_seq: number; status: string } };
    expect(body.active).toBe(true);
    expect(body.run.status).toBe('running');
    expect(body.run.next_seq).toBe(1);

    chatRunRegistry.finish(run, 'completed');
    const retained = await app.request(`/api/chat/runs/${sessionId}`, { headers: asUser('owner') });
    const retainedBody = (await retained.json()) as { active: boolean; run: { status: string } };
    expect(retainedBody.active).toBe(false);
    expect(retainedBody.run.status).toBe('completed');
  });
});

describe('GET /api/chat/runs (list)', () => {
  it('returns only the caller’s running session runs', async () => {
    const mine = uniqueSession();
    const theirs = uniqueSession();
    const mineRun = chatRunRegistry.claim(mine, 'lister')!;
    const theirsRun = chatRunRegistry.claim(theirs, 'someone-else')!;

    const response = await createApp().request('/api/chat/runs', { headers: asUser('lister') });
    const body = (await response.json()) as { runs: Array<{ session_id: string }> };
    expect(body.runs.map((r) => r.session_id)).toContain(mine);
    expect(body.runs.map((r) => r.session_id)).not.toContain(theirs);

    chatRunRegistry.finish(mineRun, 'completed');
    chatRunRegistry.finish(theirsRun, 'completed');
  });
});

describe('POST /api/chat/runs/:sessionId/stop', () => {
  it('aborts the active run for the owner; 404 when idle or for non-owners', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const app = createApp();

    const idle = await app.request(`/api/chat/runs/${sessionId}/stop`, { method: 'POST', headers: asUser('owner') });
    expect(idle.status).toBe(404);

    const run = chatRunRegistry.claim(sessionId, 'owner')!;
    const foreign = await app.request(`/api/chat/runs/${sessionId}/stop`, {
      method: 'POST',
      headers: asUser('other'),
    });
    expect(foreign.status).toBe(404);
    expect(run.signal.aborted).toBe(false);

    const stopped = await app.request(`/api/chat/runs/${sessionId}/stop`, {
      method: 'POST',
      headers: asUser('owner'),
    });
    expect(stopped.status).toBe(200);
    expect(run.signal.aborted).toBe(true);
    expect(run.stopReason).toBe('user');
    chatRunRegistry.finish(run, 'error');
  });
});

describe('POST /api/chat/runs/:sessionId/interrupt', () => {
  const botsSession = (id: string, ownerId = 'owner'): SessionRow => ({ ...makeSession(id, ownerId), channel: 'bots' });
  const interrupt = (app: ReturnType<typeof createApp>, sessionId: string, user = asUser('owner')) =>
    app.request(`/api/chat/runs/${sessionId}/interrupt`, { method: 'POST', headers: user });

  it('asks the running Bots run to stop after its step: flagged, announced, nothing aborted', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(botsSession(sessionId));
    const run = chatRunRegistry.claim(sessionId, 'owner')!;
    const events: Array<Record<string, unknown>> = [];
    run.subscribe(-1, { onEvent: (event) => events.push(event), onEnd: () => undefined });

    const response = await interrupt(createApp(), sessionId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, run_id: run.runId });
    expect(run.interruptRequested).toBe(true);
    expect(run.signal.aborted).toBe(false);
    expect(events).toEqual([expect.objectContaining({ type: 'run-interrupting' })]);
    chatRunRegistry.finish(run, 'completed');
  });

  it('is the owner’s only — a super included — and 404s when nothing runs', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(botsSession(sessionId));
    const app = createApp();
    expect((await interrupt(app, sessionId)).status).toBe(404); // no run

    const run = chatRunRegistry.claim(sessionId, 'owner')!;
    for (const user of [asUser('other'), asUser('root', 'super')]) {
      const response = await interrupt(app, sessionId, user);
      expect(response.status).toBe(404);
    }
    expect(run.interruptRequested).toBe(false);

    mocks.sessions.getById.mockResolvedValue(undefined);
    expect((await interrupt(app, sessionId)).status).toBe(404);
    expect(run.interruptRequested).toBe(false);
    chatRunRegistry.finish(run, 'completed');
  });

  it('refuses any other conversation with not_supported (only the Bots engine stops at a step)', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const run = chatRunRegistry.claim(sessionId, 'owner')!;
    const response = await interrupt(createApp(), sessionId);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ code: 'not_supported' });
    expect(run.interruptRequested).toBe(false);
    chatRunRegistry.finish(run, 'completed');
  });
});

describe('GET /api/chat/runs/:sessionId/stream (reconnect)', () => {
  it('replays events after the requested seq, then tails live until the run ends', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const run = chatRunRegistry.claim(sessionId, 'owner')!;
    run.emit({ type: 'text-delta', text: 'old' }); // seq 0 — client already has it
    run.emit({ type: 'text-delta', text: 'replay-me' }); // seq 1

    const response = await createApp().request(`/api/chat/runs/${sessionId}/stream?after=0`, {
      headers: asUser('owner'),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/x-ndjson');

    // Give the streaming handler a beat to subscribe, then finish the run live.
    await new Promise((r) => setTimeout(r, 20));
    run.emit({ type: 'finish', finishReason: 'stop' }); // seq 2
    chatRunRegistry.finish(run, 'completed');

    const text = await response.text();
    const lines = text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>)
      .filter((e) => e.type !== 'ping');

    expect(lines.map((e) => e.seq)).toEqual([1, 2]);
    expect(lines[0]).toMatchObject({ type: 'text-delta', text: 'replay-me', replayed: true });
    expect(lines[1]).toMatchObject({ type: 'finish' });
    expect(lines[1]).not.toHaveProperty('replayed');
  });

  it('404s when there is nothing to attach to', async () => {
    const sessionId = uniqueSession();
    mocks.sessions.getById.mockResolvedValue(makeSession(sessionId));
    const response = await createApp().request(`/api/chat/runs/${sessionId}/stream`, { headers: asUser('owner') });
    expect(response.status).toBe(404);
  });
});

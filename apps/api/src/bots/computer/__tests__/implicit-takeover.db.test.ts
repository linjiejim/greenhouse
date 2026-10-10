/**
 * A voluntary take-over during a Bot's computer work, end to end against real
 * PostgreSQL (rolled back per test): the member presses "Take over" while the
 * Bot runs two commands at once, both are stopped, exactly one implicit
 * take-over card waits in the conversation, and the hand-back settles it and
 * wakes that Bot — the promise the stopped tool calls made. Docker and the
 * engine's single writer are recorded, not run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import type { InboxItem } from '../../engine/inbox-types.js';
import { testTurn } from '../../__tests__/helpers/turn.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(async () => ({ code: 0, stdout: Buffer.alloc(0), stderr: '' })),
  deliver: vi.fn<(sessionId: string, item: InboxItem) => Promise<void>>(async () => {}),
}));

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));
vi.mock('../runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../runtime.js')>()),
  requireComputerRuntime: () => ({
    controller: { ensureRunning: async () => ({ container_name: 'c-implicit', last_started_at: 't1' }) },
    host: { exec: mocks.exec },
    config: { proxy: null },
  }),
}));
vi.mock('../../engine/index.js', () => ({ deliverToConversation: mocks.deliver }));

import * as access from '../access.js';
import { defaultComputerDeps, type ComputerDeps } from '../browser-session.js';
import { HUMAN_WAIT_HOLD_MS } from '../limits.js';
import { handbackComputer, takeoverComputer } from '../lease.js';
import { computerTurnFrom } from '../tools.js';
import { runComputerAction } from '../../tools/computer.js';

let db: DatabaseProvider;
let user: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-implicit-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
    role: 'team',
  });
  await db.botComputers.ensure({
    user_id: user.id,
    namespace: 'implicittest',
    container_name: `gh-computer-implicittest-${user.id}`,
    volume_name: `gh-computer-implicittest-${user.id}-home`,
  });
  mocks.exec.mockClear();
  mocks.deliver.mockClear();
});

/** A Bot turn in the Bot's DM, wired to the real request store and the real lease. */
async function botTurn(bot: BotRow, sessionId: string) {
  const ctx = testTurn({
    db,
    userId: user.id,
    sessionId,
    bot,
    createRequest: async (kind, payload, opts) =>
      db.bots.createRequest({
        user_id: user.id,
        session_id: sessionId,
        bot_id: bot.id,
        kind,
        payload: payload as unknown as Record<string, unknown>,
        expires_at: opts?.expiresInMs ? new Date(Date.now() + opts.expiresInMs).toISOString() : null,
      }),
  });
  const started: string[] = [];
  const deps: ComputerDeps = {
    ...defaultComputerDeps,
    ensureReady: async () => undefined,
    touch: async () => undefined,
    redact: (_userId, text) => text,
    // A command that runs until it is killed — and then returns like a
    // finished one, as runShell does.
    exec: async (_userId, command, opts) => {
      started.push(command);
      await new Promise((resolve) => opts.signal?.addEventListener('abort', resolve, { once: true }));
      return { exitCode: null, stdout: 'partial', stderr: '', truncated: false, timedOut: false };
    },
  };
  return { ctx, turn: computerTurnFrom(ctx, deps), deps, started };
}

describe('implicit take-over', () => {
  it('a voluntary take-over during a Bot action leaves exactly one implicit card, and the hand-back wakes that Bot', async () => {
    const bot = await db.bots.createBot({ user_id: user.id, name: 'Scout', role: '' });
    const { session_id: sessionId } = await db.bots.ensureDirectConversation(user.id, bot.id);
    const { ctx, turn, deps, started } = await botTurn(bot, sessionId);

    // Two commands in one step (parallel tool calls), both running.
    const first = runComputerAction(turn, { action: 'shell', command: 'npm test' }, deps);
    const second = runComputerAction(turn, { action: 'shell', command: 'tail -f job.log' }, deps);
    await vi.waitFor(() => expect(started).toHaveLength(2));

    const takenAt = Date.now();
    await takeoverComputer(user.id); // the member presses "Take over"
    const results = await Promise.all([first, second]);
    for (const result of results) {
      expect(result).toMatchObject({ code: 'user_in_control' });
      expect(String(result.error)).toMatch(/woken automatically when they do/);
      expect(JSON.stringify(result)).not.toContain('partial');
    }
    expect(ctx.stopAfterStep).toHaveBeenCalledWith('takeover');

    const cards = await db.bots.listRequests(user.id, { sessionId, status: 'pending', kinds: ['takeover'] });
    expect(cards).toHaveLength(1);
    const card = cards[0]!;
    expect(card.bot_id).toBe(bot.id);
    expect(JSON.parse(card.payload)).toEqual({ implicit: true, reason: 'interrupted' });
    const expiresIn = Date.parse(card.expires_at!) - takenAt;
    expect(expiresIn).toBeGreaterThan(HUMAN_WAIT_HOLD_MS - 60_000);
    expect(expiresIn).toBeLessThanOrEqual(HUMAN_WAIT_HOLD_MS + 5_000);

    // The Bot tries again while the member still has the computer: same card.
    expect(await runComputerAction(turn, { action: 'shell', command: 'ls' }, deps)).toMatchObject({
      code: 'user_in_control',
    });
    expect(await db.bots.listRequests(user.id, { sessionId, status: 'pending', kinds: ['takeover'] })).toHaveLength(1);

    // "Done, hand back" from the conversation: the card is settled and Scout is woken, once.
    await handbackComputer(user.id, { sessionId });
    expect((await db.bots.getRequest(user.id, card.id))?.status).toBe('resolved');
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        kind: 'continue',
        botId: bot.id,
        event: expect.objectContaining({ request_id: card.id }),
      }),
    );
    expect((await access.currentLease(user.id)).controller).toBe('bot');
  });
});

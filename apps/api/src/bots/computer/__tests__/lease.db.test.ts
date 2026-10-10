/**
 * Take-over / hand-back against real PostgreSQL (rolled back per test): the
 * lease epoch, the Bot shell kill (gh-agent-kill, which spares background
 * jobs and terminals), the browser window brought back on every hand-back,
 * exactly-once settlement of the card the
 * member answered — never a card in another conversation — and exactly one
 * wake-up for the Bot that asked; the abandoned-viewer auto-release that never
 * resumes anyone; and typing that requires the lease. The engine's single
 * writer, the Docker client and the browser are recorded, not run.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import type { InboxItem } from '../../engine/inbox-types.js';

const mocks = vi.hoisted(() => ({
  exec: vi.fn(async () => ({ code: 0, stdout: Buffer.from('3\n'), stderr: '' })),
  getBrowser: vi.fn(),
  restoreWindow: vi.fn(async (_userId: string) => {}),
  deliver: vi.fn<(sessionId: string, item: InboxItem) => Promise<void>>(async () => {}),
}));

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));
vi.mock('../access.js', () => ({
  ensureComputerReady: async () => {},
  abortComputerActions: () => 0,
  getBrowser: mocks.getBrowser,
  rememberFilledSecret: vi.fn(),
  restoreBrowserWindow: mocks.restoreWindow,
}));
vi.mock('../runtime.js', () => ({ requireComputerRuntime: () => ({ host: { exec: mocks.exec } }) }));
vi.mock('../../engine/index.js', () => ({ deliverToConversation: mocks.deliver }));

import {
  ABANDONED_LEASE_MS,
  handbackComputer,
  handleTakeoverDecision,
  LeaseRequiredError,
  releaseAbandonedLeases,
  takeoverComputer,
  typeIntoFocusedField,
} from '../lease.js';

let db: DatabaseProvider;
let user: UserRow;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-lease-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
    role: 'team',
  });
  await db.botComputers.ensure({
    user_id: user.id,
    namespace: 'leasetest',
    container_name: `gh-computer-leasetest-${user.id}`,
    volume_name: `gh-computer-leasetest-${user.id}-home`,
  });
  mocks.exec.mockClear();
  mocks.getBrowser.mockClear();
  mocks.restoreWindow.mockClear();
  mocks.deliver.mockClear();
});

async function conversationWith(name: string): Promise<{ bot: BotRow; sessionId: string }> {
  const bot = await db.bots.createBot({ user_id: user.id, name, role: '' });
  const conversation = await db.bots.ensureDirectConversation(user.id, bot.id);
  return { bot, sessionId: conversation.session_id };
}

async function card(sessionId: string, bot: BotRow, kind: 'takeover' | 'login' = 'takeover') {
  return db.bots.createRequest({
    user_id: user.id,
    session_id: sessionId,
    bot_id: bot.id,
    kind,
    payload:
      kind === 'login' ? { reason: 'Sign in', origin: 'https://github.com' } : { reason: 'CAPTCHA', kind: 'captcha' },
  });
}

const lease = async () => (await db.botComputers.get(user.id))!;

describe('take-over and hand-back', () => {
  it('bumps the epoch, kills the Bot shell once, and wakes the asking Bot exactly once on hand-back', async () => {
    const { bot, sessionId } = await conversationWith('Scout');
    const request = await card(sessionId, bot);
    const before = await lease();

    await takeoverComputer(user.id);
    expect(await lease()).toMatchObject({ lease_controller: 'user', lease_epoch: before.lease_epoch + 1 });
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    // Not `pkill -u agent`: background jobs and the member's terminals survive a take-over.
    expect(mocks.exec).toHaveBeenCalledWith(expect.objectContaining({ user: 'agent', argv: ['gh-agent-kill'] }));
    await takeoverComputer(user.id); // already theirs: nothing more
    expect(mocks.exec).toHaveBeenCalledTimes(1);
    expect(mocks.restoreWindow).not.toHaveBeenCalled();

    await handbackComputer(user.id, { note: 'done  \n ok', requestId: request.id });
    expect(await lease()).toMatchObject({ lease_controller: 'bot', lease_epoch: before.lease_epoch + 2 });
    expect(mocks.restoreWindow).toHaveBeenCalledWith(user.id); // the Bot gets its window back
    const settled = await db.bots.getRequest(user.id, request.id);
    expect(settled?.status).toBe('resolved');
    expect(JSON.parse(settled!.result!)).toEqual({ by: 'member', note: 'done ok' });
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const [deliveredTo, item] = mocks.deliver.mock.calls[0]!;
    expect(deliveredTo).toBe(sessionId);
    expect(item).toMatchObject({ kind: 'continue', botId: bot.id, event: { kind: 'takeover_done' } });
    expect(item.kind === 'continue' && item.note).toMatch(/handed it back.*done ok/);

    await handbackComputer(user.id, { requestId: request.id }); // a double click
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
  });

  it('settles a named secure sign-in card too, and wakes its Bot', async () => {
    const { bot, sessionId } = await conversationWith('Operator');
    const login = await card(sessionId, bot, 'login');
    await takeoverComputer(user.id);
    await handbackComputer(user.id, { requestId: login.id });
    expect((await db.bots.getRequest(user.id, login.id))?.status).toBe('resolved');
    expect(mocks.deliver).toHaveBeenCalledWith(sessionId, expect.objectContaining({ kind: 'continue', botId: bot.id }));
  });

  it('never resolves a card in another conversation, and only the single one waiting in the member’s', async () => {
    const a = await conversationWith('Researcher');
    const b = await conversationWith('Operator');
    const captcha = await card(a.sessionId, a.bot);

    // A voluntary take-over in B (just to stop that Bot), then hand back: A's card stays.
    await takeoverComputer(user.id);
    await handbackComputer(user.id, {});
    await takeoverComputer(user.id);
    await handbackComputer(user.id, { sessionId: b.sessionId });
    expect((await db.bots.getRequest(user.id, captcha.id))?.status).toBe('pending');
    // A card id from another conversation than the one the member says they are in.
    await handbackComputer(user.id, { requestId: captcha.id, sessionId: b.sessionId });
    expect((await db.bots.getRequest(user.id, captcha.id))?.status).toBe('pending');
    expect(mocks.deliver).not.toHaveBeenCalled();

    // In A, the one card waiting there is the one the hand-back answers.
    await takeoverComputer(user.id);
    await handbackComputer(user.id, { sessionId: a.sessionId });
    expect((await db.bots.getRequest(user.id, captcha.id))?.status).toBe('resolved');
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(mocks.deliver).toHaveBeenCalledWith(a.sessionId, expect.objectContaining({ botId: a.bot.id }));

    // Two Bots waiting in one conversation: ambiguous, so nothing is guessed.
    const second = await conversationWith('Writer');
    const one = await card(second.sessionId, second.bot);
    const two = await card(second.sessionId, second.bot, 'login');
    await handbackComputer(user.id, { sessionId: second.sessionId });
    expect((await db.bots.getRequest(user.id, one.id))?.status).toBe('pending');
    expect((await db.bots.getRequest(user.id, two.id))?.status).toBe('pending');
  });
});

describe('take-over card decisions', () => {
  it('skip denies the card with the skipped note, and a stale double submit delivers once', async () => {
    const { bot, sessionId } = await conversationWith('Scout');
    const request = await card(sessionId, bot);
    await takeoverComputer(user.id);
    await handleTakeoverDecision({ userId: user.id, request, decision: { decision: 'deny' } });
    await handleTakeoverDecision({ userId: user.id, request, decision: { decision: 'deny' } });
    expect((await db.bots.getRequest(user.id, request.id))?.status).toBe('denied');
    expect(mocks.restoreWindow).toHaveBeenCalledTimes(1); // only the decision that moved the lease
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const item = mocks.deliver.mock.calls[0]![1];
    expect(item.kind === 'continue' && item.note).toMatch(/skipped your take-over request/);
  });
});

describe('abandoned take-overs', () => {
  it('hands the computer back after 3 minutes without viewers, records an event, and resumes nobody', async () => {
    const { bot, sessionId } = await conversationWith('Scout');
    const request = await card(sessionId, bot);
    await takeoverComputer(user.id);
    const since = Date.parse((await lease()).lease_since!);

    // A take-over that just started (no heartbeat yet) is left alone.
    await releaseAbandonedLeases(since + 1_000);
    expect((await lease()).lease_controller).toBe('user');
    expect(mocks.deliver).not.toHaveBeenCalled();

    await releaseAbandonedLeases(since + ABANDONED_LEASE_MS + 1_000);
    expect((await lease()).lease_controller).toBe('bot');
    expect(mocks.restoreWindow).toHaveBeenCalledWith(user.id);
    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const [deliveredTo, item] = mocks.deliver.mock.calls[0]!;
    expect(deliveredTo).toBe(sessionId);
    expect(item).toMatchObject({ kind: 'event', event: { kind: 'takeover_released', request_id: request.id } });
    expect((await db.bots.getRequest(user.id, request.id))?.status).toBe('pending');
  });
});

describe('typing during a take-over', () => {
  it('requires the lease and bounds the text, without touching the browser otherwise', async () => {
    await expect(typeIntoFocusedField(user.id, 'hello')).rejects.toBeInstanceOf(LeaseRequiredError);
    await expect(typeIntoFocusedField(user.id, '')).rejects.toBeInstanceOf(RangeError);
    await expect(typeIntoFocusedField(user.id, 'x'.repeat(10_001))).rejects.toBeInstanceOf(RangeError);
    expect(mocks.getBrowser).not.toHaveBeenCalled();
  });
});

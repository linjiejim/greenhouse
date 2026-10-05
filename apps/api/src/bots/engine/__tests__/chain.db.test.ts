/**
 * Bots runs against real PostgreSQL with a scripted model (design review
 * R4/R5/R13): one run persists several Bot turns with distinct rows, a
 * hand-off writes its line and ends the asker's turn, the owner's follow-up
 * may skip, a member message queued mid-chain interrupts it, a Bot failure is
 * contained, a foreign write stops the chain — and every run ends with exactly
 * one `finish`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetProvider,
  createDatabase,
  initDatabase,
  type BotRow,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { chatRunRegistry, type ChatRunEvent } from '../../../chat/runs.js';
import { runBotsRun, type ChainTrigger } from '../chain.js';
import { setBotsEngineDepsForTest } from '../deps.js';
import {
  _resetInboxStateForTest,
  deliverToConversation,
  drainIdleConversation,
  setInboxToolRegistry,
  sweepInboxes,
} from '../inbox.js';
import { claimBotsRun, releaseBotsRun } from '../run-slot.js';
import { scriptedDeps, type BotScript, type CapturedTurn } from './scripted-model.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let user: UserRow;
let restoreDeps: (() => void) | null = null;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-chain-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
    role: 'team',
  });
  await db.users.update(user.id, { locale: 'zh' });
});

afterEach(() => {
  restoreDeps?.();
  restoreDeps = null;
  setInboxToolRegistry(null);
  _resetInboxStateForTest();
  vi.restoreAllMocks();
});

async function bot(name: string, role = ''): Promise<BotRow> {
  return db.bots.createBot({ user_id: user.id, name, role });
}

interface RunOutcome {
  events: ChatRunEvent[];
  captured: CapturedTurn[];
}

async function runWith(
  sessionId: string,
  script: BotScript,
  trigger: ChainTrigger,
  hooks: { onTurn?: (turn: CapturedTurn) => Promise<void> } = {},
): Promise<RunOutcome> {
  const captured: CapturedTurn[] = [];
  const deps = scriptedDeps(script, captured);
  const createStream = deps.createStream!;
  restoreDeps = setBotsEngineDepsForTest({
    ...deps,
    createStream: async (input) => {
      const result = await createStream(input);
      await hooks.onTurn?.(captured[captured.length - 1]!);
      return result;
    },
  });
  const run = chatRunRegistry.claim(sessionId, user.id);
  expect(run).not.toBeNull();
  const events: ChatRunEvent[] = [];
  run!.subscribe(-1, { onEvent: (event) => events.push(event), onEnd: () => undefined });
  const latest = await db.sessions.getLatestMessage(sessionId);
  await runBotsRun({
    run: run!,
    userId: user.id,
    sessionId,
    toolRegistry: {},
    trigger,
    triggerKey: latest?.id ?? 'none',
    db,
  });
  return { events, captured };
}

async function say(sessionId: string, content: string) {
  return db.sessions.addMessage({ session_id: sessionId, role: 'user', content });
}

function botEvents(events: ChatRunEvent[]) {
  return events
    .filter(
      (e) => e.type === 'bot-turn-start' || e.type === 'bot-turn-end' || e.type === 'finish' || e.type === 'error',
    )
    .map((e) => {
      if (e.type === 'bot-turn-start') return `start:${String(e.bot_id)}:${String(e.reason)}`;
      if (e.type === 'bot-turn-end') return `end:${String(e.bot_id)}:${String(e.status)}${e.message_id ? ':msg' : ''}`;
      return String(e.type);
    });
}

const userTrigger: ChainTrigger = { kind: 'message', reason: 'user', mentions: [] };

describe('Bots runs', () => {
  it('a DM: the owner Bot answers once, persisted under its bot_id, one finish', async () => {
    const ivy = await bot('Ivy', 'Chief of staff');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'Plan my week');

    const { events, captured } = await runWith(dm.session_id, { Ivy: [[{ text: 'Here is your week.' }]] }, userTrigger);

    expect(botEvents(events)).toEqual([`start:${ivy.id}:user`, `end:${ivy.id}:completed:msg`, 'finish']);
    expect(events.some((e) => e.type === 'text-delta' && e.text === 'Here is your week.')).toBe(true);
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.map((r) => [r.role, r.bot_id ?? null, r.content])).toEqual([
      ['user', null, 'Plan my week'],
      ['assistant', ivy.id, 'Here is your week.'],
    ]);
    // Prompt layout: identity in system, member line tagged, tail last.
    const input = captured[0]!.input;
    expect(input.systemPrompt).toContain('You are **Ivy** — Chief of staff. You work for Jim.');
    const last = input.messages[input.messages.length - 1]!;
    expect(last.role).toBe('user');
    expect(String(last.content)).toMatch(/^\[Jim（用户）]: Plan my week/);
    expect(String(last.content)).toContain("Reply to Jim's latest message.");
    expect(input.maxStepsOverride).toBe(30);
  });

  it('a group hand-off: line persisted, asker stops after the step, B answers, owner follow-up skips', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern', 'Writer');
    const group = await db.bots.createGroupConversation({
      user_id: user.id,
      bot_ids: [ivy.id, fern.id],
      title: 'Launch',
    });
    await say(group.session_id, 'We need a tagline');

    const { events, captured } = await runWith(
      group.session_id,
      {
        Ivy: [
          [
            {
              text: 'Fern is better at this.',
              toolCalls: [
                {
                  toolName: 'team',
                  input: { action: 'ask', bot_id: fern.id, message: 'Draft a tagline for the launch' },
                },
              ],
            },
            { text: 'SHOULD NOT APPEAR' },
          ],
          [{ text: '<<skip>>' }],
        ],
        Fern: [[{ text: 'Grow together.' }]],
      },
      userTrigger,
    );

    expect(botEvents(events)).toEqual([
      `start:${ivy.id}:user`,
      `end:${ivy.id}:completed:msg`,
      `start:${fern.id}:ask`,
      `end:${fern.id}:completed:msg`,
      `start:${ivy.id}:followup`,
      `end:${ivy.id}:skipped`,
      'finish',
    ]);
    expect(events.find((e) => e.type === 'bot-turn-start' && e.bot_id === fern.id)?.asked_by).toBe(ivy.id);
    // The skip token never reaches the member.
    expect(events.some((e) => e.type === 'text-delta' && String(e.text).includes('<<skip>>'))).toBe(false);

    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.map((r) => [r.role, r.bot_id ?? null])).toEqual([
      ['user', null],
      ['system', ivy.id],
      ['assistant', ivy.id],
      ['assistant', fern.id],
    ]);
    expect(JSON.parse(rows[1]!.bot_event!)).toEqual({ kind: 'ask', from: ivy.id, to: fern.id });
    expect(rows[1]!.content).toBe('Ivy → @Fern：Draft a tagline for the launch');
    expect(rows.some((r) => r.content.includes('SHOULD NOT APPEAR'))).toBe(false);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);

    // Fern sees the hand-off as an untrusted Bot message, and Ivy's words tagged.
    const fernTurn = captured.find((t) => t.bot === 'Fern')!.input;
    const fernTail = String(fernTurn.messages.at(-1)!.content);
    expect(fernTail).toContain('<bot_message from="Ivy" untrusted="true">');
    expect(fernTail).toContain('[Ivy（Bot）]: Fern is better at this.');
    expect(fernTurn.maxStepsOverride).toBe(12);
    const followup = captured.filter((t) => t.bot === 'Ivy')[1]!.input;
    expect(followup.maxStepsOverride).toBe(4);
    expect(String(followup.messages.at(-1)!.content)).toContain('Fern answered above');
  });

  it('a member message queued mid-chain drops the rest of the queue and starts a new chain in the same run', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, fern.id] });
    await say(group.session_id, 'Write a tagline');

    const { events } = await runWith(
      group.session_id,
      {
        Ivy: [
          [{ toolCalls: [{ toolName: 'team', input: { action: 'ask', bot_id: fern.id, message: 'tagline please' } }] }],
          [{ text: 'Switching to the new request.' }],
        ],
        Fern: [[{ text: 'Grow together.' }]],
      },
      userTrigger,
      {
        onTurn: async (turn) => {
          // While Fern works, the member sends another message (the route queues it: 202).
          if (turn.bot === 'Fern') {
            await deliverToConversation(group.session_id, {
              kind: 'user_message',
              content: 'Actually, a slogan',
              mentions: [],
            });
          }
        },
      },
    );

    expect(botEvents(events)).toEqual([
      `start:${ivy.id}:user`,
      `end:${ivy.id}:completed`, // only the hand-off: no extra row
      `start:${fern.id}:ask`,
      `end:${fern.id}:completed:msg`,
      `start:${ivy.id}:interjection`,
      `end:${ivy.id}:completed:msg`,
      'finish',
    ]);
    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.map((r) => [r.role, r.bot_id ?? null, r.content])).toEqual([
      ['user', null, 'Write a tagline'],
      ['system', ivy.id, 'Ivy → @Fern：tagline please'],
      ['assistant', fern.id, 'Grow together.'],
      ['user', null, 'Actually, a slogan'],
      ['assistant', ivy.id, 'Switching to the new request.'],
    ]);
    expect(await db.bots.listPendingInbox(group.session_id)).toHaveLength(0);
  });

  it('a failing Bot ends its turn with an error line; the run still ends with one finish', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'hi');

    const { events } = await runWith(dm.session_id, { Ivy: [[{ fail: 'provider exploded' }]] }, userTrigger);

    expect(botEvents(events)).toEqual([`start:${ivy.id}:user`, `end:${ivy.id}:error`, 'finish']);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.role).toBe('system');
    expect(JSON.parse(rows[1]!.bot_event!)).toMatchObject({ kind: 'turn_error', bot_id: ivy.id });
    expect(rows[1]!.content).not.toContain('provider exploded');
  });

  it('a foreign write under the single writer stops the chain instead of interleaving', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'hi');

    const { events } = await runWith(dm.session_id, { Ivy: [[{ text: 'answer' }]] }, userTrigger, {
      onTurn: async () =>
        void (await db.sessions.addMessage({ session_id: dm.session_id, role: 'assistant', content: 'rogue' })),
    });

    const finish = events.filter((e) => e.type === 'finish');
    expect(finish).toHaveLength(1);
    expect(finish[0]!.finishReason).toBe('error');
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.map((r) => r.content)).toEqual(['hi', 'rogue']);
  });

  it('a server-initiated continue wakes the Bot and writes its event line first', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'Log in for me');
    await db.bots.enqueueInbox(dm.session_id, 'continue', {
      kind: 'continue',
      botId: ivy.id,
      note: 'The member handed the computer back.',
      eventText: 'Jim handed the computer back',
      event: { kind: 'takeover_done', request_id: null, bot_id: ivy.id },
    });

    const { events, captured } = await runWith(
      dm.session_id,
      { Ivy: [[{ text: 'Continuing.' }]] },
      { kind: 'continue', items: [] },
    );

    expect(botEvents(events)).toEqual([`start:${ivy.id}:continue`, `end:${ivy.id}:completed:msg`, 'finish']);
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.map((r) => r.role)).toEqual(['user', 'system', 'assistant']);
    expect(String(captured[0]!.input.messages.at(-1)!.content)).toContain('The member handed the computer back.');
  });
});

describe('single-writer delivery', () => {
  it('queues while a run holds the slot, then writes when idle — reports exactly once', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'start a task');

    const busy = chatRunRegistry.claim(dm.session_id, user.id)!;
    const report = {
      kind: 'task_report' as const,
      botId: ivy.id,
      runId: 'run-1',
      title: 'Check links',
      status: 'succeeded' as const,
      report: 'All 12 links work.',
    };
    await deliverToConversation(dm.session_id, report);
    expect(await db.sessions.getMessageCount(dm.session_id)).toBe(1);
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(1);

    chatRunRegistry.release(busy);
    expect(await drainIdleConversation(dm.session_id, db)).toBe(true);
    // A repeated delivery (at-least-once producer) does not duplicate the row.
    await deliverToConversation(dm.session_id, report);

    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ role: 'assistant', bot_id: ivy.id, content: 'All 12 links work.' });
    expect(JSON.parse(rows[1]!.bot_event!)).toMatchObject({
      kind: 'task_report',
      run_id: 'run-1',
      status: 'succeeded',
    });
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
  });
});

/** Wait until no run holds the conversation's slot (a server-initiated run finished). */
async function settled(sessionId: string) {
  for (let i = 0; i < 200 && chatRunRegistry.getActive(sessionId); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(chatRunRegistry.getActive(sessionId)).toBeUndefined();
}

describe('the roster is live during a run', () => {
  it('a Bot invited mid-run can be addressed by a queued message right away', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern', 'Writer');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id] });
    await say(group.session_id, 'Research the market');

    const { events } = await runWith(
      group.session_id,
      { Ivy: [[{ text: 'Browsing…' }]], Fern: [[{ text: 'Intro drafted.' }]] },
      userTrigger,
      {
        onTurn: async (turn) => {
          if (turn.bot !== 'Ivy') return;
          // The member clicks "+ Invite" and then writes to the new Bot (202 queued).
          await db.bots.addMember(user.id, group.session_id, fern.id, 'user');
          await deliverToConversation(group.session_id, {
            kind: 'event',
            text: 'Fern joined the conversation',
            event: { kind: 'joined', bot_id: fern.id, by: 'user' },
          });
          await deliverToConversation(group.session_id, {
            kind: 'user_message',
            content: '@Fern draft an intro meanwhile',
            mentions: [fern.id],
          });
        },
      },
    );

    expect(botEvents(events)).toEqual([
      `start:${ivy.id}:user`,
      `end:${ivy.id}:completed:msg`,
      `start:${fern.id}:interjection`,
      `end:${fern.id}:completed:msg`,
      'finish',
    ]);
  });

  it('a Bot created mid-run is a valid hand-off target for the proposer’s continue turn', async () => {
    const ivy = await bot('Ivy');
    const sage = await bot('Sage');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, sage.id] });
    await say(group.session_id, 'Get this researched and written up');
    let clover: BotRow | null = null;

    const { events } = await runWith(
      group.session_id,
      {
        Ivy: [[{ text: 'Sage is on it.' }]],
        Sage: [
          [{ text: 'Starting.' }],
          [
            {
              toolCalls: [
                { toolName: 'team', input: { action: 'ask', bot_id: 'Clover', message: 'Crunch these numbers' } },
              ],
            },
          ],
          [{ text: '<<skip>>' }],
        ],
        Clover: [[{ text: 'Numbers crunched.' }]],
      },
      { kind: 'message', reason: 'user', mentions: [ivy.id, sage.id] },
      {
        onTurn: async (turn) => {
          if (turn.bot !== 'Ivy') return;
          // The member confirms Sage's earlier proposal while Ivy is still talking:
          // decideBotCreate creates the Bot, adds it and wakes the proposer.
          clover = await bot('Clover', 'Analyst');
          await db.bots.addMember(user.id, group.session_id, clover.id, `bot:${sage.id}`);
          await deliverToConversation(group.session_id, {
            kind: 'continue',
            botId: sage.id,
            note: 'Clover joined; hand it the numbers.',
            eventText: 'Clover joined at Sage’s invitation',
            event: { kind: 'joined', bot_id: clover.id, by: 'bot', by_bot_id: sage.id },
          });
        },
      },
    );

    expect(clover).not.toBeNull();
    const cloverId = clover!.id;
    expect(botEvents(events)).toEqual([
      `start:${ivy.id}:mention`,
      `end:${ivy.id}:completed:msg`,
      `start:${sage.id}:mention`,
      `end:${sage.id}:completed:msg`,
      `start:${sage.id}:continue`,
      `end:${sage.id}:completed`,
      `start:${cloverId}:ask`,
      `end:${cloverId}:completed:msg`,
      `start:${sage.id}:followup`,
      `end:${sage.id}:skipped`,
      'finish',
    ]);
    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.some((r) => r.content.includes('→ @Clover'))).toBe(true);
  });

  it('switching Bot chat off mid-run refuses the next hand-off', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern');
    const sage = await bot('Sage');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, fern.id, sage.id] });
    await say(group.session_id, 'Both of you, please');

    const { events } = await runWith(
      group.session_id,
      {
        Ivy: [[{ text: 'My part.' }]],
        Fern: [
          [
            { toolCalls: [{ toolName: 'team', input: { action: 'ask', bot_id: sage.id, message: 'help' } }] },
            { text: 'Doing it myself then.' },
          ],
        ],
      },
      { kind: 'message', reason: 'user', mentions: [ivy.id, fern.id] },
      {
        onTurn: async (turn) => {
          if (turn.bot === 'Ivy')
            await db.bots.updateConversation(user.id, group.session_id, { allow_bot_chat: false });
        },
      },
    );

    expect(botEvents(events).some((e) => e.startsWith(`start:${sage.id}`))).toBe(false);
    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.some((r) => r.bot_event?.includes('"kind":"ask"'))).toBe(false);
    const fernRow = rows.find((r) => r.bot_id === fern.id && r.role === 'assistant')!;
    expect(fernRow.pipeline).toContain('switched off');
  });

  it('a Bot removed mid-run does not take its queued turn', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, fern.id] });
    await say(group.session_id, 'Both of you');

    const { events } = await runWith(
      group.session_id,
      { Ivy: [[{ text: 'Mine.' }]], Fern: [[{ text: 'SHOULD NOT SPEAK' }]] },
      { kind: 'message', reason: 'user', mentions: [ivy.id, fern.id] },
      {
        onTurn: async (turn) => {
          if (turn.bot === 'Ivy') await db.bots.removeMember(user.id, group.session_id, fern.id);
        },
      },
    );

    expect(botEvents(events)).toEqual([`start:${ivy.id}:mention`, `end:${ivy.id}:completed:msg`, 'finish']);
  });
});

describe('inbox: claim-then-apply', () => {
  it('a failed apply leaves the item queued and the run going; the next drain writes it once', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'hi');
    await db.bots.enqueueInbox(dm.session_id, 'event', {
      kind: 'event',
      text: 'Jim handed the computer back',
      event: { kind: 'takeover_done', request_id: null, bot_id: ivy.id },
    });
    vi.spyOn(db.sessions, 'appendIfTail').mockRejectedValueOnce(new Error('pool timeout'));

    const { events } = await runWith(dm.session_id, { Ivy: [[{ text: 'Hello.' }]] }, userTrigger);

    const finish = events.filter((e) => e.type === 'finish');
    expect(finish).toHaveLength(1);
    expect(finish[0]!.finishReason).toBe('stop');
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.map((r) => r.content)).toEqual(['hi', 'Hello.', 'Jim handed the computer back']);
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
  });

  it('quarantines a poison item after repeated failures instead of retrying forever', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'hi');
    const poison = await db.bots.enqueueInbox(dm.session_id, 'event', {
      kind: 'event',
      text: 'poison',
      event: { kind: 'digest', upto_seq: 0 },
    });
    await db.bots.enqueueInbox(dm.session_id, 'bogus' as never, { kind: 'mismatch' });
    vi.spyOn(db.sessions, 'appendIfTail').mockRejectedValue(new Error('row too large'));

    for (let i = 0; i < 5; i += 1) await drainIdleConversation(dm.session_id, db);

    // Both left the queue (the poison one after its 5th failure, the malformed one at once)
    // without being written; the failures were counted on the row itself.
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
    expect(await db.sessions.getMessageCount(dm.session_id)).toBe(1);
    expect(poison.id).toBeGreaterThan(0);
  });

  it('a second task report for the same task is dropped, even with different content', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'run a task');
    const report = (status: 'succeeded' | 'canceled', text: string) => ({
      kind: 'task_report' as const,
      botId: ivy.id,
      runId: 'run-dup',
      title: 'Check links',
      status,
      report: text,
    });
    await deliverToConversation(dm.session_id, report('succeeded', 'All 12 links work.'));

    // The reaper's late "canceled" lands while a chain is live: ignored, the run is not failed.
    const { events } = await runWith(dm.session_id, { Ivy: [[{ text: 'Noted.' }]] }, userTrigger, {
      onTurn: async () => deliverToConversation(dm.session_id, report('canceled', 'The task was canceled.')),
    });

    expect(events.filter((e) => e.type === 'finish')[0]!.finishReason).toBe('stop');
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.filter((r) => r.bot_event?.includes('task_report')).map((r) => r.content)).toEqual([
      'All 12 links work.',
    ]);
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
  });

  it('a member Stop records a queued wake-up but never runs it', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'log in for me');

    const { events } = await runWith(dm.session_id, { Ivy: [[{ text: 'On it.' }]] }, userTrigger, {
      onTurn: async () => {
        await deliverToConversation(dm.session_id, {
          kind: 'continue',
          botId: ivy.id,
          note: 'The member handed the computer back.',
          eventText: 'Jim handed the computer back',
          event: { kind: 'takeover_done', request_id: null, bot_id: ivy.id },
        });
        chatRunRegistry.getActive(dm.session_id)!.requestStop('user');
      },
    });

    expect(events.filter((e) => e.type === 'bot-turn-start')).toHaveLength(1);
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
    // Nothing is left for the sweeper to wake the Bot with.
    setInboxToolRegistry({});
    expect(await drainIdleConversation(dm.session_id, db)).toBe(false);
    expect(chatRunRegistry.getActive(dm.session_id)).toBeUndefined();
    const rows = await db.sessions.getMessages(dm.session_id);
    const events2 = rows.map((r) => (r.bot_event ? (JSON.parse(r.bot_event) as { kind: string }).kind : null));
    expect(events2).toContain('takeover_done');
    expect(events2).toContain('stopped');
  });

  it('a member message queued before Stop stays queued and is answered right after', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'first');
    setInboxToolRegistry({}); // server-initiated runs can start

    await runWith(dm.session_id, { Ivy: [[{ text: 'Working.' }], [{ text: 'Answering the second.' }]] }, userTrigger, {
      onTurn: async (turn) => {
        if (turn.input.messages.some((m) => String(m.content).includes('second'))) return;
        await deliverToConversation(dm.session_id, { kind: 'user_message', content: 'second', mentions: [] });
        chatRunRegistry.getActive(dm.session_id)!.requestStop('user');
      },
    });

    // The stopped run does not answer it; the run right after does, without waiting for a sweep.
    await vi.waitFor(async () => {
      const rows = await db.sessions.getMessages(dm.session_id);
      expect(rows.slice(-2).map((r) => [r.role, r.content])).toEqual([
        ['user', 'second'],
        ['assistant', 'Answering the second.'],
      ]);
    });
    await settled(dm.session_id);
    expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0);
  });

  it('an interjection carries a wake-up drained in the same pass into the new chain', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, fern.id] });
    await say(group.session_id, 'start');

    const { events } = await runWith(
      group.session_id,
      { Ivy: [[{ text: 'Started.' }], [{ text: 'Sure, switching.' }]], Fern: [[{ text: 'Resuming my task.' }]] },
      userTrigger,
      {
        onTurn: async (turn) => {
          if (turn.bot !== 'Ivy' || turn.input.messages.some((m) => String(m.content).includes('new request'))) return;
          await deliverToConversation(group.session_id, {
            kind: 'continue',
            botId: fern.id,
            note: 'The member handed the computer back.',
            eventText: 'Jim handed the computer back',
            event: { kind: 'takeover_done', request_id: null, bot_id: fern.id },
          });
          await deliverToConversation(group.session_id, { kind: 'user_message', content: 'new request', mentions: [] });
        },
      },
    );

    expect(botEvents(events)).toEqual([
      `start:${ivy.id}:user`,
      `end:${ivy.id}:completed:msg`,
      `start:${ivy.id}:interjection`,
      `end:${ivy.id}:completed:msg`,
      `start:${fern.id}:continue`,
      `end:${fern.id}:completed:msg`,
      'finish',
    ]);
    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.filter((r) => r.content === 'Jim handed the computer back')).toHaveLength(1);
    expect(await db.bots.listPendingInbox(group.session_id)).toHaveLength(0);
  });
});

describe('nobody can answer', () => {
  it('a DM whose owner was archived gets a line, not silence', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await say(dm.session_id, 'are you there?');
    await db.bots.archiveBot(user.id, ivy.id);

    const { events } = await runWith(dm.session_id, { Ivy: [[{ text: 'SHOULD NOT SPEAK' }]] }, userTrigger);

    expect(botEvents(events)).toEqual(['finish']);
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows).toHaveLength(2);
    expect(JSON.parse(rows[1]!.bot_event!)).toEqual({ kind: 'unavailable', bot_id: ivy.id, reason: 'archived' });
  });
});

describe('follow-up skip token', () => {
  it('a follow-up that used a tool and then said <<skip>> never shows or stores the token', async () => {
    const ivy = await bot('Ivy');
    const fern = await bot('Fern');
    const group = await db.bots.createGroupConversation({ user_id: user.id, bot_ids: [ivy.id, fern.id] });
    await say(group.session_id, 'tagline?');

    const { events } = await runWith(
      group.session_id,
      {
        Ivy: [
          [{ toolCalls: [{ toolName: 'team', input: { action: 'ask', bot_id: fern.id, message: 'tagline' } }] }],
          [{ toolCalls: [{ toolName: 'conversation', input: { action: 'notes' } }] }, { text: '<<skip>>' }],
        ],
        Fern: [[{ text: 'Grow together.' }]],
      },
      userTrigger,
    );

    expect(events.some((e) => e.type === 'text-delta' && String(e.text).includes('<<skip>>'))).toBe(false);
    const rows = await db.sessions.getMessages(group.session_id);
    expect(rows.some((r) => r.content.includes('<<skip>>'))).toBe(false);
  });
});

describe('who may run a conversation', () => {
  it('never claims a conversation whose owner is suspended or mid-reset; answers once active again', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    await db.bots.enqueueInbox(dm.session_id, 'user_message', { kind: 'user_message', content: 'hi', mentions: [] });
    restoreDeps = setBotsEngineDepsForTest(scriptedDeps({ Ivy: [[{ text: 'Back again.' }]] }));
    setInboxToolRegistry({});

    for (const status of ['disabled', 'reset_required'] as const) {
      await db.users.update(user.id, { status });
      expect(await drainIdleConversation(dm.session_id, db)).toBe(false);
      await sweepInboxes(db);
      await sweepInboxes(db);
      expect(chatRunRegistry.getActive(dm.session_id)).toBeUndefined();
      expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(1);
      expect(await db.bots.listSessionsWithPendingInbox(500)).not.toContain(dm.session_id);
    }

    await db.users.update(user.id, { status: 'active' });
    expect(await db.bots.listSessionsWithPendingInbox(500)).toContain(dm.session_id);
    await sweepInboxes(db);
    await vi.waitFor(async () => expect(await db.bots.listPendingInbox(dm.session_id)).toHaveLength(0));
    await settled(dm.session_id);
    const rows = await db.sessions.getMessages(dm.session_id);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'Back again.'],
    ]);
  });

  it('a conversation run by another API process is never opened a second time', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    // Two "slots", each with its own pool and run lock (the test transaction
    // has no pool of its own to lock on, so both stand outside it).
    const slotA = createDatabase(TEST_DATABASE_URL);
    const slotB = createDatabase(TEST_DATABASE_URL);
    try {
      expect(await slotB.bots.tryLockConversationRun(dm.session_id)).toBe(true);
      // Slot A's sweeper / chat route cannot claim it: nothing runs, nothing stays claimed.
      expect(await claimBotsRun(slotA, dm.session_id, user.id)).toBeNull();
      expect(chatRunRegistry.getActive(dm.session_id)).toBeUndefined();

      await slotB.bots.unlockConversationRun(dm.session_id);
      const run = await claimBotsRun(slotA, dm.session_id, user.id);
      expect(run).not.toBeNull();
      expect(await slotB.bots.tryLockConversationRun(dm.session_id)).toBe(false);
      await releaseBotsRun(slotA, run!);
      expect(chatRunRegistry.getActive(dm.session_id)).toBeUndefined();
      // Released by slot A: slot B can take it again.
      expect(await slotB.bots.tryLockConversationRun(dm.session_id)).toBe(true);
      await slotB.bots.unlockConversationRun(dm.session_id);
    } finally {
      await slotA.close();
      await slotB.close();
    }
  });
});

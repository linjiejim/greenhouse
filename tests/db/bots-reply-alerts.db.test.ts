/**
 * The Bots reads behind mobile push (docs/specs/20261010-mobile-push.md §2.1, §3.4):
 * - `listMissedReplies` — the reply-alert sweep's work list: a finished Bot reply
 *   nobody read between 60 s and 30 min ago, no pending card, no alert yet, never a
 *   background-task report;
 * - `attentionCount` — the app icon badge: conversations with a pending card or an
 *   unread Bot line (the drawer ☰ rule).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  _resetProvider,
  botsReplyDedupeKey,
  initDatabase,
  type BotRow,
  type DatabaseProvider,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let user: UserRow;

const TASK_REPORT_PREFIX = 'bot-task-report:';
const MINUTE = 60_000;

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, { email: `${unique('reply-alerts')}@test.local` });
});

afterEach(() => {
  _resetProvider();
});

async function dm(name: string): Promise<{ bot: BotRow; sid: string }> {
  const bot = await db.bots.createBot({ user_id: user.id, name });
  const conversation = await db.bots.ensureDirectConversation(user.id, bot.id);
  return { bot, sid: conversation.session_id };
}

/** The member says something, the Bot answers, the run ends (stamps the activity). Returns the reply id. */
async function exchange(sid: string, bot: BotRow, opts: { replyId?: string } = {}): Promise<string> {
  await db.sessions.addMessage({ session_id: sid, role: 'user', content: 'Find me three vendors' });
  await tick();
  const input = { session_id: sid, role: 'assistant' as const, content: 'Here are three vendors…', bot_id: bot.id };
  const reply = opts.replyId
    ? await db.sessions.addMessageOnce(opts.replyId, input)
    : await db.sessions.addMessage(input);
  await tick();
  await db.bots.touchActivity(sid);
  return reply.id;
}

function missed(at: number) {
  return db.bots
    .listMissedReplies({ quietMs: MINUTE, windowMs: 30 * MINUTE, skipMessageIdPrefix: TASK_REPORT_PREFIX, now: at })
    .then((rows) => rows.filter((row) => row.user_id === user.id));
}

describe('missed Bot replies (the reply-alert sweep)', () => {
  it('lists a finished reply nobody read once it is a minute old, and only until 30 minutes', async () => {
    const { bot, sid } = await dm('Sage');
    const replyId = await exchange(sid, bot);
    expect(await missed(Date.now())).toEqual([]); // still within the minute
    expect(await missed(Date.now() + 2 * MINUTE)).toEqual([
      { session_id: sid, user_id: user.id, message_id: replyId, bot_id: bot.id },
    ]);
    expect(await missed(Date.now() + 31 * MINUTE)).toEqual([]); // too old: no backfill
  });

  it('skips a reply that was read, a conversation with a pending card, or a reply already alerted', async () => {
    const read = await dm('Ivy');
    await exchange(read.sid, read.bot);
    await tick();
    await db.bots.markRead(user.id, read.sid);

    const waiting = await dm('Fern');
    await exchange(waiting.sid, waiting.bot);
    await db.bots.createRequest({
      user_id: user.id,
      session_id: waiting.sid,
      bot_id: waiting.bot.id,
      kind: 'approval',
      payload: { title: 'Allow Fern to edit the knowledge base?' },
    });

    const alerted = await dm('Clover');
    const alertedReply = await exchange(alerted.sid, alerted.bot);
    await db.notifications.create({
      user_id: user.id,
      kind: 'bots_reply',
      title: 'Clover',
      body: 'Open the conversation to read it.',
      dedupe_key: botsReplyDedupeKey(alerted.sid, alertedReply),
    });

    expect(await missed(Date.now() + 2 * MINUTE)).toEqual([]);
  });

  it('waits for the chain to finish, ignores task reports and the member’s own last word', async () => {
    // a reply newer than the activity stamp belongs to a chain that is still going
    const running = await dm('Maple');
    await db.bots.touchActivity(running.sid);
    await tick();
    await db.sessions.addMessage({
      session_id: running.sid,
      role: 'assistant',
      content: 'Working on it',
      bot_id: running.bot.id,
    });

    const report = await dm('Lavender');
    await exchange(report.sid, report.bot, { replyId: `${TASK_REPORT_PREFIX}${unique('run')}` });

    const mine = await dm('Sunflower');
    await exchange(mine.sid, mine.bot);
    await db.sessions.addMessage({ session_id: mine.sid, role: 'user', content: 'Thanks!' });
    await tick();
    await db.bots.touchActivity(mine.sid);

    expect(await missed(Date.now() + 2 * MINUTE)).toEqual([]);
  });
});

describe('the attention count (app icon badge)', () => {
  it('counts conversations with a pending card or an unread Bot line', async () => {
    const card = await dm('Sage');
    await db.bots.createRequest({
      user_id: user.id,
      session_id: card.sid,
      bot_id: card.bot.id,
      kind: 'login',
      payload: { origin: 'https://example.com' },
    });
    const unread = await dm('Ivy');
    await exchange(unread.sid, unread.bot);
    const read = await dm('Fern');
    await exchange(read.sid, read.bot);
    await tick();
    await db.bots.markRead(user.id, read.sid);
    const quiet = await dm('Clover');
    await db.sessions.addMessage({ session_id: quiet.sid, role: 'user', content: 'Hello?' });

    expect(await db.bots.attentionCount(user.id)).toBe(2);
    const other = await createInternalTestUser(db, { email: `${unique('reply-alerts-other')}@test.local` });
    expect(await db.bots.attentionCount(other.id)).toBe(0);
  });
});

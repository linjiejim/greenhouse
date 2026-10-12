/**
 * Task chats on the Agents engine (spec 20261011-agent-first-class §5a, D20–D25) against real
 * PostgreSQL with a scripted model: as many as the member opens per Agent (the DM stays one),
 * listed with the chats and not the threads, the chat's own model and wording, a title from the
 * first message, rewind (edit / answer again) that cuts the transcript and the digest, and a
 * `task_start` card in `chat` mode that opens one and starts it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { chatRunRegistry } from '../../../chat/runs.js';
import { runBotsRun, type ChainTrigger } from '../chain.js';
import { setBotsEngineDepsForTest } from '../deps.js';
import { _resetInboxStateForTest, setInboxToolRegistry } from '../inbox.js';
import { RewindError, startBotsRewind } from '../index.js';
import { decideBotRequest } from '../requests.js';
import { claimBotsRun } from '../run-slot.js';
import { scriptedDeps, type BotScript, type CapturedTurn } from './scripted-model.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));
// The test environment configures no chat models: allow one for the chat's picker.
vi.mock('../../../config/models.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../config/models.js')>();
  return { ...actual, isChatModelAllowed: (id: string) => id === 'pro' || actual.isChatModelAllowed(id) };
});

let db: DatabaseProvider;
let user: UserRow;
let restoreDeps: (() => void) | null = null;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-task-chats-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
    role: 'team',
  });
});

afterEach(() => {
  restoreDeps?.();
  restoreDeps = null;
  setInboxToolRegistry(null);
  _resetInboxStateForTest();
  vi.restoreAllMocks();
});

async function bot(name: string): Promise<BotRow> {
  return db.bots.createBot({ user_id: user.id, name, role: '' });
}

function useScript(script: BotScript, captured: CapturedTurn[], titles: string[] = []) {
  restoreDeps = setBotsEngineDepsForTest({
    ...scriptedDeps(script, captured),
    generateTitle: async (message) => {
      titles.push(message);
      return `Title: ${message.slice(0, 20)}`;
    },
  });
}

async function runOnce(sessionId: string, trigger: ChainTrigger = { kind: 'message', reason: 'user', mentions: [] }) {
  const run = chatRunRegistry.claim(sessionId, user.id)!;
  const latest = await db.sessions.getLatestMessage(sessionId);
  await runBotsRun({ run, userId: user.id, sessionId, toolRegistry: {}, trigger, triggerKey: latest!.id, db });
}

/** Wait for detached work (a rewind's run, the title) to settle. */
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition never held');
}

describe('task chats', () => {
  it('opens many per Agent, keeps the one DM, and lists them apart from the threads', async () => {
    const ivy = await bot('Ivy');
    const dm = await db.bots.ensureDirectConversation(user.id, ivy.id);
    const first = await db.bots.createTaskConversation(user.id, ivy.id, { title: 'Budget' });
    const second = await db.bots.createTaskConversation(user.id, ivy.id);
    expect(first.kind).toBe('task');
    expect(second.session_id).not.toBe(first.session_id);
    // The DM is still the DM: a task chat with the same owner never answers for it.
    expect((await db.bots.ensureDirectConversation(user.id, ivy.id)).session_id).toBe(dm.session_id);

    expect((await db.bots.listConversations(user.id)).map((c) => c.session_id)).toEqual([dm.session_id]);
    expect(
      (await db.bots.listConversations(user.id, 100, { kinds: ['task'] })).map((c) => c.session_id).sort(),
    ).toEqual([first.session_id, second.session_id].sort());

    // The chats list carries them only when asked, DMs never.
    const plain = await db.sessions.list({ userId: user.id, excludeChannels: ['bots', 'workflow'] });
    expect(plain.map((s) => s.id)).not.toContain(first.session_id);
    const withChats = await db.sessions.list({
      userId: user.id,
      excludeChannels: ['bots', 'workflow'],
      includeAgentChats: true,
    });
    expect(withChats.map((s) => s.id)).toEqual(expect.arrayContaining([first.session_id, second.session_id]));
    expect(withChats.map((s) => s.id)).not.toContain(dm.session_id);

    // Model and title live on the chat; the title on its session too.
    await db.bots.updateTaskConversation(user.id, first.session_id, { modelId: 'pro', title: 'Q4 budget' });
    expect((await db.bots.getConversation(user.id, first.session_id))?.model_id).toBe('pro');
    expect((await db.sessions.getById(first.session_id))?.title).toBe('Q4 budget');
    // A DM has neither.
    expect(await db.bots.updateTaskConversation(user.id, dm.session_id, { title: 'x' })).toBeUndefined();
  });

  it('answers with the chat’s model and the separate-chat wording, and names itself from the first message', async () => {
    const ivy = await bot('Ivy');
    const chat = await db.bots.createTaskConversation(user.id, ivy.id, { modelId: 'pro' });
    await db.sessions.addMessage({ session_id: chat.session_id, role: 'user', content: 'Compare the two vendors' });
    const captured: CapturedTurn[] = [];
    const titles: string[] = [];
    useScript({ Ivy: [[{ text: 'Vendor A is cheaper.' }]] }, captured, titles);

    await runOnce(chat.session_id);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.input.modelOverride).toBe('pro');
    expect(captured[0]!.input.systemPrompt).toContain('This is a separate chat');
    await eventually(async () => Boolean((await db.bots.getConversation(user.id, chat.session_id))?.title));
    expect(titles).toEqual(['Compare the two vendors']);
    expect((await db.sessions.getById(chat.session_id))?.title).toBe('Title: Compare the two vend');
  });

  it('rewinds: an edit replaces the last message and everything after it, then answers again', async () => {
    const ivy = await bot('Ivy');
    const chat = await db.bots.createTaskConversation(user.id, ivy.id, { title: 'Draft' });
    await db.sessions.addMessage({ session_id: chat.session_id, role: 'user', content: 'Write a haiku' });
    const captured: CapturedTurn[] = [];
    useScript({ Ivy: [[{ text: 'First haiku' }], [{ text: 'Second haiku' }], [{ text: 'Third haiku' }]] }, captured);
    await runOnce(chat.session_id);
    const [member] = (await db.sessions.getMessages(chat.session_id)).filter((row) => row.role === 'user');

    const session = (await db.sessions.getById(chat.session_id))!;
    const authUser = { id: user.id, role: user.role } as never;
    // Regenerate: same words, a new answer in place of the old one.
    const again = (await claimBotsRun(db, chat.session_id, user.id))!;
    await startBotsRewind({ authUser, session, toolRegistry: {}, run: again, messageId: member!.id, db });
    await eventually(async () => !chatRunRegistry.getActive(chat.session_id));
    let rows = await db.sessions.getMessages(chat.session_id);
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['user', 'Write a haiku'],
      ['assistant', 'Second haiku'],
    ]);

    // Edit: new words.
    const edit = (await claimBotsRun(db, chat.session_id, user.id))!;
    await startBotsRewind({
      authUser,
      session,
      toolRegistry: {},
      run: edit,
      messageId: member!.id,
      content: 'Write a limerick',
      db,
    });
    await eventually(async () => !chatRunRegistry.getActive(chat.session_id));
    rows = await db.sessions.getMessages(chat.session_id);
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['user', 'Write a limerick'],
      ['assistant', 'Third haiku'],
    ]);
    expect(captured.map((turn) => JSON.stringify(turn.input.messages))).toEqual([
      expect.stringContaining('Write a haiku'),
      expect.stringContaining('Write a haiku'),
      expect.stringContaining('Write a limerick'),
    ]);

    // Only the last member message can be rewound.
    await db.sessions.addMessage({ session_id: chat.session_id, role: 'user', content: 'And another' });
    const stale = (await claimBotsRun(db, chat.session_id, user.id))!;
    await expect(
      startBotsRewind({ authUser, session, toolRegistry: {}, run: stale, messageId: member!.id, db }),
    ).rejects.toBeInstanceOf(RewindError);
  });

  it('a chat-mode task card opens a separate chat that starts with the approved brief', async () => {
    const sprouty = await bot('Sprouty');
    const quill = await bot('Quill');
    const main = await db.bots.ensureDirectConversation(user.id, sprouty.id);
    const request = await db.bots.createRequest({
      user_id: user.id,
      session_id: main.session_id,
      bot_id: sprouty.id,
      kind: 'task_start',
      payload: {
        title: 'Draft the launch post',
        brief: 'Write a 300-word launch post.',
        mode: 'chat',
        agent_id: quill.id,
      },
    });
    const captured: CapturedTurn[] = [];
    useScript({ Quill: [[{ text: 'Here is a draft.' }]] }, captured);
    setInboxToolRegistry({});

    const settled = await decideBotRequest(user.id, request.id, { decision: 'approve' }, db);

    const chatId = (JSON.parse(settled.result ?? '{}') as { conversation_id?: string }).conversation_id!;
    const chat = await db.bots.getConversation(user.id, chatId);
    expect(chat).toMatchObject({ kind: 'task', owner_bot_id: quill.id, title: 'Draft the launch post' });
    await eventually(async () =>
      (await db.sessions.getMessages(chatId)).some((row) => row.role === 'assistant' && row.bot_id === quill.id),
    );
    const rows = await db.sessions.getMessages(chatId);
    expect(rows.map((row) => [row.role, row.content])).toEqual([
      ['system', expect.stringContaining('Sprouty')],
      ['user', 'Write a 300-word launch post.'],
      ['assistant', 'Here is a draft.'],
    ]);
    expect(JSON.parse(rows[0]!.bot_event!)).toEqual({
      kind: 'chat_origin',
      from_session_id: main.session_id,
      bot_id: sprouty.id,
    });
    // Where it was proposed: a line that links to the new chat.
    await eventually(async () =>
      (await db.sessions.getMessages(main.session_id)).some((row) => row.bot_event?.includes('chat_opened')),
    );
    const line = (await db.sessions.getMessages(main.session_id)).find((row) => row.bot_event?.includes('chat_opened'));
    expect(JSON.parse(line!.bot_event!)).toEqual({
      kind: 'chat_opened',
      session_id: chatId,
      bot_id: quill.id,
      title: 'Draft the launch post',
    });
  });
});

/**
 * 飞书里找任意一个 Agent（spec 20261011-agent-first-class P6, D54），真 PostgreSQL + 脚本模型：
 * `/agents` 列表、`@名字` 把这串话题交给那个 Agent（Agents 引擎里的任务会话，第一行写来源）、
 * 之后不带 @ 也继续找它、群里别人的消息进不了这段私密对话、不带 @ 的新话题照旧走主 Agent。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import type { AgentGenerateArgs } from '../../../agent-runtime/run-agent.js';
import { setBotsEngineDepsForTest } from '../../../bots/engine/deps.js';
import { _resetInboxStateForTest } from '../../../bots/engine/inbox.js';
import { scriptedDeps } from '../../../bots/engine/__tests__/scripted-model.js';
import { dispatchFeishuMessage, type FeishuIncomingMessage } from '../dispatch.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));

let db: DatabaseProvider;
let jim: UserRow;
let ana: UserRow;
let jimOpenId: string;
let anaOpenId: string;
let restoreDeps: (() => void) | null = null;
const seen: AgentGenerateArgs[] = [];

async function bind(user: UserRow, openId: string) {
  await db.providerTokens.upsert({
    user_id: user.id,
    provider: 'feishu',
    workspace_id: null,
    provider_user_id: openId,
    access_token: null,
  });
}

function message(openId: string, text: string, refs: Partial<FeishuIncomingMessage> = {}): FeishuIncomingMessage {
  return {
    message_id: `om_${Date.now()}_${Math.random()}`,
    open_id: openId,
    chat_id: 'oc_route',
    chat_type: 'p2p',
    text,
    ...refs,
  };
}

const deps = () => ({
  db,
  toolRegistry: {},
  // The default path (no @): the single-agent runner, stubbed.
  generate: async (args: AgentGenerateArgs) => {
    seen.push(args);
    return { text: '主 Agent 的回答', usage: { inputTokens: 1, outputTokens: 1 }, steps: [] };
  },
});

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const stamp = `${Date.now()}-${Math.random()}`;
  jim = await createInternalTestUser(db, { email: `fs-jim-${stamp}@test.local`, nickname: 'Jim', role: 'team' });
  ana = await createInternalTestUser(db, { email: `fs-ana-${stamp}@test.local`, nickname: 'Ana', role: 'team' });
  jimOpenId = `ou_jim_${stamp}`;
  anaOpenId = `ou_ana_${stamp}`;
  await bind(jim, jimOpenId);
  await bind(ana, anaOpenId);
  await db.bots.createBot({ user_id: jim.id, name: 'Ivy', role: 'Researcher' });
  seen.length = 0;
  restoreDeps = setBotsEngineDepsForTest({
    ...scriptedDeps({ Ivy: [[{ text: 'Vendor B fits.' }], [{ text: 'It costs 3k.' }]] }, []),
    generateTitle: async (text) => `Title: ${text.slice(0, 20)}`,
  });
});

afterEach(() => {
  restoreDeps?.();
  restoreDeps = null;
  _resetInboxStateForTest();
});

describe('feishu → any Agent', () => {
  it('lists the Agents the member can reach', async () => {
    const reply = await dispatchFeishuMessage(message(jimOpenId, '/agents'), deps());
    expect(reply.kind).toBe('markdown');
    expect(reply.content).toContain('**Ivy**');
    expect(reply.content).toContain('（主 Agent）');
    expect(seen).toHaveLength(0);
  });

  it('@name hands the thread to that Agent, which keeps answering it; others cannot get in', async () => {
    const root = message(jimOpenId, '@Ivy which vendor fits?', { chat_type: 'group' });
    const first = await dispatchFeishuMessage(root, deps());
    expect(first.content).toContain('Vendor B fits.');
    expect(first.content).toContain('— Ivy');
    expect(first.content).toContain('以 Jim 的权限查询'); // the group footer names whose permissions
    const mapping = await db.feishuBot.findConversation(root.message_id);
    const session = await db.sessions.getById(mapping!.session_id);
    expect(session).toMatchObject({ channel: 'bots', user_id: jim.id });
    const page = await db.sessions.getMessagePage(session!.id, { limit: 10 });
    expect(page.messages.map((m) => [m.role, m.content])).toEqual([
      ['system', 'Started from Feishu'],
      ['user', 'which vendor fits?'],
      ['assistant', 'Vendor B fits.'],
    ]);

    // A reply in the same thread, no @: still Ivy, same conversation.
    const followUp = await dispatchFeishuMessage(
      message(jimOpenId, 'how much?', { root_id: root.message_id, chat_type: 'group' }),
      deps(),
    );
    expect(followUp.content).toContain('It costs 3k.');
    expect((await db.feishuBot.findConversation(root.message_id))!.session_id).toBe(session!.id);

    // Someone else in the group thread: never into Jim's private Agent conversation.
    const intruder = await dispatchFeishuMessage(
      message(anaOpenId, 'me too', { root_id: root.message_id, chat_type: 'group' }),
      deps(),
    );
    expect(intruder.kind).toBe('guidance');
    expect(intruder.content).toContain('私密对话');
    expect((await db.sessions.getMessagePage(session!.id, { limit: 20 })).messages).toHaveLength(5);
    expect(seen).toHaveLength(0);
  });

  it('a new thread without @ still goes to the main Agent on the single-agent runner', async () => {
    const reply = await dispatchFeishuMessage(message(jimOpenId, '@nobody hello'), deps());
    expect(reply.content).toContain('主 Agent 的回答');
    expect(seen).toHaveLength(1);
  });

  it('@name with nothing after it asks what to say', async () => {
    const reply = await dispatchFeishuMessage(message(jimOpenId, '@Ivy'), deps());
    expect(reply.content).toContain('想对 **Ivy** 说什么');
  });
});

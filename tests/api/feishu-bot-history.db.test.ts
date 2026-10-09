/**
 * 飞书「回复即延续」必须延续**上下文**，不只是延续 session。
 *
 * 2026-10-09 之前，dispatch 把第二问落进了同一个 session，但 headless runner
 * 只把当前这一条发给模型——模型看不见第一问，用户在飞书里「接着问」等于重新问。
 * 这里在真数据库上跑两轮 dispatch（第二条是对第一条的回复，root_id 相同），
 * 用 generate 测试缝截下模型实际收到的消息。
 */

import { describe, it, expect, beforeEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import { dispatchFeishuMessage, type FeishuIncomingMessage } from '../../apps/api/src/feishu/bot/dispatch.js';
import type { AgentGenerateArgs } from '../../apps/api/src/agent-runtime/run-agent.js';

let db: DatabaseProvider;
let owner: UserRow;
let openId: string;

function message(overrides: Partial<FeishuIncomingMessage>): FeishuIncomingMessage {
  return {
    message_id: `om_${Date.now()}_${Math.random()}`,
    root_id: null,
    parent_id: null,
    thread_id: null,
    open_id: openId,
    chat_id: 'oc_history',
    chat_type: 'p2p',
    text: '',
    ...overrides,
  };
}

describe('feishu bot multi-turn context', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `feishu-history-${Date.now()}-${Math.random()}@test.local` });
    openId = `ou_history_${Date.now()}_${Math.random()}`;
    await db.providerTokens.upsert({
      user_id: owner.id,
      provider: 'feishu',
      workspace_id: null,
      provider_user_id: openId,
      access_token: null,
    });
  });

  it('a reply in the same chain sends the earlier turns to the model, oldest first', async () => {
    const seen: AgentGenerateArgs[] = [];
    const answers = ['蓝色方案的预算是 120 万。', '它比绿色方案贵 20 万。'];
    const generate = async (args: AgentGenerateArgs) => {
      seen.push(args);
      return { text: answers[seen.length - 1]!, usage: { inputTokens: 10, outputTokens: 5 }, steps: [] };
    };

    const first = message({ text: '蓝色方案的预算是多少？' });
    const firstReply = await dispatchFeishuMessage(first, { db, toolRegistry: {}, generate });
    expect(firstReply.kind).toBe('markdown');

    // The user answers with Feishu's「回复」: the event carries the chain's root.
    const second = message({ text: '它和绿色方案比呢？', root_id: first.message_id, parent_id: first.message_id });
    await dispatchFeishuMessage(second, { db, toolRegistry: {}, generate });

    expect(seen).toHaveLength(2);
    // First turn: nothing before it.
    expect(seen[0]!.messages.map((m) => m.role)).toEqual(['user']);
    // Second turn: the whole conversation, the current question last.
    expect(seen[1]!.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', '蓝色方案的预算是多少？'],
      ['assistant', '蓝色方案的预算是 120 万。'],
      ['user', '它和绿色方案比呢？'],
    ]);
    // Earlier turns keep their timestamps so the loop can date them like chat does.
    expect(seen[1]!.messages[0]!.created_at).toBeTruthy();
  });

  it('a new conversation (no root) starts clean', async () => {
    const seen: AgentGenerateArgs[] = [];
    const generate = async (args: AgentGenerateArgs) => {
      seen.push(args);
      return { text: 'ok', usage: { inputTokens: 1, outputTokens: 1 }, steps: [] };
    };

    await dispatchFeishuMessage(message({ text: '第一串' }), { db, toolRegistry: {}, generate });
    await dispatchFeishuMessage(message({ text: '另一串' }), { db, toolRegistry: {}, generate });

    expect(seen.map((args) => args.messages.length)).toEqual([1, 1]);
  });
});

/**
 * One received Feishu message, end to end on PostgreSQL with fake Feishu
 * senders and a stubbed model (spec 20261009 D8):
 *   - a placeholder card goes out at once, step progress updates it, and the
 *     answer REPLACES it — no second message;
 *   - when the card cannot be sent or updated, the answer still arrives as a
 *     plain reply (the pre-card behaviour);
 *   - a re-delivery of the same message under a NEW message_id runs nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';
import {
  feishuLogicalKey,
  handleFeishuMessage,
  type FeishuMessageEvent,
  type FeishuSenders,
} from '../../apps/api/src/feishu/bot/client.js';
import type { AgentGenerateArgs } from '../../apps/api/src/agent-runtime/run-agent.js';

let db: DatabaseProvider;
let owner: UserRow;
let openId: string;

interface Call {
  kind: 'reply' | 'patch' | 'dm';
  target: string;
  content: string;
  updatable?: boolean;
}

function fakeSenders(opts: { replyOk?: boolean; patchOk?: boolean } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const senders: FeishuSenders = {
    reply: async (target, content, o) => {
      calls.push({ kind: 'reply', target, content, ...(o?.updatable ? { updatable: true } : {}) });
      return opts.replyOk === false
        ? { ok: false, error: '99991672 no permission' }
        : { ok: true, messageId: `om_bot_${++n}` };
    },
    patch: async (target, content) => {
      calls.push({ kind: 'patch', target, content });
      return opts.patchOk === false ? { ok: false, error: '230020 rate limited' } : { ok: true };
    },
    dm: async (target, content) => {
      calls.push({ kind: 'dm', target, content });
      return { ok: true };
    },
  };
  return { senders, calls };
}

function event(overrides: Partial<NonNullable<FeishuMessageEvent['message']>> = {}): FeishuMessageEvent {
  return {
    sender: { sender_id: { open_id: openId } },
    message: {
      message_id: `om_user_${Date.now()}_${Math.random()}`,
      chat_id: 'oc_flow',
      chat_type: 'p2p',
      message_type: 'text',
      content: JSON.stringify({ text: '帮我查一下订单 A-1001' }),
      create_time: String(Date.now()),
      ...overrides,
    },
  };
}

/** A model stub that "runs" two tool steps (reporting progress) and answers. */
function generate(seen: AgentGenerateArgs[]) {
  return async (args: AgentGenerateArgs) => {
    seen.push(args);
    args.onStep?.({ stepNumber: 1, toolNames: ['knowledge_query'] });
    args.onStep?.({ stepNumber: 2, toolNames: [] });
    return { text: '订单 A-1001 已于 10 月 1 日发货。', usage: { inputTokens: 10, outputTokens: 5 }, steps: [] };
  };
}

describe('feishu bot message flow', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `feishu-flow-${Date.now()}-${Math.random()}@test.local` });
    openId = `ou_flow_${Date.now()}_${Math.random()}`;
    await db.providerTokens.upsert({
      user_id: owner.id,
      provider: 'feishu',
      workspace_id: null,
      provider_user_id: openId,
      access_token: null,
    });
  });

  it('placeholder → progress → the answer replaces the card, no second message', async () => {
    const { senders, calls } = fakeSenders();
    const seen: AgentGenerateArgs[] = [];
    const evt = event();

    await handleFeishuMessage(evt, { db, toolRegistry: {}, senders, generate: generate(seen) });

    expect(seen).toHaveLength(1);
    expect(calls[0]).toMatchObject({ kind: 'reply', target: evt.message!.message_id, updatable: true });
    expect(calls[0]!.content).toContain('正在处理');
    const patches = calls.filter((c) => c.kind === 'patch');
    expect(patches.every((c) => c.target === 'om_bot_1')).toBe(true);
    expect(patches[0]!.content).toContain('已完成 1 步');
    expect(patches.at(-1)!.content).toContain('订单 A-1001 已于 10 月 1 日发货。');
    expect(calls.filter((c) => c.kind === 'reply')).toHaveLength(1);
  });

  it('without a card (no permission to send one) the answer still arrives as a reply', async () => {
    const { senders, calls } = fakeSenders({ replyOk: false });
    await handleFeishuMessage(event(), { db, toolRegistry: {}, senders, generate: generate([]) });
    expect(calls.filter((c) => c.kind === 'patch')).toEqual([]);
    expect(calls.at(-1)).toMatchObject({ kind: 'reply' });
    expect(calls.at(-1)!.content).toContain('已于 10 月 1 日发货');
  });

  it('when the final update is refused, the answer is sent as a new reply', async () => {
    const { senders, calls } = fakeSenders({ patchOk: false });
    await handleFeishuMessage(event(), { db, toolRegistry: {}, senders, generate: generate([]) });
    const replies = calls.filter((c) => c.kind === 'reply');
    expect(replies).toHaveLength(2);
    expect(replies[1]!.content).toContain('已于 10 月 1 日发货');
  });

  it('a re-delivery under a new message_id runs nothing', async () => {
    const { senders, calls } = fakeSenders();
    const seen: AgentGenerateArgs[] = [];
    const first = event({ create_time: '1791530000000' });
    const resent = event({ create_time: '1791530000000', message_id: `om_resent_${Date.now()}` });

    await handleFeishuMessage(first, { db, toolRegistry: {}, senders, generate: generate(seen) });
    await handleFeishuMessage(resent, { db, toolRegistry: {}, senders, generate: generate(seen) });

    expect(seen).toHaveLength(1);
    expect(calls.filter((c) => c.target === resent.message!.message_id)).toEqual([]);
  });

  it('non-text messages get a plain "text only" note and claim nothing', async () => {
    const { senders, calls } = fakeSenders();
    await handleFeishuMessage(event({ message_type: 'image' }), {
      db,
      toolRegistry: {},
      senders,
      generate: generate([]),
    });
    expect(calls).toEqual([expect.objectContaining({ kind: 'dm', target: openId })]);
  });
});

describe('feishuLogicalKey', () => {
  it('is stable for the same chat, sender, send time and text — and null without a send time', () => {
    const base = { chatId: 'oc', openId: 'ou', createTime: '1', content: '{"text":"hi"}' };
    expect(feishuLogicalKey(base)).toBe(feishuLogicalKey({ ...base }));
    expect(feishuLogicalKey(base)).not.toBe(feishuLogicalKey({ ...base, content: '{"text":"hi!"}' }));
    expect(feishuLogicalKey({ ...base, createTime: null })).toBeNull();
  });
});

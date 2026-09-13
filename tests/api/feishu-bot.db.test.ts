/**
 * 飞书机器人的两条花钱路径：消息去重与会话映射。
 *
 * 这两条都必须在**真数据库**上验，因为它们的正确性完全由唯一键提供：
 * 去重靠 `feishu_message_receipts.message_id` 主键、会话映射靠
 * `uq_feishu_conversations_key`。纯逻辑测试证明不了「并发下不会建出两个会话」。
 */

import { describe, it, expect, beforeEach } from 'vitest';

process.env.TOKEN_SIGNING_KEY = process.env.TOKEN_SIGNING_KEY ?? '11'.repeat(32);

import { initDatabase } from '@greenhouse/db';
import type { DatabaseProvider, UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;

async function feishuSession(title: string): Promise<string> {
  const session = await db.sessions.create(title, 'team', owner.id, undefined, 'feishu');
  return session.id;
}

describe('feishu bot persistence', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: `feishu-bot-${Date.now()}-${Math.random()}@test.local` });
  });

  describe('message deduplication', () => {
    it('只有第一次认领成功 —— 重投的事件必须被丢弃', async () => {
      // 处理一条消息 = 跑一轮 agent = 花钱且会回消息。飞书会重投，
      // 没有这道闸一次网络抖动就扣两次额度、回两条。
      const id = `om_dedupe_${Date.now()}`;
      expect(await db.feishuBot.claimMessage(id)).toBe(true);
      expect(await db.feishuBot.claimMessage(id)).toBe(false);
      expect(await db.feishuBot.claimMessage(id)).toBe(false);
    });

    it('不同消息互不影响', async () => {
      const stamp = Date.now();
      expect(await db.feishuBot.claimMessage(`om_a_${stamp}`)).toBe(true);
      expect(await db.feishuBot.claimMessage(`om_b_${stamp}`)).toBe(true);
    });
  });

  describe('conversation mapping', () => {
    it('同一个键始终解析到同一个会话', async () => {
      const key = `om_root_${Date.now()}`;
      const sessionId = await feishuSession('第一次提问');

      const linked = await db.feishuBot.linkConversation({
        feishu_key: key,
        session_id: sessionId,
        user_id: owner.id,
        chat_id: 'oc_test',
        chat_type: 'p2p',
      });
      expect(linked.session_id).toBe(sessionId);

      const found = await db.feishuBot.findConversation(key);
      expect(found?.session_id).toBe(sessionId);
    });

    it('并发下同一串对话只会有一个会话 —— 后到的让位给先到的', async () => {
      // 同一串对话短时间来两条消息时，两个 handler 可能同时发现「没有映射」。
      // 唯一键是仲裁者：DO NOTHING 让先到的赢，后到的重读拿到胜者的行。
      const key = `om_race_${Date.now()}`;
      const first = await feishuSession('赢家');
      const second = await feishuSession('输家');

      const [a, b] = await Promise.all([
        db.feishuBot.linkConversation({
          feishu_key: key,
          session_id: first,
          user_id: owner.id,
          chat_id: 'oc_test',
          chat_type: 'p2p',
        }),
        db.feishuBot.linkConversation({
          feishu_key: key,
          session_id: second,
          user_id: owner.id,
          chat_id: 'oc_test',
          chat_type: 'p2p',
        }),
      ]);

      // 两个调用拿到的必须是同一行——绝不能各自建一个会话。
      expect(a.session_id).toBe(b.session_id);
      expect([first, second]).toContain(a.session_id);
    });

    it('未映射的键返回 undefined，由调用方决定新建', async () => {
      expect(await db.feishuBot.findConversation(`om_missing_${Date.now()}`)).toBeUndefined();
    });

    it('touch 推进 last_message_at，不动 created_at', async () => {
      const key = `om_touch_${Date.now()}`;
      const sessionId = await feishuSession('会话');
      const linked = await db.feishuBot.linkConversation({
        feishu_key: key,
        session_id: sessionId,
        user_id: owner.id,
        chat_id: 'oc_test',
        chat_type: 'group',
      });

      await new Promise((r) => setTimeout(r, 5));
      await db.feishuBot.touchConversation(key);

      const after = await db.feishuBot.findConversation(key);
      expect(after?.created_at).toBe(linked.created_at);
      expect(Date.parse(after!.last_message_at)).toBeGreaterThanOrEqual(Date.parse(linked.last_message_at));
    });
  });
});

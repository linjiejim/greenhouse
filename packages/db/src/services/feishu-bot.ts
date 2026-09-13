/**
 * 飞书机器人对话的持久层（PostgreSQL）。
 *
 * 两件事：飞书对话 ↔ Greenhouse session 的映射，以及消息去重回执。
 * 方案见 docs/specs/20260825-feishu-bot-conversation.md。
 */

import { eq, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { feishuConversations, feishuMessageReceipts } from '../schema/index.js';
import type { FeishuConversationRow } from '../schema/feishu-bot.js';

export interface FeishuConversationInput {
  feishu_key: string;
  session_id: string;
  user_id: string;
  chat_id: string;
  chat_type: 'p2p' | 'group';
}

export function createFeishuBotService(db: Db) {
  return {
    /** 这串飞书对话映射到哪个 session；没有就返回 undefined（调用方负责新建）。 */
    async findConversation(feishuKey: string): Promise<FeishuConversationRow | undefined> {
      const rows = await db.select().from(feishuConversations).where(eq(feishuConversations.feishu_key, feishuKey));
      return rows[0];
    },

    /**
     * 记录映射。`feishu_key` 上的唯一键是并发下的仲裁者——同一串对话短时间内来
     * 两条消息时，两个 handler 可能同时发现「没有映射」，DO NOTHING 让先到的那
     * 条赢，随后重读拿到胜者的行，绝不会为一串对话建出两个 session。
     */
    async linkConversation(input: FeishuConversationInput): Promise<FeishuConversationRow> {
      const now = nowIso();
      await db
        .insert(feishuConversations)
        .values({ ...input, created_at: now, last_message_at: now })
        .onConflictDoNothing({ target: feishuConversations.feishu_key });
      const rows = await db
        .select()
        .from(feishuConversations)
        .where(eq(feishuConversations.feishu_key, input.feishu_key));
      return rows[0]!;
    },

    async touchConversation(feishuKey: string): Promise<void> {
      await db
        .update(feishuConversations)
        .set({ last_message_at: nowIso() })
        .where(eq(feishuConversations.feishu_key, feishuKey));
    },

    /**
     * 认领一条消息；返回 false 表示它已经被处理过，**必须直接丢弃**。
     *
     * 飞书会重投事件，而处理一条消息 = 跑一轮 agent = 花钱且会回消息。所以这
     * 是「先写回执再干活」：写冲突就是「别人已经在干了」。
     */
    async claimMessage(messageId: string): Promise<boolean> {
      const inserted = await db
        .insert(feishuMessageReceipts)
        .values({ message_id: messageId, received_at: nowIso() })
        .onConflictDoNothing({ target: feishuMessageReceipts.message_id })
        .returning({ message_id: feishuMessageReceipts.message_id });
      return inserted.length > 0;
    },

    /** 回执只为去重，保留 7 天足够覆盖任何重投窗口。 */
    async pruneReceipts(olderThanDays = 7): Promise<number> {
      const deleted = await db
        .delete(feishuMessageReceipts)
        .where(sql`${feishuMessageReceipts.received_at} < now() - make_interval(days => ${olderThanDays})`)
        .returning({ message_id: feishuMessageReceipts.message_id });
      return deleted.length;
    },
  };
}

export type FeishuBotService = ReturnType<typeof createFeishuBotService>;

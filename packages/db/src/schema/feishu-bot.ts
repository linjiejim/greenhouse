/**
 * Drizzle schema — 飞书机器人对话（PostgreSQL）。
 *
 * Tables: feishu_conversations, feishu_message_receipts
 *
 * 方案见 docs/specs/20260825-feishu-bot-conversation.md。
 */

import { pgTable, serial, text, timestamp, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './user.js';
import { sessions } from './session.js';

// ─── feishu_conversations ────────────────────────────────

/**
 * 「飞书的哪一串对话」↔「Greenhouse 的哪个 session」。
 *
 * `feishu_key` 是 `thread_id ?? root_id ?? message_id` 的回退结果（spec D1）：
 * 话题群命中 thread_id、普通回复链命中 root_id、首次发言用自己的 message_id。
 * 实测 `root_id` 在整条回复链里恒定，所以用户回复链上**任意一条**旧消息都会
 * 落到同一行——「延续上下文」不需要用户去找最后一条。
 */
export const feishuConversations = pgTable(
  'feishu_conversations',
  {
    id: serial('id').primaryKey(),
    /** 回退链算出的稳定键；一条飞书对话一行。 */
    feishu_key: text('feishu_key').notNull(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** 发起这串对话的内部用户——每条消息仍会重新解析身份，这里只作归属与排查。 */
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chat_id: text('chat_id').notNull(),
    chat_type: text('chat_type', { enum: ['p2p', 'group'] }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    last_message_at: timestamp('last_message_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    unique('uq_feishu_conversations_key').on(table.feishu_key),
    index('idx_feishu_conversations_user').on(table.user_id),
  ],
);

export type FeishuConversationRow = typeof feishuConversations.$inferSelect;

// ─── feishu_message_receipts ─────────────────────────────

/**
 * 已处理过的飞书消息 id。
 *
 * 飞书事件可能重投；没有这张表，一次网络抖动就会让同一个问题跑两轮 agent、
 * 扣两次额度、回两条消息（spec D9）。**先写回执再处理**，写冲突即丢弃。
 *
 * `logical_key`（2026-10-09）：同一条消息可能带着**新的** message_id 被重投
 * （OpenClaw 记录过这种情况），只认 message_id 拦不住。逻辑键 = 会话 + 发送者
 * + create_time + 正文的哈希，两个唯一键任一冲突都算重投。老行为 null。
 */
export const feishuMessageReceipts = pgTable(
  'feishu_message_receipts',
  {
    message_id: text('message_id').primaryKey(),
    logical_key: text('logical_key'),
    received_at: timestamp('received_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idx_feishu_receipts_received').on(table.received_at),
    uniqueIndex('uq_feishu_receipts_logical').on(table.logical_key),
  ],
);

export type FeishuMessageReceiptRow = typeof feishuMessageReceipts.$inferSelect;

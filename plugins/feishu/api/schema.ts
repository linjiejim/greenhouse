/**
 * Feishu bot: which conversation a Feishu chat continues, and receipts that
 * deduplicate Feishu's at-least-once event delivery (kept 7 days, `retention.ts`).
 *
 * Tables: feishu_conversations, feishu_receipts
 */

import { index, pgTable, text, unique } from 'drizzle-orm/pg-core';
import { at, createdAt, id, oneOf } from '@greenhouse/api/extension-kit';
import { conversations } from '@greenhouse/api/extension-kit';
import { users } from '@greenhouse/api/extension-kit';

export const FEISHU_CHAT_TYPES = ['p2p', 'group'] as const;

export const feishuConversations = pgTable(
  'feishu_conversations',
  {
    id: id(),
    feishu_key: text('feishu_key').notNull(),
    session_id: text('session_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    chat_id: text('chat_id').notNull(),
    chat_type: text('chat_type', { enum: FEISHU_CHAT_TYPES }).notNull(),
    created_at: createdAt(),
    last_message_at: at('last_message_at').notNull().defaultNow(),
  },
  (table) => [
    unique('uq_feishu_conversations_key').on(table.feishu_key),
    index('idx_feishu_conversations_user').on(table.user_id),
    oneOf('chk_feishu_conversations_chat_type', table.chat_type, FEISHU_CHAT_TYPES),
  ],
);

export const feishuReceipts = pgTable(
  'feishu_receipts',
  {
    message_id: text('message_id').primaryKey(),
    received_at: at('received_at').notNull().defaultNow(),
  },
  (table) => [index('idx_feishu_receipts_received').on(table.received_at)],
);

export type FeishuConversationRow = typeof feishuConversations.$inferSelect;

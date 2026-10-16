import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { at, createdAt, id, updatedAt } from './_columns.js';
import { members } from './identity.js';
import { conversations } from './conversations.js';

/** One-off member reminders; delayed execution belongs to the existing jobs queue. */
export const reminders = pgTable(
  'reminders',
  {
    id: id(),
    ownerId: text('owner_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    agentId: text('agent_id').notNull(),
    text: text('text').notNull(),
    dueAt: at('due_at').notNull(),
    timezone: text('timezone').notNull(),
    status: text('status', { enum: ['pending', 'canceled', 'delivered'] })
      .notNull()
      .default('pending'),
    revision: integer('revision').notNull().default(1),
    messageId: text('message_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('reminders_owner_idx').on(t.ownerId, t.id)],
);

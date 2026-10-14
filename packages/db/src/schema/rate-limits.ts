import { index, integer, pgTable, text } from 'drizzle-orm/pg-core';
import { at } from './_columns.js';

/** Fixed windows shared by API replicas. Keys are hashes, never addresses or credentials. */
export const rateLimits = pgTable(
  'rate_limits',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    resetAt: at('reset_at').notNull(),
  },
  (t) => [index('rate_limits_reset_idx').on(t.resetAt)],
);

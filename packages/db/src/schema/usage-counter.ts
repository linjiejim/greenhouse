/**
 * Drizzle schema — module usage counters (PostgreSQL).
 *
 * Tables: usage_counters
 *
 * Daily counts of what gets used, so module keep/remove decisions rest on data.
 * Counts only: no content, no arguments, no per-user rows. One row per
 * (day, kind, key, client); writers upsert `count = count + 1`.
 *   kind   'tool_call' (key = tool id) | 'page_open' (key = module id)
 *   client 'mcp' | 'agent_api' | 'web_chat' | 'automation' | 'subagent' | 'feishu' | 'browser' | 'web'
 */

import { pgTable, text, integer, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

export const USAGE_COUNTER_KINDS = ['tool_call', 'page_open'] as const;

export const usageCounters = pgTable(
  'usage_counters',
  {
    /** UTC calendar day, `YYYY-MM-DD`. */
    day: text('day').notNull(),
    kind: text('kind', { enum: USAGE_COUNTER_KINDS }).notNull(),
    key: text('key').notNull(),
    client: text('client').notNull(),
    count: integer('count').notNull().default(0),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    primaryKey({ name: 'pk_usage_counters', columns: [table.day, table.kind, table.key, table.client] }),
    index('idx_usage_counters_kind_day').on(table.kind, table.day),
  ],
);

export type UsageCounterRow = typeof usageCounters.$inferSelect;

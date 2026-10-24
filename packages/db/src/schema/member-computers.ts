/**
 * Members' cloud computers (v1.6). Status changes only through the
 * `memberComputers` service: every transition is a compare-and-set on the
 * expected status (and, when settling, the expected budget key). One active
 * computer per member is enforced by a partial unique index.
 *
 * Tables: member_computers
 */

import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, createdAt, id, oneOf, updatedAt } from './_columns.js';
import { users } from './identity.js';

export const MEMBER_COMPUTER_STATUSES = ['starting', 'running', 'stopping', 'stopped', 'failed', 'lost'] as const;
export const ACTIVE_MEMBER_COMPUTER_STATUSES = ['starting', 'running', 'stopping'] as const;

export const memberComputers = pgTable(
  'member_computers',
  {
    id: id(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull().default('e2b'),
    sandbox_id: text('sandbox_id'),
    status: text('status', { enum: MEMBER_COMPUTER_STATUSES }).notNull(),
    started_at: at('started_at').notNull(),
    last_used_at: at('last_used_at').notNull(),
    stopped_at: at('stopped_at'),
    stop_reason: text('stop_reason'),
    minutes_billed: integer('minutes_billed').notNull().default(0),
    budget_key: text('budget_key'),
    block_started_at: at('block_started_at'),
    client: text('client').notNull(),
    oauth_client_id: text('oauth_client_id'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex('uq_member_computers_active_user')
      .on(table.user_id)
      .where(sql`${table.status} IN ('starting', 'running', 'stopping')`),
    index('idx_member_computers_status').on(table.status),
    index('idx_member_computers_user_started').on(table.user_id, table.started_at),
    oneOf('chk_member_computers_status', table.status, MEMBER_COMPUTER_STATUSES),
  ],
);

export type MemberComputerRow = typeof memberComputers.$inferSelect;
export type MemberComputerStatus = MemberComputerRow['status'];

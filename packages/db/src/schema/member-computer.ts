/**
 * Drizzle schema — members' cloud computers (PostgreSQL), v1.6.
 *
 * One row per computer a member started: a hosted sandbox (E2B) that lives
 * from its first use until it is stopped, idles out or is lost. A member has at
 * most one active row (`starting` / `running` / `stopping`, enforced by a
 * partial unique index); a stopped computer keeps its row as history.
 *
 * Billing is per minute in blocks: `budget_key` is the USD reservation of the
 * block that started at `block_started_at` (usage/metering.ts). Crossing a
 * block boundary settles the block in full and reserves the next; a stop
 * settles the open block at the minutes it actually ran. `minutes_billed` is
 * the settled total. A computer whose stop could not be confirmed is `lost`:
 * its open block stays reserved and the budget sweeper charges the estimate.
 *
 * `client` / `oauth_client_id` are who started it (web, or a member's agent
 * over MCP), so every block settles with the same attribution. Nothing secret
 * is stored: the sandbox's access token is fetched from the provider when
 * needed.
 */

import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './user.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const MEMBER_COMPUTER_STATUSES = ['starting', 'running', 'stopping', 'stopped', 'failed', 'lost'] as const;
/** The states that hold a slot of the workspace's concurrency limit. */
export const ACTIVE_MEMBER_COMPUTER_STATUSES = ['starting', 'running', 'stopping'] as const;

export const memberComputers = pgTable(
  'member_computers',
  {
    /** `cmp_<hex>` — system-assigned. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** `e2b` today. */
    provider: text('provider').notNull().default('e2b'),
    /** The provider's sandbox id; null until it was created. */
    sandbox_id: text('sandbox_id'),
    status: text('status', { enum: MEMBER_COMPUTER_STATUSES }).notNull(),
    started_at: ts('started_at').notNull(),
    last_used_at: ts('last_used_at').notNull(),
    stopped_at: ts('stopped_at'),
    /** `user` · `idle` · `admin` · `budget` · `failed` · `lost`. */
    stop_reason: text('stop_reason'),
    /** Settled minutes (whole minutes, rounded up per block). */
    minutes_billed: integer('minutes_billed').notNull().default(0),
    /** Idempotency key of the open block's USD reservation (null once settled or when nothing was reserved yet). */
    budget_key: text('budget_key'),
    block_started_at: ts('block_started_at'),
    /** Metering client of whoever started it (`web`, `mcp`, …). */
    client: text('client').notNull(),
    oauth_client_id: text('oauth_client_id'),
    created_at: ts('created_at').notNull(),
    updated_at: ts('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_member_computers_active_user')
      .on(table.user_id)
      .where(sql`${table.status} IN ('starting', 'running', 'stopping')`),
    index('idx_member_computers_status').on(table.status),
    index('idx_member_computers_user_started').on(table.user_id, table.started_at),
  ],
);

export type MemberComputerRow = typeof memberComputers.$inferSelect;
export type MemberComputerStatus = MemberComputerRow['status'];

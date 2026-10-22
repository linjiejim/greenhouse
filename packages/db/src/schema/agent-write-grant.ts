/**
 * Drizzle schema — standing grants for external agent writes (PostgreSQL).
 *
 * Tables: agent_write_grants
 *
 * A member pre-approves a class of r2 (shared-data) writes made by their own
 * agents over MCP or the Agent API, so routine writes stop raising an approval
 * every time. r3 writes (irreversible or outward-facing) are never covered.
 *   client_id NULL  → any OAuth client bound to this member
 *   action    NULL  → every r2 action of the tool
 */

import { pgTable, text, integer, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './user.js';
import { platformOAuthClients } from './platform-oauth.js';

export const AGENT_WRITE_GRANT_SOURCES = ['approval', 'settings'] as const;

export const agentWriteGrants = pgTable(
  'agent_write_grants',
  {
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    client_id: text('client_id').references(() => platformOAuthClients.id, { onDelete: 'cascade' }),
    tool_id: text('tool_id').notNull(),
    action: text('action'),
    created_via: text('created_via', { enum: AGENT_WRITE_GRANT_SOURCES }).notNull().default('approval'),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    use_count: integer('use_count').notNull().default(0),
    last_used_at: timestamp('last_used_at', { withTimezone: true, mode: 'string' }),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_agent_write_grants_user_tool').on(table.user_id, table.tool_id)],
);

export type AgentWriteGrantRow = typeof agentWriteGrants.$inferSelect;

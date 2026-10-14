import { sql } from 'drizzle-orm';
import { pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { at, id, json } from './_columns.js';
import { agents } from './agents.js';
import { members } from './identity.js';

/** Only a member's decision card can grant a reversible folder or table scope. */
export const standingApprovals = pgTable(
  'standing_approvals',
  {
    id: id(),
    agentId: text('agent_id')
      .notNull()
      .references(() => agents.id, { onDelete: 'cascade' }),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    scopeType: text('scope_type', { enum: ['folder', 'table'] }).notNull(),
    scopeId: text('scope_id').notNull(),
    actions: json<string[]>('actions', []),
    grantedAt: at('granted_at').notNull().defaultNow(),
    revokedAt: at('revoked_at'),
  },
  (t) => [
    uniqueIndex('standing_approvals_active_key')
      .on(t.agentId, t.memberId, t.scopeType, t.scopeId)
      .where(sql`${t.revokedAt} IS NULL`),
  ],
);

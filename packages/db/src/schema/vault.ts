import { bigint, index, pgTable, text } from 'drizzle-orm/pg-core';
import { at, createdAt, id, json, updatedAt } from './_columns.js';
import { members } from './identity.js';

export const VAULT_POLICIES = ['ask', 'auto'] as const;
export type VaultPolicy = (typeof VAULT_POLICIES)[number];

/**
 * A login a member keeps for their Agents. Secrets are write-only: the `_enc` columns are sealed
 * with VAULT_ENCRYPTION_KEY, bound to this row, its member and the column, and are opened only to
 * type them into a page. Every read path returns the label, sites and a masked user name.
 */
export const vaultItems = pgTable(
  'vault_items',
  {
    id: id(),
    memberId: text('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    label: text('label').notNull(),
    /** Exact origins (`https://host[:port]`) or explicit `*.host` wildcards. */
    origins: json<string[]>('origins', []),
    usernameEnc: text('username_enc'),
    passwordEnc: text('password_enc'),
    totpEnc: text('totp_enc'),
    /** What people and Agents see of the user name: `ji***@example.com`. */
    usernameHint: text('username_hint').notNull().default(''),
    /** ask: every fill waits for the member's card; auto: filled without asking. */
    policy: text('policy', { enum: VAULT_POLICIES }).notNull().default('ask'),
    /** Origins where an `ask` login is filled without a card. Always within `origins`. */
    alwaysOrigins: json<string[]>('always_origins', []),
    /** The member's Agents that may use it; empty means all of them. */
    agentIds: json<string[]>('agent_ids', []),
    lastUsedAt: at('last_used_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('vault_items_member_idx').on(t.memberId)],
);

export const VAULT_ACTIONS = ['fill'] as const;
export const VAULT_OUTCOMES = ['requested', 'filled', 'declined', 'origin_mismatch', 'no_fields', 'failed'] as const;
export type VaultOutcome = (typeof VAULT_OUTCOMES)[number];
/** Why a fill went ahead: the item fills itself, the site is always allowed, or the member approved the card. */
export const VAULT_APPROVALS = ['auto', 'always', 'member'] as const;
export type VaultApproval = (typeof VAULT_APPROVALS)[number];

/**
 * What the Agents did with the vault, for the member alone. Never a value. Not part of
 * `audit_events`, because admins never read a vault.
 */
export const vaultAccessLog = pgTable(
  'vault_access_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    memberId: text('member_id').notNull(),
    itemId: text('item_id').references(() => vaultItems.id, { onDelete: 'set null' }),
    /** The label when it happened: the row outlives the item. */
    itemLabel: text('item_label').notNull(),
    agentId: text('agent_id'),
    conversationId: text('conversation_id'),
    /** The page's origin, as the browser reported it. */
    origin: text('origin').notNull(),
    action: text('action', { enum: VAULT_ACTIONS }).notNull(),
    outcome: text('outcome', { enum: VAULT_OUTCOMES }).notNull(),
    approval: text('approval', { enum: VAULT_APPROVALS }),
    createdAt: createdAt(),
  },
  (t) => [index('vault_access_log_member_idx').on(t.memberId, t.id)],
);

export type VaultItem = typeof vaultItems.$inferSelect;
export type VaultAccess = typeof vaultAccessLog.$inferSelect;

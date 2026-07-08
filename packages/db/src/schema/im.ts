/**
 * Drizzle schema — IM gateway tables (PostgreSQL).
 *
 * Tables: im_bots, im_identities, im_pairing_codes
 *
 * The IM gateway lets a Greenhouse user chat with their agent from an external
 * chat platform (Telegram in M0). A bot (`im_bots`) receives inbound messages; a
 * linked identity (`im_identities`) maps a platform user to a Greenhouse user + a
 * rolling conversation session; a pairing code (`im_pairing_codes`) is the
 * short-lived deep-link token that establishes that link.
 *
 * `channel` is enum-typed at the type layer only (no DB constraint / migration).
 * Only 'telegram' is implemented today; extend the union when a new adapter lands
 * (see packages/db/src/AGENTS.md — string-union columns are type-only).
 */

import { pgTable, text, integer, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';

// ─── im_bots ──────────────────────────────────────────────

export const imBots = pgTable(
  'im_bots',
  {
    id: text('id').primaryKey(),
    channel: text('channel', { enum: ['telegram'] })
      .notNull()
      .default('telegram'),
    name: text('name').notNull(),
    // Bot credential (Telegram bot token) — AES-256-GCM encrypted at rest via
    // auth/crypto.ts (PROVIDER_TOKEN_ENCRYPTION_KEY). NEVER returned by the API.
    token_enc: text('token_enc').notNull(),
    // Filled from the platform (Telegram getMe) so the pairing deep link can be built.
    bot_username: text('bot_username'),
    // Which agent profile inbound turns run as — governs tools + model, same model
    // as scheduled tasks. Logical ref to a profile id (validated at write time).
    default_profile_id: text('default_profile_id').notNull().default('default'),
    status: text('status', { enum: ['active', 'disabled'] })
      .notNull()
      .default('active'),
    // Telegram long-poll cursor — persisted so a restart resumes without loss or
    // reprocessing (getUpdates acks everything below the offset).
    poll_offset: integer('poll_offset').notNull().default(0),
    created_by: text('created_by'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_im_bots_status').on(table.status)],
);

// ─── im_identities ────────────────────────────────────────

export const imIdentities = pgTable(
  'im_identities',
  {
    id: text('id').primaryKey(),
    bot_id: text('bot_id')
      .notNull()
      .references(() => imBots.id, { onDelete: 'cascade' }),
    channel: text('channel', { enum: ['telegram'] })
      .notNull()
      .default('telegram'),
    // Platform user id + the chat id replies go to (for a DM they match).
    ext_user_id: text('ext_user_id').notNull(),
    ext_chat_id: text('ext_chat_id').notNull(),
    // Linked Greenhouse user. Logical ref (no FK — cross-domain, mirrors sessions.user_id).
    user_id: text('user_id').notNull(),
    // Rolling conversation session for this identity. Logical ref (no FK) —
    // recreated if the session is deleted; cleared by /new.
    session_id: text('session_id'),
    display_name: text('display_name'),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    uniqueIndex('uq_im_identities_bot_user').on(table.bot_id, table.ext_user_id),
    index('idx_im_identities_user').on(table.user_id),
  ],
);

// ─── im_pairing_codes ─────────────────────────────────────

export const imPairingCodes = pgTable(
  'im_pairing_codes',
  {
    code: text('code').primaryKey(),
    bot_id: text('bot_id')
      .notNull()
      .references(() => imBots.id, { onDelete: 'cascade' }),
    // The Greenhouse user this code will link on redemption. Logical ref (no FK).
    user_id: text('user_id').notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    created_at: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [index('idx_im_pairing_expires').on(table.expires_at)],
);

// ─── Row types (inferred — schema is the single source of truth) ──

export type ImBotRow = typeof imBots.$inferSelect;
export type ImBotStatus = ImBotRow['status'];
export type ImChannel = ImBotRow['channel'];
export type ImIdentityRow = typeof imIdentities.$inferSelect;
export type ImPairingCodeRow = typeof imPairingCodes.$inferSelect;

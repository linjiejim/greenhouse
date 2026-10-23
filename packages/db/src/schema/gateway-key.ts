/**
 * Drizzle schema — model gateway keys (PostgreSQL).
 *
 * A member's personal key for the OpenAI-compatible model gateway
 * (`/api/gateway/openai/v1`): their own agents (Cursor, scripts, OpenAI-compatible tools) call the
 * team's models with it and every call is metered to that member.
 *
 * - The secret (`ghgw_…`) is shown once at creation and never stored: `key_hash`
 *   is its SHA-256 (hashed in the service — callers pass the raw value), and
 *   `key_prefix` is a short visible head so a member can tell keys apart.
 * - `allowed_models` is a JSON array of catalog model ids; NULL = every model
 *   the gateway offers.
 * - Revoking only stamps `revoked_at` / `revoked_by` and never deletes the row,
 *   so a key's history stays readable (deleting the member deletes their keys;
 *   the audit keeps each key's name and prefix).
 */

import { index, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { users } from './user.js';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

export const gatewayKeys = pgTable(
  'gateway_keys',
  {
    /** `gwk_<hex>` — system-assigned. */
    id: text('id').primaryKey(),
    user_id: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** SHA-256 hex of the full secret. */
    key_hash: text('key_hash').notNull(),
    /** The first characters of the secret (`ghgw_` + a few), safe to show. */
    key_prefix: text('key_prefix').notNull(),
    /** JSON array of catalog model ids; NULL = all gateway models. */
    allowed_models: text('allowed_models'),
    expires_at: ts('expires_at'),
    last_used_at: ts('last_used_at'),
    revoked_at: ts('revoked_at'),
    /** Who revoked it: the owner, or a super. */
    revoked_by: text('revoked_by'),
    created_at: ts('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('uq_gateway_keys_hash').on(table.key_hash),
    index('idx_gateway_keys_user').on(table.user_id, table.created_at),
  ],
);

export type GatewayKeyRow = typeof gatewayKeys.$inferSelect;

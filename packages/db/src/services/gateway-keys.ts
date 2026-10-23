/**
 * Model gateway keys — create, look up by secret, list, revoke.
 *
 * The secret is hashed here (SHA-256), never stored: callers pass the raw value
 * to `create` and `findBySecret` and the database only ever sees the hash.
 * Whether a found key may be used (revoked, expired, owner still an active
 * internal member) is the caller's decision — `usability` says which.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gte, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { gatewayKeys, llmUsage, users } from '../schema/index.js';
import type { GatewayKeyRow } from '../schema/gateway-key.js';

/** Visible head of a secret: enough to tell keys apart, far too little to use. */
export const GATEWAY_KEY_PREFIX_LENGTH = 12;

/** `last_used_at` is refreshed at most this often per key (one write per minute, not per call). */
export const GATEWAY_KEY_TOUCH_INTERVAL_MS = 60_000;

export function hashGatewaySecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

export interface CreateGatewayKeyInput {
  user_id: string;
  name: string;
  /** The full secret; only its hash and prefix are stored. */
  secret: string;
  /** Catalog model ids; null / empty = every gateway model. */
  allowed_models?: readonly string[] | null;
  expires_at?: string | null;
  at?: string;
}

export type GatewayKeyUsability = 'active' | 'revoked' | 'expired';

/** Whether a key may be used at `now`. */
export function gatewayKeyUsability(
  row: Pick<GatewayKeyRow, 'revoked_at' | 'expires_at'>,
  now: number = Date.now(),
): GatewayKeyUsability {
  if (row.revoked_at) return 'revoked';
  if (row.expires_at && Date.parse(row.expires_at) <= now) return 'expired';
  return 'active';
}

/** The stored allow-list, or null for "every model". A malformed value allows nothing. */
export function gatewayKeyAllowedModels(row: Pick<GatewayKeyRow, 'allowed_models'>): string[] | null {
  if (row.allowed_models === null) return null;
  try {
    const parsed = JSON.parse(row.allowed_models) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
  } catch {
    return [];
  }
}

/** One key's settled spend in a window (llm_usage facts carrying its id). */
export interface GatewayKeySpend {
  cost_usd_micros: number;
  calls: number;
}

export interface GatewayKeyWithOwner extends GatewayKeyRow {
  owner_name: string | null;
  owner_email: string | null;
}

function newKeyId(): string {
  return `gwk_${randomBytes(8).toString('hex')}`;
}

export function createGatewayKeyService(db: Db) {
  const service = {
    async create(input: CreateGatewayKeyInput): Promise<GatewayKeyRow> {
      const models =
        input.allowed_models && input.allowed_models.length > 0 ? [...new Set(input.allowed_models)] : null;
      const rows = await db
        .insert(gatewayKeys)
        .values({
          id: newKeyId(),
          user_id: input.user_id,
          name: input.name,
          key_hash: hashGatewaySecret(input.secret),
          key_prefix: input.secret.slice(0, GATEWAY_KEY_PREFIX_LENGTH),
          allowed_models: models ? JSON.stringify(models) : null,
          expires_at: input.expires_at ?? null,
          created_at: input.at ?? nowIso(),
        })
        .returning();
      return rows[0]!;
    },

    /** The key this secret belongs to, revoked or expired included (the caller decides). */
    async findBySecret(secret: string): Promise<GatewayKeyRow | null> {
      const rows = await db
        .select()
        .from(gatewayKeys)
        .where(eq(gatewayKeys.key_hash, hashGatewaySecret(secret)))
        .limit(1);
      return rows[0] ?? null;
    },

    async getById(id: string): Promise<GatewayKeyRow | null> {
      const rows = await db.select().from(gatewayKeys).where(eq(gatewayKeys.id, id)).limit(1);
      return rows[0] ?? null;
    },

    /** One member's keys, newest first, revoked ones included. */
    async listByUser(userId: string): Promise<GatewayKeyRow[]> {
      return db
        .select()
        .from(gatewayKeys)
        .where(eq(gatewayKeys.user_id, userId))
        .orderBy(desc(gatewayKeys.created_at), desc(gatewayKeys.id));
    },

    /** Every member's keys with the owner's name (Administration), newest first. */
    async listAll(): Promise<GatewayKeyWithOwner[]> {
      const rows = await db
        .select({ key: gatewayKeys, owner_name: users.nickname, owner_email: users.email })
        .from(gatewayKeys)
        .leftJoin(users, eq(users.id, gatewayKeys.user_id))
        .orderBy(desc(gatewayKeys.created_at), desc(gatewayKeys.id));
      return rows.map((row) => ({
        ...row.key,
        owner_name: row.owner_name ?? null,
        owner_email: row.owner_email ?? null,
      }));
    },

    /** Keys a member can still use (not revoked, not expired). */
    async countActiveByUser(userId: string, at: string = nowIso()): Promise<number> {
      const rows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(gatewayKeys)
        .where(
          and(
            eq(gatewayKeys.user_id, userId),
            isNull(gatewayKeys.revoked_at),
            or(isNull(gatewayKeys.expires_at), sql`${gatewayKeys.expires_at} > ${at}`),
          ),
        );
      return rows[0]?.count ?? 0;
    },

    /**
     * Revoke a key; with `user_id`, only if it is that member's. Returns the
     * row as it now is, or null when there is no such key (for that member). A
     * key already revoked keeps its first revocation and comes back unchanged.
     */
    async revoke(input: { id: string; revoked_by: string; user_id?: string; at?: string }): Promise<{
      row: GatewayKeyRow;
      changed: boolean;
    } | null> {
      const owner = input.user_id ? eq(gatewayKeys.user_id, input.user_id) : undefined;
      const updated = await db
        .update(gatewayKeys)
        .set({ revoked_at: input.at ?? nowIso(), revoked_by: input.revoked_by })
        .where(and(eq(gatewayKeys.id, input.id), isNull(gatewayKeys.revoked_at), owner))
        .returning();
      if (updated[0]) return { row: updated[0], changed: true };
      const existing = await db
        .select()
        .from(gatewayKeys)
        .where(and(eq(gatewayKeys.id, input.id), owner))
        .limit(1);
      return existing[0] ? { row: existing[0], changed: false } : null;
    },

    /**
     * Settled spend per key in `[since, until)`, optionally one member's keys
     * only. Unpriced calls count as zero; reservations still open are not spend.
     */
    async spendByKey(input: { since: string; until: string; user_id?: string }): Promise<Map<string, GatewayKeySpend>> {
      const rows = await db
        .select({
          key: llmUsage.gateway_key_id,
          cost: sql<number>`COALESCE(SUM(${llmUsage.cost_usd_micros}), 0)::bigint`,
          calls: sql<number>`count(*)::int`,
        })
        .from(llmUsage)
        .where(
          and(
            isNotNull(llmUsage.gateway_key_id),
            gte(llmUsage.created_at, input.since),
            lt(llmUsage.created_at, input.until),
            input.user_id ? eq(llmUsage.user_id, input.user_id) : undefined,
          ),
        )
        .groupBy(llmUsage.gateway_key_id);
      return new Map(
        rows
          .filter((row): row is typeof row & { key: string } => row.key !== null)
          .map((row) => [row.key, { cost_usd_micros: Number(row.cost), calls: Number(row.calls) }]),
      );
    },

    /** Stamp a use; skipped when the last stamp is under a minute old. */
    async touchLastUsed(id: string, at: string = nowIso()): Promise<void> {
      const threshold = new Date(Date.parse(at) - GATEWAY_KEY_TOUCH_INTERVAL_MS).toISOString();
      await db
        .update(gatewayKeys)
        .set({ last_used_at: at })
        .where(
          and(eq(gatewayKeys.id, id), or(isNull(gatewayKeys.last_used_at), lt(gatewayKeys.last_used_at, threshold))),
        );
    },
  };
  return service;
}

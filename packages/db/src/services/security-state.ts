/**
 * Shared security state — state that used to live in one process's memory, so
 * a restart reset it and a second instance doubled it.
 *
 * - `rateLimits`: fixed-window counters. One atomic upsert-increment per hit
 *   (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`), so
 *   concurrent requests on any number of instances count exactly once each.
 * - `oauthLoginStates`: pending Feishu / WeCom login `state` values and one-time
 *   login codes. Only the SHA-256 of a value is stored; consuming is a single
 *   conditional UPDATE, so a value is used at most once even under a race.
 */

import { createHash } from 'node:crypto';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import { safeJsonParse } from '@greenhouse/utils/json';

import type { Db } from '../client.js';
import { oauthLoginStates, rateLimitBuckets } from '../schema/index.js';
import type { OAuthLoginStateRow } from '../schema/security-state.js';

export function createRateLimitService(db: Db) {
  return {
    /**
     * Count one hit in the bucket `key` (callers put the window start in the key)
     * and return the bucket's count including this hit. `expiresAt` is the end of
     * the window; it is only written when the bucket is created.
     */
    async hit(key: string, expiresAt: string): Promise<number> {
      const rows = await db
        .insert(rateLimitBuckets)
        .values({ key, count: 1, expires_at: expiresAt })
        .onConflictDoUpdate({ target: rateLimitBuckets.key, set: { count: sql`${rateLimitBuckets.count} + 1` } })
        .returning({ count: rateLimitBuckets.count });
      return rows[0]!.count;
    },

    /** Delete buckets whose window ended before `before` (default now). Returns how many. */
    async sweepExpired(before: string = nowIso()): Promise<number> {
      const rows = await db
        .delete(rateLimitBuckets)
        .where(lt(rateLimitBuckets.expires_at, before))
        .returning({ key: rateLimitBuckets.key });
      return rows.length;
    },
  };
}

export type RateLimitService = ReturnType<typeof createRateLimitService>;

export type OAuthLoginStateKind = OAuthLoginStateRow['kind'];

function hashLoginValue(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function createOAuthLoginStateService(db: Db) {
  return {
    /** Remember `value` (hashed) for one later `consume`, until `expiresAt`. */
    async issue(input: {
      value: string;
      provider: string;
      kind: OAuthLoginStateKind;
      payload: Record<string, unknown>;
      expiresAt: string;
    }): Promise<void> {
      await db.insert(oauthLoginStates).values({
        id: hashLoginValue(input.value),
        provider: input.provider,
        kind: input.kind,
        payload: JSON.stringify(input.payload),
        expires_at: input.expiresAt,
        created_at: nowIso(),
      });
    },

    /**
     * Use `value` once: returns its payload, or null when it is unknown, of
     * another provider/kind, expired, or already used. One conditional UPDATE —
     * of two concurrent callers exactly one gets the payload.
     */
    async consume(input: {
      value: string;
      provider: string;
      kind: OAuthLoginStateKind;
    }): Promise<Record<string, unknown> | null> {
      const now = nowIso();
      const rows = await db
        .update(oauthLoginStates)
        .set({ consumed_at: now })
        .where(
          and(
            eq(oauthLoginStates.id, hashLoginValue(input.value)),
            eq(oauthLoginStates.provider, input.provider),
            eq(oauthLoginStates.kind, input.kind),
            isNull(oauthLoginStates.consumed_at),
            gt(oauthLoginStates.expires_at, now),
          ),
        )
        .returning({ payload: oauthLoginStates.payload });
      if (!rows[0]) return null;
      const payload = safeJsonParse(rows[0].payload, {});
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {};
    },

    /** Delete rows (used or not) whose lifetime ended before `before` (default now). */
    async sweepExpired(before: string = nowIso()): Promise<number> {
      const rows = await db
        .delete(oauthLoginStates)
        .where(lt(oauthLoginStates.expires_at, before))
        .returning({ id: oauthLoginStates.id });
      return rows.length;
    },
  };
}

export type OAuthLoginStateService = ReturnType<typeof createOAuthLoginStateService>;

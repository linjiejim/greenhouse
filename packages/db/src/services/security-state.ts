/**
 * Shared security state — state that used to live in one process's memory, so
 * a restart reset it and a second instance doubled it.
 *
 * - `rateLimits`: fixed-window counters. One atomic upsert-increment per hit
 *   (`INSERT … ON CONFLICT DO UPDATE SET count = count + 1 RETURNING count`), so
 *   concurrent requests on any number of instances count exactly once each.
 */

import { lt, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';

import type { Db } from '../client.js';
import { rateLimitBuckets } from '../schema/index.js';

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

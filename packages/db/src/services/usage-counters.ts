/**
 * Usage counter service — daily module usage counts (`usage_counters`).
 *
 * Counts only: one row per (UTC day, kind, key, client), bumped with a single
 * upsert so concurrent writers never collide. Callers in apps/api go through the
 * fire-and-forget `countUsage()` (apps/api/src/usage/counters.ts); a failed
 * count must never fail the request that triggered it.
 */

import { and, eq, gte, lte, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { UsageCountRow } from '@greenhouse/types/usage';

import type { Db } from '../client.js';
import { usageCounters, USAGE_COUNTER_KINDS } from '../schema/index.js';

export type UsageCounterKind = (typeof USAGE_COUNTER_KINDS)[number];

/** UTC calendar day (`YYYY-MM-DD`) of an instant. */
export function usageDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export function createUsageCounterService(db: Db) {
  const service = {
    /** Add one to today's (UTC) counter for `kind × key × client`. */
    async increment(kind: UsageCounterKind, key: string, client: string, at: Date = new Date()): Promise<void> {
      const now = nowIso();
      await db
        .insert(usageCounters)
        .values({ day: usageDay(at), kind, key, client, count: 1, updated_at: now })
        .onConflictDoUpdate({
          target: [usageCounters.day, usageCounters.kind, usageCounters.key, usageCounters.client],
          set: { count: sql`${usageCounters.count} + 1`, updated_at: now },
        });
    },

    /**
     * Totals per key × client over an inclusive UTC day range (`YYYY-MM-DD`),
     * largest first. Day strings compare lexically, so the range is a plain
     * text comparison on the primary-key column.
     */
    async summarize(kind: UsageCounterKind, range: { from: string; to: string }): Promise<UsageCountRow[]> {
      const rows = await db
        .select({
          key: usageCounters.key,
          client: usageCounters.client,
          count: sql<string>`sum(${usageCounters.count})`,
        })
        .from(usageCounters)
        .where(and(eq(usageCounters.kind, kind), gte(usageCounters.day, range.from), lte(usageCounters.day, range.to)))
        .groupBy(usageCounters.key, usageCounters.client)
        .orderBy(sql`sum(${usageCounters.count}) desc`, usageCounters.key, usageCounters.client);
      // postgres.js returns SUM(integer) as a bigint string.
      return rows.map((row) => ({ key: row.key, client: row.client, count: Number(row.count) }));
    },
  };
  return service;
}

export type UsageCounterService = ReturnType<typeof createUsageCounterService>;

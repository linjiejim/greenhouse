/**
 * Usage counter service — daily module usage counts (`module_usage_daily`).
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
import { moduleUsageDaily, USAGE_COUNTER_KINDS } from '../schema/index.js';

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
        .insert(moduleUsageDaily)
        .values({ day: usageDay(at), kind, key, client, count: 1, updated_at: now })
        .onConflictDoUpdate({
          target: [moduleUsageDaily.day, moduleUsageDaily.kind, moduleUsageDaily.key, moduleUsageDaily.client],
          set: { count: sql`${moduleUsageDaily.count} + 1`, updated_at: now },
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
          key: moduleUsageDaily.key,
          client: moduleUsageDaily.client,
          count: sql<string>`sum(${moduleUsageDaily.count})`,
        })
        .from(moduleUsageDaily)
        .where(
          and(
            eq(moduleUsageDaily.kind, kind),
            gte(moduleUsageDaily.day, range.from),
            lte(moduleUsageDaily.day, range.to),
          ),
        )
        .groupBy(moduleUsageDaily.key, moduleUsageDaily.client)
        .orderBy(sql`sum(${moduleUsageDaily.count}) desc`, moduleUsageDaily.key, moduleUsageDaily.client);
      // postgres.js returns SUM(integer) as a bigint string.
      return rows.map((row) => ({ key: row.key, client: row.client, count: Number(row.count) }));
    },
  };
  return service;
}

export type UsageCounterService = ReturnType<typeof createUsageCounterService>;

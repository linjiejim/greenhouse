/** Fixed-window limits, with a memory default and an atomic store shared by replicas. */
import { createHash } from 'node:crypto';
import { eq, lt, sql } from 'drizzle-orm';
import { getDb, rateLimits } from '@greenhouse/db';

interface Window {
  count: number;
  waitSeconds: number;
}

export interface RateLimitStore {
  consume(key: string, windowMs: number, now?: number): Promise<Window>;
  reset(key: string): Promise<void>;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  async consume(key: string, windowMs: number, now = Date.now()): Promise<Window> {
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      if (this.hits.size > 10_000)
        for (const [other, value] of this.hits) if (value.resetAt <= now) this.hits.delete(other);
      this.hits.set(key, entry);
    }
    entry.count++;
    return { count: entry.count, waitSeconds: Math.ceil((entry.resetAt - now) / 1000) };
  }

  async reset(key: string): Promise<void> {
    this.hits.delete(key);
  }
}

export class PostgresRateLimitStore implements RateLimitStore {
  async consume(key: string, windowMs: number): Promise<Window> {
    // The database clock and one UPSERT keep even simultaneous replicas in the same window.
    const expired = sql`${rateLimits.resetAt} <= clock_timestamp()`;
    const resetAt = sql`clock_timestamp() + (${windowMs} * interval '1 millisecond')`;
    const [row] = await getDb()
      .insert(rateLimits)
      .values({ key, count: 1, resetAt })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: sql`case when ${expired} then 1 else least(${rateLimits.count}::bigint + 1, 2147483647)::int end`,
          resetAt: sql`case when ${expired} then ${resetAt} else ${rateLimits.resetAt} end`,
        },
      })
      .returning({
        count: rateLimits.count,
        waitSeconds: sql<number>`greatest(1, ceil(extract(epoch from (${rateLimits.resetAt} - clock_timestamp()))))::int`,
      });
    return row!;
  }

  async reset(key: string): Promise<void> {
    await getDb().delete(rateLimits).where(eq(rateLimits.key, key));
  }
}

/** The worker's daily retention job removes windows that can no longer limit a request. */
export async function pruneRateLimits(): Promise<void> {
  await getDb()
    .delete(rateLimits)
    .where(lt(rateLimits.resetAt, sql`clock_timestamp()`));
}

export class RateLimiter {
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly store: RateLimitStore = new MemoryRateLimitStore(),
    private readonly namespace = 'auth',
  ) {}

  private key(key: string): string {
    return createHash('sha256').update(`${this.namespace}:${key}`).digest('hex');
  }

  /** Records a hit and returns how many seconds to wait, or 0 when allowed. */
  async hit(key: string, now?: number): Promise<number> {
    const entry = await this.store.consume(this.key(key), this.windowMs, now);
    return entry.count > this.limit ? entry.waitSeconds : 0;
  }

  async reset(key: string): Promise<void> {
    await this.store.reset(this.key(key));
  }
}

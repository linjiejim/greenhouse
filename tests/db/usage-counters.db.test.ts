/**
 * Module usage counters + the prompt-cache hit query (real PostgreSQL).
 *
 * `increment()` is a single upsert on the (day, kind, key, client) primary key:
 * concurrent writers (every chat turn, MCP call and page view) must add up,
 * never collide. `summarize()` is what Administration › Usage reads, so its day
 * range and grouping are pinned against real rows.
 *
 * Keys are unique per run: the table is shared with anything else that has
 * committed rows, so assertions filter to this test's own keys.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider, usageDay } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

function uniqueKey(label: string): string {
  return `test_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

describe('Usage counters', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('upserts one row per day × kind × key × client and adds up concurrent increments', async () => {
    const tool = uniqueKey('tool');
    const today = usageDay();

    await Promise.all(Array.from({ length: 5 }, () => db.usageCounters.increment('tool_call', tool, 'mcp')));
    await db.usageCounters.increment('tool_call', tool, 'web_chat');

    const rows = (await db.usageCounters.summarize('tool_call', { from: today, to: today })).filter(
      (row) => row.key === tool,
    );
    expect(rows).toEqual([
      { key: tool, client: 'mcp', count: 5 },
      { key: tool, client: 'web_chat', count: 1 },
    ]);
  });

  it('counts on the UTC day of the instant and keeps kinds apart', async () => {
    const key = uniqueKey('module');
    // 23:30 UTC on 2 Jan is already 3 Jan in UTC+8 — the counter must use UTC.
    await db.usageCounters.increment('page_open', key, 'web', new Date('2026-01-02T23:30:00.000Z'));
    await db.usageCounters.increment('page_open', key, 'web', new Date('2026-01-03T00:10:00.000Z'));
    await db.usageCounters.increment('tool_call', key, 'web', new Date('2026-01-02T12:00:00.000Z'));

    const jan2 = await db.usageCounters.summarize('page_open', { from: '2026-01-02', to: '2026-01-02' });
    expect(jan2.filter((row) => row.key === key)).toEqual([{ key, client: 'web', count: 1 }]);

    const both = await db.usageCounters.summarize('page_open', { from: '2026-01-02', to: '2026-01-03' });
    expect(both.filter((row) => row.key === key)).toEqual([{ key, client: 'web', count: 2 }]);

    const tools = await db.usageCounters.summarize('tool_call', { from: '2026-01-02', to: '2026-01-03' });
    expect(tools.filter((row) => row.key === key)).toEqual([{ key, client: 'web', count: 1 }]);
  });

  it('excludes days outside the inclusive range and sums days inside it, largest first', async () => {
    const busy = uniqueKey('busy');
    const quiet = uniqueKey('quiet');
    for (const day of ['2025-06-01', '2025-06-02', '2025-06-03']) {
      await db.usageCounters.increment('tool_call', busy, 'automation', new Date(`${day}T08:00:00.000Z`));
    }
    await db.usageCounters.increment('tool_call', busy, 'automation', new Date('2025-05-31T08:00:00.000Z'));
    await db.usageCounters.increment('tool_call', quiet, 'subagent', new Date('2025-06-02T08:00:00.000Z'));

    const rows = (await db.usageCounters.summarize('tool_call', { from: '2025-06-01', to: '2025-06-03' })).filter(
      (row) => row.key === busy || row.key === quiet,
    );
    expect(rows).toEqual([
      { key: busy, client: 'automation', count: 3 },
      { key: quiet, client: 'subagent', count: 1 },
    ]);
  });

  it('reports the prompt-cache hit rate per model as cached ÷ input tokens', async () => {
    const model = uniqueKey('model');
    const idle = uniqueKey('idle-model');
    const record = (m: string, input: number, cached: number) =>
      db.usage.record({
        profile_id: 'sprouty',
        caller: 'chat',
        model: m,
        input_tokens: input,
        output_tokens: 1,
        cached_tokens: cached,
      });
    await record(model, 1000, 900);
    await record(model, 1000, 100);
    await record(idle, 0, 0);

    const rows = await db.usage.getCacheHitByModel({ since: '2000-01-01T00:00:00.000Z' });
    expect(rows.find((row) => row.model === model)).toEqual({
      model,
      calls: 2,
      input_tokens: 2000,
      cached_tokens: 1000,
      hit_rate: 0.5,
    });
    expect(rows.find((row) => row.model === idle)?.hit_rate).toBeNull();

    const future = await db.usage.getCacheHitByModel({ since: '2999-01-01T00:00:00.000Z' });
    expect(future.find((row) => row.model === model)).toBeUndefined();
  });
});

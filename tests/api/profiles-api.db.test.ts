/**
 * Tests for Profile API routes (/api/profiles).
 *
 * Verifies that profiles are returned with usage data.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';

let db: DatabaseProvider;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

afterEach(async () => {
  await db.close();
  _resetProvider();
});

async function seedUsage(): Promise<void> {
  await db.usage.record({
    profile_id: 'team',
    caller: 'chat',
    model: 'deepseek-v4-flash',
    input_tokens: 1000,
    output_tokens: 500,
    duration_ms: 2000,
  });
  await db.usage.record({
    profile_id: 'team',
    caller: 'compiler',
    model: 'deepseek-v4-flash',
    input_tokens: 5000,
    output_tokens: 3000,
    duration_ms: 8000,
  });
}

describe('Profile API: usage integration', () => {
  it('profiles list includes null usage when empty', async () => {
    const stats = await db.usage.getStatsByProfile();
    // No records inserted → empty
    expect(stats).toEqual([]);
  });

  it('usage stats appear after recording', async () => {
    await seedUsage();

    const stats = await db.usage.getStatsByProfile();
    expect(stats).toHaveLength(1);
    expect(stats[0].profile_id).toBe('team');
    expect(stats[0].total_calls).toBe(2);
    expect(stats[0].total_input_tokens).toBe(6000);
    expect(stats[0].total_output_tokens).toBe(3500);
  });

  it('profile detail returns time-bucketed stats', async () => {
    await seedUsage();
    const total = await db.usage.getProfileStats('team');
    expect(total).not.toBeNull();
    expect(total!.total_calls).toBe(2);

    // Since we just inserted, all records should be within 24h
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const last24h = await db.usage.getProfileStats('team', { since: since24h });
    expect(last24h).not.toBeNull();
    expect(last24h!.total_calls).toBe(2);
  });

  it('usage summary aggregates by caller', async () => {
    await seedUsage();
    const byCaller = await db.usage.getStatsByCaller();
    expect(byCaller.length).toBeGreaterThanOrEqual(2);
    const chatCaller = byCaller.find((c) => c.caller === 'chat');
    const compilerCaller = byCaller.find((c) => c.caller === 'compiler');
    expect(chatCaller).toBeDefined();
    expect(compilerCaller).toBeDefined();
    expect(chatCaller!.total_calls).toBe(1);
    expect(compilerCaller!.total_calls).toBe(1);
  });

  it('usage summary returns global totals', async () => {
    await seedUsage();
    const total = await db.usage.getTotalStats();
    expect(total.total_calls).toBe(2);
    expect(total.total_input_tokens).toBe(6000);
    expect(total.total_output_tokens).toBe(3500);
  });

  it('recent usage returns ordered records', async () => {
    await seedUsage();
    const recent = await db.usage.getRecentUsage('team', 10);
    expect(recent).toHaveLength(2);
    // Most recent first
    expect(new Date(recent[0].created_at).getTime()).toBeGreaterThanOrEqual(new Date(recent[1].created_at).getTime());
  });
});

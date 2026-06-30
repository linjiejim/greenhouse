/**
 * Tests for LLM Usage Repository.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '@greenhouse/db';
import type { DatabaseProvider, UsageRecord } from '@greenhouse/db';

let db: DatabaseProvider;

beforeEach(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test' });
  await db.resetSchema();
});

// Helper to insert a usage record
async function insertUsage(overrides: Partial<UsageRecord> = {}): Promise<void> {
  await db.usage.record({
    profile_id: 'default',
    caller: 'chat',
    model: 'deepseek-v4-flash',
    input_tokens: 1000,
    output_tokens: 500,
    cached_tokens: 200,
    reasoning_tokens: 0,
    duration_ms: 2000,
    ...overrides,
  });
}

describe('Usage Repository: record & read', () => {
  it('records a usage entry and retrieves it', async () => {
    await insertUsage();
    const recent = await db.usage.getRecentUsage(undefined, 10);
    expect(recent).toHaveLength(1);
    expect(recent[0].profile_id).toBe('default');
    expect(recent[0].caller).toBe('chat');
    expect(recent[0].input_tokens).toBe(1000);
    expect(recent[0].output_tokens).toBe(500);
    expect(recent[0].cached_tokens).toBe(200);
    expect(recent[0].duration_ms).toBe(2000);
    expect(recent[0].id).toBeGreaterThan(0);
    expect(recent[0].created_at).toBeTruthy();
  });

  it('records with optional fields null', async () => {
    await db.usage.record({
      profile_id: 'wiki-manager',
      caller: 'compiler',
      model: 'deepseek-v4-flash',
      input_tokens: 5000,
      output_tokens: 3000,
    });
    const recent = await db.usage.getRecentUsage('wiki-manager', 10);
    expect(recent).toHaveLength(1);
    expect(recent[0].cached_tokens).toBe(0);
    expect(recent[0].reasoning_tokens).toBe(0);
    expect(recent[0].duration_ms).toBeNull();
  });

  it('getRecentUsage filters by profile', async () => {
    await insertUsage({ profile_id: 'a' });
    await insertUsage({ profile_id: 'b' });
    await insertUsage({ profile_id: 'a' });

    const recentA = await db.usage.getRecentUsage('a', 10);
    expect(recentA).toHaveLength(2);
    expect(recentA.every(r => r.profile_id === 'a')).toBe(true);

    const recentAll = await db.usage.getRecentUsage(undefined, 10);
    expect(recentAll).toHaveLength(3);
  });

  it('getRecentUsage respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await insertUsage();
    }
    const recent = await db.usage.getRecentUsage(undefined, 3);
    expect(recent).toHaveLength(3);
  });
});

describe('Usage Repository: getStatsByProfile', () => {
  it('aggregates by profile correctly', async () => {
    await insertUsage({ profile_id: 'default', input_tokens: 100, output_tokens: 50, duration_ms: 1000 });
    await insertUsage({ profile_id: 'default', input_tokens: 200, output_tokens: 100, duration_ms: 3000 });
    await insertUsage({ profile_id: 'wiki-manager', input_tokens: 500, output_tokens: 300, duration_ms: 5000 });

    const stats = await db.usage.getStatsByProfile();
    expect(stats).toHaveLength(2);

    const defaultStats = stats.find(s => s.profile_id === 'default')!;
    expect(defaultStats.total_calls).toBe(2);
    expect(defaultStats.total_input_tokens).toBe(300);
    expect(defaultStats.total_output_tokens).toBe(150);
    expect(defaultStats.total_duration_ms).toBe(4000);
    expect(defaultStats.avg_duration_ms).toBe(2000);
    expect(defaultStats.last_used_at).toBeTruthy();

    const wikiStats = stats.find(s => s.profile_id === 'wiki-manager')!;
    expect(wikiStats.total_calls).toBe(1);
    expect(wikiStats.total_input_tokens).toBe(500);
  });

  it('returns empty array when no data', async () => {
    const stats = await db.usage.getStatsByProfile();
    expect(stats).toEqual([]);
  });
});

describe('Usage Repository: getProfileStats', () => {
  it('returns stats for a specific profile', async () => {
    await insertUsage({ profile_id: 'default', input_tokens: 100 });
    await insertUsage({ profile_id: 'default', input_tokens: 200 });
    await insertUsage({ profile_id: 'other', input_tokens: 999 });

    const stats = await db.usage.getProfileStats('default');
    expect(stats).not.toBeNull();
    expect(stats!.total_calls).toBe(2);
    expect(stats!.total_input_tokens).toBe(300);
  });

  it('returns null for non-existent profile', async () => {
    const stats = await db.usage.getProfileStats('nonexistent');
    expect(stats).toBeNull();
  });

  it('supports since filter', async () => {
    await insertUsage({ profile_id: 'default' });

    // Query with a future timestamp → should return null
    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const stats = await db.usage.getProfileStats('default', { since: futureDate });
    expect(stats).toBeNull();

    // Query with a past timestamp → should return data
    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const stats2 = await db.usage.getProfileStats('default', { since: pastDate });
    expect(stats2).not.toBeNull();
    expect(stats2!.total_calls).toBe(1);
  });
});

describe('Usage Repository: getStatsByCaller', () => {
  it('aggregates by caller correctly', async () => {
    await insertUsage({ caller: 'chat', input_tokens: 100 });
    await insertUsage({ caller: 'chat', input_tokens: 200 });
    await insertUsage({ caller: 'compiler', input_tokens: 500 });
    await insertUsage({ caller: 'judge', input_tokens: 300 });

    const stats = await db.usage.getStatsByCaller();
    expect(stats).toHaveLength(3);

    const chatStats = stats.find(s => s.caller === 'chat')!;
    expect(chatStats.total_calls).toBe(2);
    expect(chatStats.total_input_tokens).toBe(300);

    const compilerStats = stats.find(s => s.caller === 'compiler')!;
    expect(compilerStats.total_calls).toBe(1);
    expect(compilerStats.total_input_tokens).toBe(500);
  });

  it('returns empty when no data', async () => {
    const stats = await db.usage.getStatsByCaller();
    expect(stats).toEqual([]);
  });
});

describe('Usage Repository: getTotalStats', () => {
  it('returns global totals', async () => {
    await insertUsage({ input_tokens: 100, output_tokens: 50, cached_tokens: 10, reasoning_tokens: 5 });
    await insertUsage({ input_tokens: 200, output_tokens: 100, cached_tokens: 20, reasoning_tokens: 10 });

    const total = await db.usage.getTotalStats();
    expect(total.total_calls).toBe(2);
    expect(total.total_input_tokens).toBe(300);
    expect(total.total_output_tokens).toBe(150);
    expect(total.total_cached_tokens).toBe(30);
    expect(total.total_reasoning_tokens).toBe(15);
  });

  it('returns zeros when no data', async () => {
    const total = await db.usage.getTotalStats();
    expect(total.total_calls).toBe(0);
    expect(total.total_input_tokens).toBe(0);
    expect(total.total_output_tokens).toBe(0);
  });

  it('supports since filter', async () => {
    await insertUsage({ input_tokens: 100 });

    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const total = await db.usage.getTotalStats({ since: futureDate });
    expect(total.total_calls).toBe(0);

    const pastDate = new Date(Date.now() - 86400000).toISOString();
    const total2 = await db.usage.getTotalStats({ since: pastDate });
    expect(total2.total_calls).toBe(1);
  });
});

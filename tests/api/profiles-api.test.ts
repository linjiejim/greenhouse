/**
 * Tests for Profile API routes (/api/profiles).
 *
 * Verifies that profiles are returned with usage data.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { initDatabase, getDb } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

let db: DatabaseProvider;

beforeAll(async () => {
  db = await initDatabase({ type: 'pg', pgConnectionString: 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test' });
  await db.resetSchema();
});

describe('Profile API: usage integration', () => {
  it('profiles list includes null usage when empty', async () => {
    const stats = await db.usage.getStatsByProfile();
    // No records inserted → empty
    expect(stats).toEqual([]);
  });

  it('usage stats appear after recording', async () => {
    await db.usage.record({
      profile_id: 'default',
      caller: 'chat',
      model: 'deepseek-v4-flash',
      input_tokens: 1000,
      output_tokens: 500,
      duration_ms: 2000,
    });
    await db.usage.record({
      profile_id: 'default',
      caller: 'compiler',
      model: 'deepseek-v4-flash',
      input_tokens: 5000,
      output_tokens: 3000,
      duration_ms: 8000,
    });

    const stats = await db.usage.getStatsByProfile();
    expect(stats).toHaveLength(1);
    expect(stats[0].profile_id).toBe('default');
    expect(stats[0].total_calls).toBe(2);
    expect(stats[0].total_input_tokens).toBe(6000);
    expect(stats[0].total_output_tokens).toBe(3500);
  });

  it('profile detail returns time-bucketed stats', async () => {
    const total = await db.usage.getProfileStats('default');
    expect(total).not.toBeNull();
    expect(total!.total_calls).toBe(2);

    // Since we just inserted, all records should be within 24h
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const last24h = await db.usage.getProfileStats('default', { since: since24h });
    expect(last24h).not.toBeNull();
    expect(last24h!.total_calls).toBe(2);
  });

  it('usage summary aggregates by caller', async () => {
    const byCaller = await db.usage.getStatsByCaller();
    expect(byCaller.length).toBeGreaterThanOrEqual(2);
    const chatCaller = byCaller.find(c => c.caller === 'chat');
    const compilerCaller = byCaller.find(c => c.caller === 'compiler');
    expect(chatCaller).toBeDefined();
    expect(compilerCaller).toBeDefined();
    expect(chatCaller!.total_calls).toBe(1);
    expect(compilerCaller!.total_calls).toBe(1);
  });

  it('usage summary returns global totals', async () => {
    const total = await db.usage.getTotalStats();
    expect(total.total_calls).toBe(2);
    expect(total.total_input_tokens).toBe(6000);
    expect(total.total_output_tokens).toBe(3500);
  });

  it('recent usage returns ordered records', async () => {
    const recent = await db.usage.getRecentUsage('default', 10);
    expect(recent).toHaveLength(2);
    // Most recent first
    expect(new Date(recent[0].created_at).getTime()).toBeGreaterThanOrEqual(
      new Date(recent[1].created_at).getTime()
    );
  });
});

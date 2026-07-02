/**
 * Admin Analytics service integration tests (real PostgreSQL).
 *
 * The load-bearing assertions here are the PRIVACY invariants: session listings
 * must never carry a title, and error listings must never carry the llm_call
 * input/output/system prompts. The rest lock the aggregation shapes the
 * admin_analytics tool depends on.
 *
 * Requires: PostgreSQL at localhost:5432 with the greenhouse_test database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, _resetProvider } from '@greenhouse/db';
import type { DatabaseProvider } from '@greenhouse/db';

const PG_URL = 'postgresql://greenhouse:greenhouse@localhost:5432/greenhouse_test';
let db: DatabaseProvider;

/** Seed one internal + one external app session with usage, audit and error rows. */
async function seed() {
  // Internal user session (web) with two user messages + one assistant message.
  const sInt = await db.sessions.create('Internal secret title', 'default', 'u1', undefined, 'web');
  await db.sessions.addMessage({ session_id: sInt.id, role: 'user', content: 'hello' });
  await db.sessions.addMessage({ session_id: sInt.id, role: 'user', content: 'again' });
  await db.sessions.addMessage({
    session_id: sInt.id,
    role: 'assistant',
    content: 'hi',
    input_tokens: 100,
    output_tokens: 50,
  });
  await db.usage.record({
    profile_id: 'default',
    caller: 'chat',
    user_id: 'u1',
    session_id: sInt.id,
    model: 'gpt-4o',
    input_tokens: 100,
    output_tokens: 50,
  });
  await db.usage.record({
    profile_id: 'default',
    caller: 'chat',
    user_id: 'u1',
    session_id: sInt.id,
    model: 'gpt-4o',
    input_tokens: 100,
    output_tokens: 50,
  });
  // One failed llm_call carrying a would-be-secret prompt + output.
  await db.llmCalls.record({
    session_id: sInt.id,
    model: 'gpt-4o',
    system: 'SYSTEM SECRET',
    input: 'INPUT SECRET',
    output: 'OUTPUT SECRET',
    status: 'error',
    error: 'rate limited',
  });

  // External (v1/chat) app session — no internal user, app_id set, channel 'api'.
  const sExt = await db.sessions.create('External secret title', 'default', undefined, 'app1', 'api');
  await db.sessions.addMessage({ session_id: sExt.id, role: 'user', content: 'ext hello' });
  await db.usage.record({
    profile_id: 'default',
    caller: 'api',
    session_id: sExt.id,
    model: 'gpt-4o',
    input_tokens: 200,
    output_tokens: 100,
  });
  await db.apiAudit.record({
    app_id: 'app1',
    endpoint: '/api/v1/chat/completions',
    method: 'POST',
    session_id: sExt.id,
    ext_user_id: 'ext-a',
    status_code: 200,
    input_tokens: 200,
    output_tokens: 100,
  });
  await db.apiAudit.record({
    app_id: 'app1',
    endpoint: '/api/v1/chat/completions',
    method: 'POST',
    session_id: sExt.id,
    ext_user_id: 'ext-b',
    status_code: 500,
    error: 'boom',
  });

  return { sInt, sExt };
}

describe('Admin Analytics service', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: PG_URL });
    await db.resetSchema();
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  // ─── PRIVACY invariants ────────────────────────────────

  it('listSessions returns metadata but NEVER a title', async () => {
    await seed();
    const list = await db.adminAnalytics.listSessions({});
    expect(list.length).toBe(2);
    for (const row of list) {
      expect('title' in row).toBe(false);
      expect(row).toHaveProperty('message_count');
      expect(row).toHaveProperty('total_tokens');
    }
  });

  it('errorStats.llm_recent exposes the error string but NEVER input/output/system', async () => {
    await seed();
    const report = await db.adminAnalytics.errorStats({});
    expect(report.llm_recent.length).toBe(1);
    const rec = report.llm_recent[0];
    expect(rec.error).toBe('rate limited');
    expect('input' in rec).toBe(false);
    expect('output' in rec).toBe(false);
    expect('system' in rec).toBe(false);
    // No seeded secret leaks through any field of the record.
    expect(JSON.stringify(rec)).not.toContain('SECRET');
  });

  // ─── Aggregation shapes ────────────────────────────────

  it('userActivity aggregates per-user calls, messages and active-user counts', async () => {
    await seed();
    const summary = await db.adminAnalytics.userActivity({});
    expect(summary.active_1d).toBe(1);
    const u1 = summary.users.find((u) => u.user_id === 'u1');
    expect(u1).toBeDefined();
    expect(u1!.calls).toBe(2);
    expect(u1!.user_messages).toBe(2); // two role='user' messages
    expect(u1!.session_count).toBe(1);
  });

  it('usageByDimension(model) sums calls and tokens across sessions', async () => {
    await seed();
    const rows = await db.adminAnalytics.usageByDimension({ dimension: 'model' });
    const gpt = rows.find((r) => r.key === 'gpt-4o');
    expect(gpt).toBeDefined();
    expect(gpt!.calls).toBe(3); // 2 internal + 1 api
    expect(gpt!.input_tokens).toBe(400); // 100 + 100 + 200
  });

  it('listSessions filters by channel and by ext_user_id', async () => {
    const { sExt } = await seed();
    const apiOnly = await db.adminAnalytics.listSessions({ channel: 'api' });
    expect(apiOnly.map((s) => s.id)).toEqual([sExt.id]);

    const byExt = await db.adminAnalytics.listSessions({ extUserId: 'ext-a' });
    expect(byExt.map((s) => s.id)).toEqual([sExt.id]);

    const byMissingExt = await db.adminAnalytics.listSessions({ extUserId: 'nobody' });
    expect(byMissingExt.length).toBe(0);
  });

  it('apiClientStats computes error and distinct-ext-user counts', async () => {
    await seed();
    const stats = await db.adminAnalytics.apiClientStats({});
    const app1 = stats.find((s) => s.app_id === 'app1');
    expect(app1).toBeDefined();
    expect(app1!.total_calls).toBe(2);
    expect(app1!.error_calls).toBe(1); // the 500
    expect(app1!.ext_user_count).toBe(2); // ext-a + ext-b
    expect(app1!.session_count).toBe(1);
  });

  it('usageByApp attributes model-level usage to the app via its sessions', async () => {
    await seed();
    const rows = await db.adminAnalytics.usageByApp({});
    const app1 = rows.find((r) => r.key === 'app1');
    expect(app1).toBeDefined();
    expect(app1!.model).toBe('gpt-4o');
    expect(app1!.input_tokens).toBe(200);
  });

  it('extUserStats and extActivityDaily surface external-user granularity', async () => {
    await seed();
    const top = await db.adminAnalytics.extUserStats({});
    const ids = top.map((u) => u.ext_user_id).sort();
    expect(ids).toEqual(['ext-a', 'ext-b']);
    const extB = top.find((u) => u.ext_user_id === 'ext-b');
    expect(extB!.error_calls).toBe(1);

    const daily = await db.adminAnalytics.extActivityDaily({});
    expect(daily.length).toBeGreaterThanOrEqual(1);
    const totalActive = daily.reduce((n, d) => Math.max(n, d.active_ext_users), 0);
    expect(totalActive).toBe(2);
  });
});

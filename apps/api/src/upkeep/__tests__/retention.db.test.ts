/**
 * Daily retention cleanup (data model principle 5) against real PostgreSQL.
 *
 * Every case builds its own rows with ids unique to the run and asserts only on
 * them: the sweep is table-wide, and other workers' committed rows may be in
 * the same tables.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { initDatabase, _resetProvider, type DatabaseProvider } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { runRetention } from '../retention.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
const tag = () => randomBytes(5).toString('hex');
const NOW = new Date('2026-10-25T00:00:00Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

async function exists(table: string, column: string, value: string): Promise<boolean> {
  const rows = await db.executeRaw(
    sql`SELECT 1 FROM ${sql.identifier(table)} WHERE ${sql.identifier(column)} = ${value}`,
  );
  return rows.length > 0;
}

async function run(id: string, status: string): Promise<void> {
  await db.executeRaw(sql`
    INSERT INTO runs (id, kind, owner_user_id, initiated_by_user_id, root_run_id, source_kind, source_id, status)
    VALUES (${id}, 'chat', 'u', 'u', ${id}, 'test', ${id}, ${status})`);
}

async function event(id: string, runId: string, seq: number, at: string): Promise<void> {
  await db.executeRaw(sql`
    INSERT INTO run_events (id, run_id, seq, type, created_at) VALUES (${id}, ${runId}, ${seq}, 'test', ${at}::timestamptz)`);
}

async function outbox(id: string, eventId: string, status: string, deliveredAt: string | null): Promise<void> {
  await db.executeRaw(sql`
    INSERT INTO run_outbox (id, event_id, topic, status, available_at, delivered_at)
    VALUES (${id}, ${eventId}, 'runtime.events', ${status}, now(), ${deliveredAt}::timestamptz)`);
}

describe('retention cleanup', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  });

  afterEach(async () => {
    await db.close();
    _resetProvider();
  });

  it('drops run events older than 30 days of settled runs, unless an outbox row still waits on one', async () => {
    const t = tag();
    await run(`done_${t}`, 'succeeded');
    await run(`live_${t}`, 'running');
    await event(`old_${t}`, `done_${t}`, 1, daysAgo(31));
    await event(`waiting_${t}`, `done_${t}`, 2, daysAgo(31));
    await event(`recent_${t}`, `done_${t}`, 3, daysAgo(29));
    await event(`active_${t}`, `live_${t}`, 1, daysAgo(90));
    await outbox(`ob_wait_${t}`, `waiting_${t}`, 'pending', null);

    await db.retention.run({ now: NOW });

    expect(await exists('run_events', 'id', `old_${t}`)).toBe(false);
    expect(await exists('run_events', 'id', `waiting_${t}`)).toBe(true);
    expect(await exists('run_events', 'id', `recent_${t}`)).toBe(true);
    expect(await exists('run_events', 'id', `active_${t}`)).toBe(true);
    // The run itself is permanent history.
    expect(await exists('runs', 'id', `done_${t}`)).toBe(true);
  });

  it('drops outbox rows 7 days after delivery and keeps undelivered ones', async () => {
    const t = tag();
    await run(`r_${t}`, 'running');
    await event(`e1_${t}`, `r_${t}`, 1, daysAgo(1));
    await event(`e2_${t}`, `r_${t}`, 2, daysAgo(1));
    await event(`e3_${t}`, `r_${t}`, 3, daysAgo(1));
    await outbox(`old_${t}`, `e1_${t}`, 'delivered', daysAgo(8));
    await outbox(`fresh_${t}`, `e2_${t}`, 'delivered', daysAgo(6));
    await outbox(`dead_${t}`, `e3_${t}`, 'dead_letter', null);

    await db.retention.run({ now: NOW });

    expect(await exists('run_outbox', 'id', `old_${t}`)).toBe(false);
    expect(await exists('run_outbox', 'id', `fresh_${t}`)).toBe(true);
    expect(await exists('run_outbox', 'id', `dead_${t}`)).toBe(true);
  });

  it('applies the request-log, ledger and delivery windows', async () => {
    const t = tag();
    await db.executeRaw(sql`
      INSERT INTO request_log (id, app_id, endpoint, method, created_at) VALUES
        (${`old_${t}`}, 'mcp', '/api/mcp', 'POST', ${daysAgo(31)}::timestamptz),
        (${`new_${t}`}, 'mcp', '/api/mcp', 'POST', ${daysAgo(29)}::timestamptz)`);
    await db.executeRaw(sql`
      INSERT INTO budget_ledger (id, account_id, operation_key, entry_type, reserved_units_after, spent_units_after, created_at) VALUES
        (${`old_${t}`}, ${`acct_${t}`}, ${`op1_${t}`}, 'settle', 0, 0, ${daysAgo(400)}::timestamptz),
        (${`new_${t}`}, ${`acct_${t}`}, ${`op2_${t}`}, 'settle', 0, 0, ${daysAgo(380)}::timestamptz)`);
    await db.executeRaw(sql`
      INSERT INTO notifications (id, user_id, kind, title, body, dedupe_key) VALUES (${`n_${t}`}, 'u', 'system', 't', 'b', ${t})`);
    await db.executeRaw(sql`
      INSERT INTO notification_deliveries (id, notification_id, channel, recipient, status, available_at, updated_at) VALUES
        (${`done_${t}`}, ${`n_${t}`}, 'feishu', 'a', 'delivered', now(), ${daysAgo(8)}::timestamptz),
        (${`pending_${t}`}, ${`n_${t}`}, 'wecom', 'a', 'pending', now(), ${daysAgo(8)}::timestamptz),
        (${`gone_${t}`}, ${`n_${t}`}, 'mobile_push', 'a', 'failed', now(), ${daysAgo(8)}::timestamptz)`);

    await db.retention.run({ now: NOW });

    expect(await exists('request_log', 'id', `old_${t}`)).toBe(false);
    expect(await exists('request_log', 'id', `new_${t}`)).toBe(true);
    expect(await exists('budget_ledger', 'id', `old_${t}`)).toBe(false);
    expect(await exists('budget_ledger', 'id', `new_${t}`)).toBe(true);
    expect(await exists('notification_deliveries', 'id', `done_${t}`)).toBe(false);
    expect(await exists('notification_deliveries', 'id', `pending_${t}`)).toBe(true);
    // `failed` (recipient gone) is final, like delivered / dead_letter / suppressed.
    expect(await exists('notification_deliveries', 'id', `gone_${t}`)).toBe(false);
  });

  it('removes expired credentials and leaves live ones', async () => {
    const t = tag();
    const user = await createInternalTestUser(db, { email: `ret_${t}@example.test` });
    await db.executeRaw(sql`
      INSERT INTO auth_refresh_tokens (id, user_id, token_hash, expires_at) VALUES
        (${`dead_${t}`}, ${user.id}, ${`h1_${t}`}, ${daysAgo(1)}::timestamptz),
        (${`live_${t}`}, ${user.id}, ${`h2_${t}`}, ${daysAgo(-1)}::timestamptz)`);
    await db.executeRaw(sql`
      INSERT INTO login_states (id, provider, kind, expires_at) VALUES (${`dead_${t}`}, 'feishu', 'pending', ${daysAgo(1)}::timestamptz)`);
    await db.executeRaw(
      sql`INSERT INTO rate_limits (key, count, expires_at) VALUES (${`dead_${t}`}, 1, ${daysAgo(1)}::timestamptz)`,
    );

    const report = await db.retention.run({ now: NOW });

    expect(await exists('auth_refresh_tokens', 'id', `dead_${t}`)).toBe(false);
    expect(await exists('auth_refresh_tokens', 'id', `live_${t}`)).toBe(true);
    expect(await exists('login_states', 'id', `dead_${t}`)).toBe(false);
    expect(await exists('rate_limits', 'key', `dead_${t}`)).toBe(false);
    expect(report.auth_refresh_tokens).toBeGreaterThanOrEqual(1);
  });

  it('keeps client error reports 90 days and at most the newest 10,000', async () => {
    const t = tag();
    const insert = (id: string, at: string) =>
      db.executeRaw(sql`
        INSERT INTO client_reports (id, user_id, client_report_id, fingerprint, fatal, source, name, message, platform, occurred_at, created_at)
        VALUES (${id}, 'u', ${id}, 'f', false, 'global', 'Error', 'm', 'ios', ${at}::timestamptz, ${at}::timestamptz)`);
    await insert(`old_${t}`, daysAgo(91));
    await insert(`new_${t}`, daysAgo(89));
    const report = await db.retention.run({ now: NOW });
    expect(await exists('client_reports', 'id', `old_${t}`)).toBe(false);
    expect(await exists('client_reports', 'id', `new_${t}`)).toBe(true);
    expect(report.client_reports).toBeGreaterThanOrEqual(1);

    // a crash storm: the oldest rows beyond the cap go, however recent
    await db.executeRaw(sql`
      INSERT INTO client_reports (id, user_id, client_report_id, fingerprint, fatal, source, name, message, platform, occurred_at, created_at)
      SELECT ${`cap_${t}_`} || g, 'u', ${`cap_${t}_`} || g, 'f', false, 'global', 'Error', 'm', 'ios', now(),
             ${daysAgo(10)}::timestamptz + g * interval '1 second'
      FROM generate_series(1, 10005) g`);
    await db.retention.run({ now: NOW, batchSize: 2000 });
    const left = await db.executeRaw(sql`SELECT count(*)::int AS n FROM client_reports`);
    expect(Number(left[0].n)).toBeLessThanOrEqual(10_000);
    expect(await exists('client_reports', 'id', `new_${t}`)).toBe(false);
    for (const g of [1, 2, 3, 4, 5]) expect(await exists('client_reports', 'id', `cap_${t}_${g}`)).toBe(false);
    expect(await exists('client_reports', 'id', `cap_${t}_6`)).toBe(true);
    expect(await exists('client_reports', 'id', `cap_${t}_10005`)).toBe(true);
  });

  it('deletes in bounded batches until the backlog is gone', async () => {
    const t = tag();
    await db.executeRaw(sql`
      INSERT INTO request_log (id, app_id, endpoint, method, created_at)
      SELECT ${`b_${t}_`} || g, 'mcp', '/api/mcp', 'POST', ${daysAgo(40)}::timestamptz FROM generate_series(1, 25) g`);
    const report = await db.retention.run({ now: NOW, batchSize: 7 });
    expect(report.request_log).toBeGreaterThanOrEqual(25);
    const left = await db.executeRaw(sql`SELECT count(*)::int AS n FROM request_log WHERE id LIKE ${`b_${t}_%`}`);
    expect(Number(left[0].n)).toBe(0);
  });

  it('the daily job records its counts and runs at most once in 20 hours', async () => {
    const first = await runRetention(db, NOW);
    expect(first.ran).toBe(true);
    const again = await runRetention(db, new Date(NOW.getTime() + 3_600_000));
    expect(again).toEqual({ ran: false, reason: 'recent_run' });
    const events = await db.platform.listAuditEventsForApp('default', 'platform', 10);
    const recorded = events.find((event) => event.action_id === 'retentionCleanup');
    expect(recorded?.summary).toHaveProperty('run_events');
    const tomorrow = await runRetention(db, new Date(NOW.getTime() + 21 * 3_600_000));
    expect(tomorrow.ran).toBe(true);
  });
});

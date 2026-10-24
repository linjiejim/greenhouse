/**
 * Retention — the daily cleanup of high-growth tables (data model principle 5).
 *
 *   run_events               30 days, only for settled runs and only when none of
 *                            the event's outbox rows is still waiting to deliver
 *   run_outbox               7 days after delivery
 *   request_log              30 days
 *   feishu_receipts          7 days
 *   budget_ledger            13 months
 *   notification_deliveries  7 days after reaching a terminal state
 *   expired credentials      refresh tokens, OAuth codes / tokens, login states,
 *                            rate-limit buckets, password links (30 days past expiry)
 *
 * Deletes run in bounded batches (`batchSize` rows per statement) so a large
 * backlog never holds one long lock. Pure data: the API's scheduler job decides
 * when to run it and records the result.
 */

import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client.js';

export const RETENTION_POLICY = {
  runEventsDays: 30,
  deliveredOutboxDays: 7,
  requestLogDays: 30,
  feishuReceiptDays: 7,
  ledgerMonths: 13,
  deliveriesDays: 7,
  expiredPasswordLinkDays: 30,
} as const;

export type RetentionTarget =
  | 'run_events'
  | 'run_outbox'
  | 'request_log'
  | 'feishu_receipts'
  | 'budget_ledger'
  | 'notification_deliveries'
  | 'auth_refresh_tokens'
  | 'oauth_codes'
  | 'oauth_tokens'
  | 'login_states'
  | 'rate_limits'
  | 'password_links';

export type RetentionReport = Record<RetentionTarget, number>;

export interface RetentionOptions {
  /** The instant cutoffs are computed from (tests pass a fixed one). */
  now?: Date;
  batchSize?: number;
  /** Safety valve: stop a target after this many batches in one run. */
  maxBatches?: number;
}

const TERMINAL_RUNS = sql.raw(`('succeeded', 'failed', 'canceled', 'interrupted')`);
const UNDELIVERED_OUTBOX = sql.raw(`('pending', 'claimed', 'failed')`);
const TERMINAL_DELIVERIES = sql.raw(`('delivered', 'dead_letter', 'suppressed')`);

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function monthsBefore(now: Date, months: number): string {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  return cutoff.toISOString();
}

export function createRetentionService(db: Db) {
  /** Delete rows of `table` keyed by `key` that `where` selects, batch by batch. */
  async function sweep(table: string, key: string, where: SQL, batchSize: number, maxBatches: number): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch++) {
      const rows = (await db.execute(sql`
        DELETE FROM ${sql.identifier(table)}
        WHERE ${sql.identifier(key)} IN (
          SELECT ${sql.identifier(key)} FROM ${sql.identifier(table)} WHERE ${where} LIMIT ${batchSize}
        )
        RETURNING 1 AS gone`)) as unknown as unknown[];
      total += rows.length;
      if (rows.length < batchSize) break;
    }
    return total;
  }

  const service = {
    /** Apply every retention rule once and report how many rows each removed. */
    async run(options: RetentionOptions = {}): Promise<RetentionReport> {
      const now = options.now ?? new Date();
      const nowIso = now.toISOString();
      const batch = Math.max(1, Math.trunc(options.batchSize ?? 5000));
      const maxBatches = Math.max(1, Math.trunc(options.maxBatches ?? 1000));
      const go = (table: string, key: string, where: SQL) => sweep(table, key, where, batch, maxBatches);

      const report = {} as RetentionReport;
      // Outbox first: a delivered row older than its window goes regardless of its event.
      report.run_outbox = await go(
        'run_outbox',
        'id',
        sql`status = 'delivered' AND delivered_at < ${daysBefore(now, RETENTION_POLICY.deliveredOutboxDays)}::timestamptz`,
      );
      report.run_events = await go(
        'run_events',
        'id',
        sql`created_at < ${daysBefore(now, RETENTION_POLICY.runEventsDays)}::timestamptz
          AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_events.run_id AND r.status IN ${TERMINAL_RUNS})
          AND NOT EXISTS (SELECT 1 FROM run_outbox o WHERE o.event_id = run_events.id AND o.status IN ${UNDELIVERED_OUTBOX})`,
      );
      report.request_log = await go(
        'request_log',
        'id',
        sql`created_at < ${daysBefore(now, RETENTION_POLICY.requestLogDays)}::timestamptz`,
      );
      report.feishu_receipts = await go(
        'feishu_receipts',
        'message_id',
        sql`received_at < ${daysBefore(now, RETENTION_POLICY.feishuReceiptDays)}::timestamptz`,
      );
      report.budget_ledger = await go(
        'budget_ledger',
        'id',
        sql`created_at < ${monthsBefore(now, RETENTION_POLICY.ledgerMonths)}::timestamptz`,
      );
      report.notification_deliveries = await go(
        'notification_deliveries',
        'id',
        sql`status IN ${TERMINAL_DELIVERIES} AND updated_at < ${daysBefore(now, RETENTION_POLICY.deliveriesDays)}::timestamptz`,
      );
      report.auth_refresh_tokens = await go('auth_refresh_tokens', 'id', sql`expires_at <= ${nowIso}::timestamptz`);
      report.oauth_codes = await go('oauth_codes', 'code_hash', sql`expires_at <= ${nowIso}::timestamptz`);
      report.oauth_tokens = await go('oauth_tokens', 'id', sql`expires_at <= ${nowIso}::timestamptz`);
      report.login_states = await go('login_states', 'id', sql`expires_at <= ${nowIso}::timestamptz`);
      report.rate_limits = await go('rate_limits', 'key', sql`expires_at <= ${nowIso}::timestamptz`);
      report.password_links = await go(
        'password_links',
        'id',
        sql`expires_at < ${daysBefore(now, RETENTION_POLICY.expiredPasswordLinkDays)}::timestamptz`,
      );
      return report;
    },
  };
  return service;
}

export type RetentionService = ReturnType<typeof createRetentionService>;

/**
 * Daily retention cleanup (data model principle 5): run events 30 days,
 * delivered outbox 7 days, request log 30 days, Feishu receipts 7 days, budget
 * ledger 13 months, terminal notification deliveries 7 days, and expired
 * credentials. The rules live in `db.retention` (packages/db/src/services/retention.ts).
 *
 * Every API process schedules it, but a run is skipped when the audit log
 * already has one from the last 20 hours — so blue/green slots or replicas
 * clean once a day, and a restart doesn't re-run it. Each run is recorded as an
 * audit event (`platform` / `retentionCleanup`) whose summary holds the row
 * counts, which is how an admin sees what was removed.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseProvider, RetentionReport } from '@greenhouse/db';
import { logger } from '@greenhouse/utils/logger';
import { PLATFORM_ORG_ID } from '../platform/runtime.js';

export const RETENTION_ACTION = 'retentionCleanup';
const MIN_INTERVAL_MS = 20 * 3_600_000;
const DAY_MS = 24 * 3_600_000;

export type RetentionOutcome = { ran: true; report: RetentionReport } | { ran: false; reason: 'recent_run' };

/** Run the cleanup unless another process did within the last 20 hours. */
export async function runRetention(db: DatabaseProvider, now: Date = new Date()): Promise<RetentionOutcome> {
  const recent = await db.platform.listAuditEventsForApp(PLATFORM_ORG_ID, 'platform', 50);
  const last = recent.find((event) => event.action_id === RETENTION_ACTION);
  if (last && now.getTime() - Date.parse(last.created_at) < MIN_INTERVAL_MS) {
    return { ran: false, reason: 'recent_run' };
  }
  const report = await db.retention.run({ now });
  await db.platform.recordAudit({
    orgId: PLATFORM_ORG_ID,
    actorId: 'retention',
    actorType: 'system',
    requestId: randomUUID(),
    resource: { appId: 'platform' },
    actionId: RETENTION_ACTION,
    capability: 'platform.system.retention',
    result: 'success',
    summary: { ...report },
    createdAt: now.toISOString(),
  });
  const removed = Object.values(report).reduce((sum, count) => sum + count, 0);
  logger.info('[upkeep] retention cleanup', { removed, ...report });
  return { ran: true, report };
}

/** First run ten minutes after boot, then once a day. Never throws. */
export function scheduleRetention(db: DatabaseProvider): void {
  const tick = () =>
    void runRetention(db).catch((error) =>
      logger.warn('[upkeep] retention cleanup failed', {
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  setTimeout(() => {
    tick();
    setInterval(tick, DAY_MS).unref?.();
  }, 10 * 60_000).unref?.();
}

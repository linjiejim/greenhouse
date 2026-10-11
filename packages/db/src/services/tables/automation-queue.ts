/**
 * The automation queue: what the API's worker and minute sweep need from the
 * database. Execution itself lives in `apps/api/src/platform/tables/` — this
 * module only leases, checkpoints and settles outbox rows, keeps their run
 * rows, and answers the sweep's "which rules / records are due" questions.
 *
 * Leases follow `notification_delivery_attempts` (services/notifications.ts):
 * SKIP LOCKED claim, `version` CAS on every later write, an expired lease goes
 * back to pending (or dead letter after the last attempt). Only rows written by
 * the async enqueue path (`rule_revision IS NOT NULL`) are ever claimed.
 *
 * `attempts` counts claims of the current action: a delay or a successful
 * action resets it, so `max_attempts` bounds the retries of one webhook, not
 * the length of a rule.
 */

import { and, asc, eq, gt, inArray, isNotNull, isNull, lte, sql, type SQL } from 'drizzle-orm';
import type { TableAutomationRunStep, TableAutomationTrigger } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import {
  tableAutomationOutbox,
  tableAutomationRules,
  tableAutomationRuns,
  tableFields,
  tableRecords,
} from '../../schema/index.js';
import type { TableAutomationOutboxRow, TableAutomationRuleRow, TableAutomationRunRow } from '../../schema/tables.js';
import { compileRuleCondition, insertOutbox } from './automations.js';

export class TablesAutomationLeaseLostError extends Error {
  constructor() {
    super('Automation outbox lease is no longer owned');
    this.name = 'TablesAutomationLeaseLostError';
  }
}

interface LeaseRef {
  id: number;
  expectedVersion: number;
  workerId: string;
  at?: Date;
}

function iso(at: Date | undefined): string {
  return (at ?? new Date()).toISOString();
}

export function createTablesAutomationQueue(db: Db) {
  /** One leased write: `set` applies only while the lease is still ours. */
  const leased = async (ref: LeaseRef, set: Partial<typeof tableAutomationOutbox.$inferInsert>) => {
    const at = iso(ref.at);
    const [row] = await db
      .update(tableAutomationOutbox)
      .set({ ...set, version: sql`${tableAutomationOutbox.version} + 1` })
      .where(
        and(
          eq(tableAutomationOutbox.id, ref.id),
          eq(tableAutomationOutbox.version, ref.expectedVersion),
          eq(tableAutomationOutbox.status, 'claimed'),
          eq(tableAutomationOutbox.lease_owner, ref.workerId),
          gt(tableAutomationOutbox.lease_expires_at, at),
        ),
      )
      .returning();
    if (!row) throw new TablesAutomationLeaseLostError();
    return row;
  };

  return {
    /**
     * Lease up to `limit` due rows. Expired leases first go back to pending (the
     * run resumes at its cursor) or, after the last attempt, to dead letter with
     * their run failed.
     */
    async claimAutomationOutbox(input: {
      workerId: string;
      leaseMs: number;
      limit?: number;
      at?: Date;
    }): Promise<TableAutomationOutboxRow[]> {
      const at = iso(input.at);
      const leaseExpiresAt = new Date(Date.parse(at) + Math.max(input.leaseMs, 1_000)).toISOString();
      const limit = Math.min(Math.max(input.limit ?? 10, 1), 100);
      return db.transaction(async (tx) => {
        const dead = await tx
          .update(tableAutomationOutbox)
          .set({
            status: 'dead_letter',
            lease_owner: null,
            lease_expires_at: null,
            last_error: 'automation lease expired after the final attempt',
            processed_at: at,
            version: sql`${tableAutomationOutbox.version} + 1`,
          })
          .where(
            and(
              eq(tableAutomationOutbox.status, 'claimed'),
              lte(tableAutomationOutbox.lease_expires_at, at),
              sql`${tableAutomationOutbox.attempts} >= ${tableAutomationOutbox.max_attempts}`,
            ),
          )
          .returning({ id: tableAutomationOutbox.id });
        if (dead.length > 0) {
          await tx
            .update(tableAutomationRuns)
            .set({ status: 'failed', error: 'The worker stopped responding mid-run', finished_at: at })
            .where(
              and(
                inArray(
                  tableAutomationRuns.outbox_id,
                  dead.map((row) => row.id),
                ),
                eq(tableAutomationRuns.status, 'running'),
              ),
            );
        }
        await tx
          .update(tableAutomationOutbox)
          .set({
            status: 'pending',
            lease_owner: null,
            lease_expires_at: null,
            last_error: 'automation lease expired',
            version: sql`${tableAutomationOutbox.version} + 1`,
          })
          .where(
            and(
              eq(tableAutomationOutbox.status, 'claimed'),
              lte(tableAutomationOutbox.lease_expires_at, at),
              sql`${tableAutomationOutbox.attempts} < ${tableAutomationOutbox.max_attempts}`,
            ),
          );
        const candidates = await tx
          .select({ id: tableAutomationOutbox.id })
          .from(tableAutomationOutbox)
          .where(
            and(
              eq(tableAutomationOutbox.status, 'pending'),
              lte(tableAutomationOutbox.available_at, at),
              isNotNull(tableAutomationOutbox.rule_revision),
            ),
          )
          .orderBy(asc(tableAutomationOutbox.available_at), asc(tableAutomationOutbox.id))
          .limit(limit)
          .for('update', { skipLocked: true });
        if (candidates.length === 0) return [];
        return tx
          .update(tableAutomationOutbox)
          .set({
            status: 'claimed',
            attempts: sql`${tableAutomationOutbox.attempts} + 1`,
            lease_owner: input.workerId,
            lease_expires_at: leaseExpiresAt,
            version: sql`${tableAutomationOutbox.version} + 1`,
          })
          .where(
            and(
              inArray(
                tableAutomationOutbox.id,
                candidates.map((row) => row.id),
              ),
              eq(tableAutomationOutbox.status, 'pending'),
            ),
          )
          .returning();
      });
    },

    /** Before a row's work starts: a full lease from now, only while it is still ours. */
    renewAutomationOutbox(ref: LeaseRef & { leaseMs: number }) {
      const at = iso(ref.at);
      return leased(ref, {
        lease_expires_at: new Date(Date.parse(at) + Math.max(ref.leaseMs, 1_000)).toISOString(),
      });
    },

    /**
     * Hand back a claimed row nothing has run on in this claim: pending again,
     * the claim's attempt undone (`attempts` is the row as claimed — the
     * version CAS guarantees it is still current).
     */
    releaseAutomationOutbox(ref: LeaseRef & { attempts: number }) {
      return leased(ref, {
        status: 'pending',
        attempts: Math.max(ref.attempts - 1, 0),
        lease_owner: null,
        lease_expires_at: null,
      });
    },

    /** After an action succeeded: move the cursor, renew the lease, reset the attempt count. */
    checkpointAutomationOutbox(ref: LeaseRef & { cursor: string | null; leaseMs: number }) {
      const at = iso(ref.at);
      return leased(ref, {
        cursor: ref.cursor,
        attempts: 1,
        lease_expires_at: new Date(Date.parse(at) + Math.max(ref.leaseMs, 1_000)).toISOString(),
        last_error: null,
      });
    },

    /** A delay: release the row until `availableAt`, resuming at `cursor` with a fresh attempt count. */
    parkAutomationOutbox(ref: LeaseRef & { cursor: string; availableAt: Date }) {
      return leased(ref, {
        status: 'pending',
        cursor: ref.cursor,
        attempts: 0,
        available_at: ref.availableAt.toISOString(),
        lease_owner: null,
        lease_expires_at: null,
      });
    },

    /** A retryable failure (webhook 5xx / timeout): try the same action again at `retryAt`. */
    retryAutomationOutbox(ref: LeaseRef & { error: string; retryAt: Date }) {
      return leased(ref, {
        status: 'pending',
        available_at: ref.retryAt.toISOString(),
        last_error: ref.error.slice(0, 2_000),
        lease_owner: null,
        lease_expires_at: null,
      });
    },

    /** End the row for good. */
    settleAutomationOutbox(ref: LeaseRef & { status: 'succeeded' | 'failed' | 'dead_letter'; error?: string | null }) {
      return leased(ref, {
        status: ref.status,
        last_error: ref.error ? ref.error.slice(0, 2_000) : null,
        processed_at: iso(ref.at),
        lease_owner: null,
        lease_expires_at: null,
      });
    },

    /** The run of an outbox row: the one already open (a resumed or delayed run), or a new one. */
    async openAutomationRun(outbox: TableAutomationOutboxRow, at?: Date): Promise<TableAutomationRunRow> {
      const [existing] = await db
        .select()
        .from(tableAutomationRuns)
        .where(eq(tableAutomationRuns.outbox_id, outbox.id))
        .orderBy(asc(tableAutomationRuns.id))
        .limit(1);
      if (existing) return existing;
      const [created] = await db
        .insert(tableAutomationRuns)
        .values({
          rule_id: outbox.rule_id,
          outbox_id: outbox.id,
          status: 'running',
          actions_completed: 0,
          trigger_kind: outbox.trigger_kind,
          record_id: outbox.record_id,
          started_at: iso(at),
        })
        .returning();
      return created!;
    },

    async updateAutomationRun(
      runId: number,
      patch: {
        status?: TableAutomationRunRow['status'];
        steps?: TableAutomationRunStep[];
        actions_completed?: number;
        error?: string | null;
        finished_at?: string | null;
      },
    ): Promise<TableAutomationRunRow | undefined> {
      const [row] = await db
        .update(tableAutomationRuns)
        .set({ ...patch, ...(patch.error ? { error: patch.error.slice(0, 2_000) } : {}) })
        .where(eq(tableAutomationRuns.id, runId))
        .returning();
      return row;
    },

    // ─── Sweep ───────────────────────────────────────────

    /** Enabled schedule rules whose next occurrence is due. */
    async listDueScheduleRules(at: Date, limit = 100): Promise<TableAutomationRuleRow[]> {
      return db
        .select()
        .from(tableAutomationRules)
        .where(
          and(
            eq(tableAutomationRules.status, 'enabled'),
            eq(tableAutomationRules.trigger, 'schedule'),
            isNotNull(tableAutomationRules.next_fire_at),
            lte(tableAutomationRules.next_fire_at, at.toISOString()),
          ),
        )
        .orderBy(asc(tableAutomationRules.next_fire_at), asc(tableAutomationRules.id))
        .limit(Math.min(Math.max(limit, 1), 500));
    },

    async listEnabledDateRules(): Promise<TableAutomationRuleRow[]> {
      return db
        .select()
        .from(tableAutomationRules)
        .where(and(eq(tableAutomationRules.status, 'enabled'), eq(tableAutomationRules.trigger, 'date_reached')))
        .orderBy(asc(tableAutomationRules.id));
    },

    /** CAS: move a schedule rule's next occurrence — only if nobody edited or swept it meanwhile. */
    async advanceScheduleRule(input: {
      id: number;
      revision: number;
      expected: string | null;
      next: Date | null;
    }): Promise<boolean> {
      const rows = await db
        .update(tableAutomationRules)
        .set({ next_fire_at: input.next ? input.next.toISOString() : null })
        .where(
          and(
            eq(tableAutomationRules.id, input.id),
            eq(tableAutomationRules.revision, input.revision),
            input.expected === null
              ? isNull(tableAutomationRules.next_fire_at)
              : eq(tableAutomationRules.next_fire_at, input.expected),
          ),
        )
        .returning({ id: tableAutomationRules.id });
      return rows.length > 0;
    },

    /** CAS: a date rule has been swept up to `next`. */
    async advanceDateRule(input: {
      id: number;
      revision: number;
      expected: string | null;
      next: Date;
    }): Promise<boolean> {
      const rows = await db
        .update(tableAutomationRules)
        .set({ swept_until: input.next.toISOString() })
        .where(
          and(
            eq(tableAutomationRules.id, input.id),
            eq(tableAutomationRules.revision, input.revision),
            input.expected === null
              ? isNull(tableAutomationRules.swept_until)
              : eq(tableAutomationRules.swept_until, input.expected),
          ),
        )
        .returning({ id: tableAutomationRules.id });
      return rows.length > 0;
    },

    /** Enqueue one sweep occurrence (idempotent on `key`). */
    async enqueueAutomationRun(input: {
      rule: TableAutomationRuleRow;
      recordId: number | null;
      trigger: TableAutomationTrigger;
      key: string;
      scheduledFor: Date;
      payload: Record<string, unknown>;
    }): Promise<TableAutomationOutboxRow | undefined> {
      return insertOutbox(db, input.rule, {
        recordId: input.recordId,
        trigger: input.trigger,
        key: input.key,
        payload: input.payload,
        scheduledFor: input.scheduledFor.toISOString(),
      });
    },

    /** Live records of a schedule rule's table that satisfy its condition (`$me` = its executor), by id, at most `limit`. */
    async scheduleRecordIds(rule: TableAutomationRuleRow, options: { limit: number; at: Date }): Promise<number[]> {
      const condition = await compileRuleCondition(db, rule, rule.execution_user_id, options.at);
      if (condition === null) return [];
      const rows = await db
        .select({ id: tableRecords.id })
        .from(tableRecords)
        .where(and(eq(tableRecords.table_id, rule.table_id), isNull(tableRecords.deleted_at), condition))
        .orderBy(asc(tableRecords.id))
        .limit(options.limit);
      return rows.map((row) => row.id);
    },

    /**
     * Records whose date-trigger instant falls in `(from, to]`, satisfying the
     * rule's condition, ordered by (instant, id) and paged by keyset `after`.
     * A date field fires at `time` in the rule's zone, `offsetDays` after the
     * date; a datetime field fires at its instant plus the offset (time ignored).
     */
    async dateReachedRecords(
      rule: TableAutomationRuleRow,
      options: { from: Date; to: Date; after?: { fireAt: string; id: number }; limit: number },
    ): Promise<Array<{ id: number; value: string; fireAt: string }>> {
      const trigger = rule.config.dateTrigger;
      if (!trigger) return [];
      const [field] = await db
        .select()
        .from(tableFields)
        .where(
          and(
            eq(tableFields.id, trigger.fieldId),
            eq(tableFields.table_id, rule.table_id),
            isNull(tableFields.archived_at),
          ),
        )
        .limit(1);
      if (!field || (field.type !== 'date' && field.type !== 'datetime')) return [];
      const condition = await compileRuleCondition(db, rule, rule.execution_user_id, options.to);
      if (condition === null) return [];
      const key = String(field.id);
      const raw = sql`(${tableRecords.values} ->> ${key})`;
      const fireAt: SQL =
        field.type === 'date'
          ? sql`CASE WHEN ${raw} ~ '^\\d{4}-\\d{2}-\\d{2}$'
              THEN ((${raw})::date + ${trigger.offsetDays}::int + ${trigger.time}::time) AT TIME ZONE ${trigger.timezone}
            END`
          : sql`CASE WHEN ${raw} IS NOT NULL AND ${raw} <> ''
              THEN (${raw})::timestamptz + make_interval(days => ${trigger.offsetDays}::int)
            END`;
      const rows = (await db.execute(sql`
        SELECT id, value, fire_at FROM (
          SELECT ${tableRecords.id} AS id, ${raw} AS value, ${fireAt} AS fire_at
          FROM ${tableRecords}
          WHERE ${tableRecords.table_id} = ${rule.table_id}
            AND ${tableRecords.deleted_at} IS NULL
            ${condition ? sql`AND ${condition}` : sql``}
        ) due
        WHERE fire_at > ${options.from.toISOString()}::timestamptz
          AND fire_at <= ${options.to.toISOString()}::timestamptz
          ${options.after ? sql`AND (fire_at, id) > (${options.after.fireAt}::timestamptz, ${options.after.id}::int)` : sql``}
        ORDER BY fire_at, id
        LIMIT ${Math.min(Math.max(options.limit, 1), 1_000)}`)) as unknown as Array<{
        id: number;
        value: string;
        fire_at: string | Date;
      }>;
      return rows.map((row) => ({
        id: Number(row.id),
        value: String(row.value),
        fireAt: new Date(row.fire_at).toISOString(),
      }));
    },

    /** Test / CLI seam: the outbox rows of one rule, oldest first. */
    async listAutomationOutbox(ruleId: number): Promise<TableAutomationOutboxRow[]> {
      return db
        .select()
        .from(tableAutomationOutbox)
        .where(eq(tableAutomationOutbox.rule_id, ruleId))
        .orderBy(asc(tableAutomationOutbox.id));
    },

    async getAutomationOutbox(id: number): Promise<TableAutomationOutboxRow | undefined> {
      const [row] = await db.select().from(tableAutomationOutbox).where(eq(tableAutomationOutbox.id, id)).limit(1);
      return row;
    },
  };
}

export type TablesAutomationQueue = ReturnType<typeof createTablesAutomationQueue>;

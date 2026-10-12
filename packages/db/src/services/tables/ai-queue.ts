/** AI field outbox: transaction-only producers, SKIP LOCKED leases, revision/config CAS. No model I/O. */
import { createHash, randomUUID } from 'node:crypto';
import { and, asc, desc, eq, getTableColumns, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableAiFieldConfig, TableAiFieldRunResult, TableRecordValues } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableFields, tableRecomputeJobs, tableRecords } from '../../schema/index.js';
import type { TableRecomputeJobRow } from '../../schema/tables.js';
import { parseTableFieldConfig, type TableRecordWrittenEvent, type TablesExecutor } from './shared.js';

export function aiInputHash(config: TableAiFieldConfig, values: TableRecordValues): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        definition: {
          prompt: config.prompt,
          inputFieldIds: config.inputFieldIds,
          resultType: config.resultType,
          options: config.options,
          model: config.model,
        },
        inputs: config.inputFieldIds.map((id) => [id, values[String(id)] ?? null]),
      }),
    )
    .digest('hex');
}

export async function cancelQueuedAiJobs(tx: TablesExecutor, fieldId: number, error: string): Promise<void> {
  await tx
    .update(tableRecomputeJobs)
    .set({ status: 'failed', error, finished_at: nowIso(), lease_owner: null, lease_expires_at: null })
    .where(
      and(
        eq(tableRecomputeJobs.kind, 'ai'),
        eq(tableRecomputeJobs.field_id, fieldId),
        inArray(tableRecomputeJobs.status, ['queued', 'running']),
      ),
    );
}

async function enqueue(
  tx: TablesExecutor,
  fieldId: number,
  tableId: number,
  recordId: number,
  revision: number,
  hash: string,
  key: string,
): Promise<void> {
  const [existing] = await tx
    .select({ id: tableRecomputeJobs.id })
    .from(tableRecomputeJobs)
    .where(eq(tableRecomputeJobs.idempotency_key, key))
    .limit(1);
  if (existing) return;
  // A new input supersedes every unfinished older input for this cell. A running
  // attempt may still cost tokens, but its lease can never commit the old answer.
  await tx
    .update(tableRecomputeJobs)
    .set({ status: 'failed', error: 'superseded', finished_at: nowIso(), lease_owner: null, lease_expires_at: null })
    .where(
      and(
        eq(tableRecomputeJobs.kind, 'ai'),
        eq(tableRecomputeJobs.field_id, fieldId),
        eq(tableRecomputeJobs.record_id, recordId),
        inArray(tableRecomputeJobs.status, ['queued', 'running']),
      ),
    );
  await tx
    .insert(tableRecomputeJobs)
    .values({
      kind: 'ai',
      field_id: fieldId,
      table_id: tableId,
      record_id: recordId,
      source_revision: revision,
      input_hash: hash,
      idempotency_key: key,
      created_at: nowIso(),
    })
    .onConflictDoNothing();
}

export async function enqueueAiEvents(tx: TablesExecutor, event: TableRecordWrittenEvent): Promise<void> {
  if (!event.after || event.kind === 'deleted') return;
  const fields = await tx
    .select()
    .from(tableFields)
    .where(and(eq(tableFields.table_id, event.tableId), eq(tableFields.type, 'ai'), isNull(tableFields.archived_at)));
  for (const field of fields) {
    const config = parseTableFieldConfig(field).ai;
    if (!config?.autoUpdate) continue;
    const hash = aiInputHash(config, event.after);
    if (event.before && hash === aiInputHash(config, event.before)) continue;
    await enqueue(
      tx,
      field.id,
      event.tableId,
      event.recordId,
      event.revision,
      hash,
      `ai:${field.id}:${event.recordId}:${event.revision}:${hash}`,
    );
  }
}

export interface AiLeaseRef {
  id: number;
  attempt: number;
  workerId: string;
  at?: Date;
}
const owned = (ref: AiLeaseRef) =>
  and(
    eq(tableRecomputeJobs.id, ref.id),
    eq(tableRecomputeJobs.kind, 'ai'),
    eq(tableRecomputeJobs.status, 'running'),
    eq(tableRecomputeJobs.attempt, ref.attempt),
    eq(tableRecomputeJobs.lease_owner, ref.workerId),
    gt(tableRecomputeJobs.lease_expires_at, (ref.at ?? new Date()).toISOString()),
  );

export function createTablesAiQueue(db: Db) {
  return {
    async enqueueAiField(
      fieldId: number,
      options: { onlyBlank: boolean; recordIds?: number[]; capReached?: boolean },
    ): Promise<TableAiFieldRunResult> {
      return db.transaction(async (tx) => {
        // Record locks serialize with ordinary writes, so queued inputs always
        // describe a committed record, never a snapshot overwritten by a writer.
        const [field] = await tx
          .select()
          .from(tableFields)
          .where(and(eq(tableFields.id, fieldId), eq(tableFields.type, 'ai'), isNull(tableFields.archived_at)))
          .limit(1);
        const config = field && parseTableFieldConfig(field).ai;
        if (!field || !config) return { queued: 0, skipped: 0 };
        const rows = await tx
          .select()
          .from(tableRecords)
          .where(
            and(
              eq(tableRecords.table_id, field.table_id),
              isNull(tableRecords.deleted_at),
              options.recordIds ? inArray(tableRecords.id, options.recordIds) : undefined,
            ),
          )
          .orderBy(asc(tableRecords.id))
          .for('update');
        const requestId = randomUUID();
        let queued = 0,
          skipped = 0;
        for (const row of rows) {
          const current = row.computed_values[String(fieldId)];
          if (
            options.onlyBlank &&
            current !== null &&
            current !== undefined &&
            current !== '' &&
            !(Array.isArray(current) && current.length === 0)
          )
            continue;
          if (options.capReached) {
            skipped++;
            continue;
          }
          await enqueue(
            tx,
            field.id,
            row.table_id,
            row.id,
            row.revision,
            aiInputHash(config, { ...row.values, ...row.computed_values }),
            `ai:${field.id}:${row.id}:manual:${requestId}`,
          );
          queued++;
        }
        return { queued, skipped, ...(skipped ? { capReached: true } : {}) };
      });
    },
    async claimAiJobs(input: {
      workerId: string;
      leaseMs: number;
      limit: number;
      at?: Date;
    }): Promise<TableRecomputeJobRow[]> {
      const at = input.at ?? new Date();
      return db.transaction(async (tx) => {
        // An interrupted paid call has an unknown outcome. Never replay it
        // automatically: the budget reservation expires conservatively and the
        // user may explicitly retry the failed cell.
        await tx
          .update(tableRecomputeJobs)
          .set({
            status: 'failed',
            error: 'generation_interrupted',
            finished_at: at.toISOString(),
            lease_owner: null,
            lease_expires_at: null,
          })
          .where(
            and(
              eq(tableRecomputeJobs.kind, 'ai'),
              eq(tableRecomputeJobs.status, 'running'),
              lte(tableRecomputeJobs.lease_expires_at, at.toISOString()),
            ),
          );
        const rows = await tx
          .select()
          .from(tableRecomputeJobs)
          .where(and(eq(tableRecomputeJobs.kind, 'ai'), eq(tableRecomputeJobs.status, 'queued')))
          .orderBy(asc(tableRecomputeJobs.id))
          .limit(Math.min(16, Math.max(1, input.limit)))
          .for('update', { skipLocked: true });
        if (!rows.length) return [];
        return tx
          .update(tableRecomputeJobs)
          .set({
            status: 'running',
            attempt: sql`${tableRecomputeJobs.attempt} + 1`,
            lease_owner: input.workerId,
            lease_expires_at: new Date(at.getTime() + input.leaseMs).toISOString(),
            started_at: at.toISOString(),
            error: null,
          })
          .where(
            inArray(
              tableRecomputeJobs.id,
              rows.map((row) => row.id),
            ),
          )
          .returning();
      });
    },
    async failAiJob(ref: AiLeaseRef, error: string): Promise<void> {
      await db
        .update(tableRecomputeJobs)
        .set({
          status: 'failed',
          error: error.slice(0, 500),
          finished_at: nowIso(),
          lease_owner: null,
          lease_expires_at: null,
        })
        .where(owned(ref));
    },
    async completeAiJob(
      ref: AiLeaseRef,
      input: { revision: number; value: unknown; tokens: number; model: string },
    ): Promise<boolean> {
      return db.transaction(async (tx) => {
        // Record-before-job matches the producer's lock order.
        const [job] = await tx.select().from(tableRecomputeJobs).where(owned(ref)).limit(1);
        if (!job?.record_id || !job.field_id) return false;
        const [record] = await tx
          .select()
          .from(tableRecords)
          .where(and(eq(tableRecords.id, job.record_id), isNull(tableRecords.deleted_at)))
          .for('update');
        const [field] = await tx
          .select()
          .from(tableFields)
          .where(and(eq(tableFields.id, job.field_id), isNull(tableFields.archived_at)))
          .for('share');
        const config = field && parseTableFieldConfig(field).ai;
        const valid =
          record &&
          config &&
          record.revision === input.revision &&
          aiInputHash(config, { ...record.values, ...record.computed_values }) === job.input_hash;
        const [settled] = await tx
          .update(tableRecomputeJobs)
          .set({
            status: valid ? 'succeeded' : 'failed',
            error: valid ? null : 'inputs_changed',
            tokens: input.tokens,
            model: input.model,
            source_revision: input.revision,
            finished_at: nowIso(),
            lease_owner: null,
            lease_expires_at: null,
          })
          .where(owned(ref))
          .returning();
        if (!settled || !valid || !record) return false;
        await tx
          .update(tableRecords)
          .set({
            computed_values: { ...record.computed_values, [String(job.field_id)]: input.value },
            computed_revision: record.computed_revision + 1,
            computed_at: nowIso(),
          })
          .where(and(eq(tableRecords.id, record.id), eq(tableRecords.revision, input.revision)));
        return true;
      });
    },
    /** Latest job per cell only; older superseded failures never shadow a success. */
    async aiFieldJobs(fieldId: number, recordIds?: number[]): Promise<TableRecomputeJobRow[]> {
      return db
        .selectDistinctOn([tableRecomputeJobs.record_id], getTableColumns(tableRecomputeJobs))
        .from(tableRecomputeJobs)
        .innerJoin(tableRecords, eq(tableRecords.id, tableRecomputeJobs.record_id))
        .where(
          and(
            isNull(tableRecords.deleted_at),
            eq(tableRecomputeJobs.kind, 'ai'),
            eq(tableRecomputeJobs.field_id, fieldId),
            recordIds ? inArray(tableRecomputeJobs.record_id, recordIds) : undefined,
          ),
        )
        .orderBy(tableRecomputeJobs.record_id, desc(tableRecomputeJobs.id));
    },
  };
}

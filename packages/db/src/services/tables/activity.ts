/**
 * Record history and the single post-write hook.
 *
 * `onRecordWritten` is the only thing a record write calls after its row is
 * final, and it runs inside the write's transaction: the history event and the
 * automation enqueue commit (or roll back) together with the record.
 * Recompute and rollup cascades are maintenance writes and never call it.
 */

import { and, desc, eq, lt, or } from 'drizzle-orm';
import { nowIso } from '@greenhouse/utils/date';
import type { TableRecordFieldChange, TableRecordValues, TableRecordWriteSource } from '@greenhouse/types/tables';
import type { Db } from '../../client.js';
import { tableRecordEvents } from '../../schema/index.js';
import type { TableRecordEventRow } from '../../schema/tables.js';
import { enqueueAutomationEvents } from './automations.js';
import { isPlainObject, type TableRecordWrittenEvent, type TablesExecutor } from './shared.js';

const MAX_EVENT_STRING = 1_000;
const MAX_EVENT_ARRAY = 50;

/** Bound one value for history: long text is cut, long lists are capped. */
export function truncateEventValue(value: unknown): unknown {
  if (value === undefined) return null;
  if (typeof value === 'string') {
    // jsonb cannot store NUL; values on records cannot contain it either, but
    // history must never be the thing that fails a write.
    const clean = value.replaceAll('\u0000', '');
    return clean.length > MAX_EVENT_STRING ? `${clean.slice(0, MAX_EVENT_STRING)}…` : clean;
  }
  if (Array.isArray(value)) return value.slice(0, MAX_EVENT_ARRAY).map(truncateEventValue);
  if (isPlainObject(value)) {
    const text = JSON.stringify(value);
    return text.length > MAX_EVENT_STRING ? `${text.slice(0, MAX_EVENT_STRING)}…` : value;
  }
  return value;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** Field-level changes between two `values ∪ computed` snapshots, in field id order. */
export function diffRecordValues(
  before: TableRecordValues | null,
  after: TableRecordValues | null,
): TableRecordFieldChange[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  return [...keys]
    .filter((key) => /^\d+$/.test(key))
    .map(Number)
    .sort((left, right) => left - right)
    .filter((fieldId) => !sameValue(before?.[String(fieldId)], after?.[String(fieldId)]))
    .map((fieldId) => ({
      fieldId,
      before: truncateEventValue(before?.[String(fieldId)] ?? null),
      after: truncateEventValue(after?.[String(fieldId)] ?? null),
    }));
}

function eventMeta(source: TableRecordWriteSource | undefined): TableRecordWriteSource {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).filter(([, value]) => value !== undefined));
}

/**
 * Append one history row. `created` records every non-empty value, `updated`
 * the changed fields (an update that changed nothing appends nothing),
 * `deleted` / `restored` carry no field changes.
 */
export async function appendRecordEvent(
  executor: TablesExecutor,
  event: TableRecordWrittenEvent,
): Promise<TableRecordEventRow | undefined> {
  let changes: TableRecordFieldChange[] = [];
  if (event.kind === 'created') {
    changes = diffRecordValues(null, event.after).filter((change) => change.after !== null && change.after !== '');
  } else if (event.kind === 'updated') {
    changes = diffRecordValues(event.before, event.after);
    if (changes.length === 0) return undefined;
  }
  const [row] = await executor
    .insert(tableRecordEvents)
    .values({
      record_id: event.recordId,
      table_id: event.tableId,
      actor_id: event.meta.actorId,
      actor_kind: event.meta.actorKind,
      type: event.kind,
      changes,
      meta: eventMeta(event.meta.source),
      created_at: nowIso(),
    })
    .returning();
  return row;
}

/**
 * The single post-write hook (inside the write transaction). Every record
 * write — create, update, delete, restore, batch, form, automation, import,
 * app — reaches it with the final before / after snapshots.
 */
export async function onRecordWritten(tx: TablesExecutor, event: TableRecordWrittenEvent): Promise<void> {
  await appendRecordEvent(tx, event);
  await enqueueAutomationEvents(tx, event);
}

export function createTablesActivity(db: Db) {
  return {
    /**
     * A record's history, newest first. Raw rows: callers that show history to
     * a scoped reader must drop changes to fields it cannot read.
     */
    async listRecordEvents(
      recordId: number,
      options: { limit?: number; before?: { createdAt: string; id: number } } = {},
    ): Promise<TableRecordEventRow[]> {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
      const cursor = options.before;
      return db
        .select()
        .from(tableRecordEvents)
        .where(
          and(
            eq(tableRecordEvents.record_id, recordId),
            cursor
              ? or(
                  lt(tableRecordEvents.created_at, cursor.createdAt),
                  and(eq(tableRecordEvents.created_at, cursor.createdAt), lt(tableRecordEvents.id, cursor.id)),
                )
              : undefined,
          ),
        )
        .orderBy(desc(tableRecordEvents.created_at), desc(tableRecordEvents.id))
        .limit(limit);
    },
  };
}

/**
 * Relation cells show the linked record's primary field, not its id.
 *
 * The record query answers ids only, so the labels are looked up here: the target table's schema
 * once (its primary field, else its first), then the linked records of each target table in one
 * query by id (`recordIds`), each table's labels filling in as soon as its answer lands. Answers are
 * cached until `invalidateRelationLabels()` — the grid calls it whenever it reloads records or
 * changes one — and a failed lookup is not cached, so the next render asks again. A record the
 * viewer cannot read or that is gone stays `#<id>`.
 */

import { useEffect, useMemo, useState } from 'react';
import { getTableSchema, queryTableRecords, type TableField, type TableRecord } from '../api';

export type RelationLabelLookup = (field: TableField, recordId: string) => string | undefined;

/** Record ids held in a relation value (single or multiple); legacy numbers become strings. */
export function relationIdsOf(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
  return entries
    .filter((entry) => typeof entry === 'string' || typeof entry === 'number')
    .map((entry) => String(entry).replace(/^#/, ''))
    .filter(Boolean);
}

/** A record's primary value as one line, or null when it has none. */
export function primaryLabelOf(record: TableRecord, primaryFieldId: string): string | null {
  const key = String(primaryFieldId);
  const value = record.computed_values[key] === undefined ? record.values[key] : record.computed_values[key];
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ') || null;
  return null;
}

/** Target table → record ids referenced by the relation fields of these records. */
export function relationTargetsOf(
  fields: readonly TableField[],
  records: readonly TableRecord[],
): Map<string, Set<string>> {
  const targets = new Map<string, Set<string>>();
  for (const field of fields) {
    const target = field.type === 'relation' ? field.config?.relation?.targetTableId : undefined;
    if (!target) continue;
    const ids = targets.get(String(target)) ?? new Set<string>();
    for (const record of records) for (const id of relationIdsOf(record.values[String(field.id)])) ids.add(id);
    if (ids.size) targets.set(String(target), ids);
  }
  return targets;
}

/** Ids per query: the record query's own page cap. */
const BATCH = 500;

/** Target table → its label field id, null when it has no fields, undefined when the lookup failed. */
const primaryFields = new Map<string, Promise<string | null | undefined>>();
/** `<table>:<record>` → the label, null for a record that is unreadable or gone, undefined when the lookup failed. */
const labels = new Map<string, Promise<string | null | undefined>>();

/** Forget a promise once it settled as a failure, so a later render asks again. */
function forgetOnFailure<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  pending: Promise<T>,
  failed: (value: T) => boolean,
) {
  void pending.then((value) => {
    if (failed(value) && cache.get(key) === pending) cache.delete(key);
  });
}

function primaryFieldOf(tableId: string): Promise<string | null | undefined> {
  let pending = primaryFields.get(tableId);
  if (!pending) {
    pending = getTableSchema(tableId)
      .then((schema) => {
        const field = schema.fields.find((entry) => entry.is_primary) ?? schema.fields[0];
        return field ? String(field.id) : null;
      })
      .catch(() => undefined);
    primaryFields.set(tableId, pending);
    forgetOnFailure(primaryFields, tableId, pending, (value) => value === undefined);
  }
  return pending;
}

/** Labels of these records of one table: cached ones as they are, the rest in one query per batch. */
function labelsOf(tableId: string, recordIds: readonly string[]): Promise<Map<string, string | null | undefined>> {
  const missing = recordIds.filter((id) => !labels.has(`${tableId}:${id}`));
  for (let start = 0; start < missing.length; start += BATCH) {
    const chunk = missing.slice(start, start + BATCH);
    const answers = primaryFieldOf(tableId).then(async (primary) => {
      if (primary === undefined) return undefined;
      if (primary === null) return new Map<string, string | null>();
      try {
        const page = await queryTableRecords(tableId, { recordIds: chunk, limit: chunk.length });
        return new Map(page.records.map((record) => [String(record.id), primaryLabelOf(record, primary)]));
      } catch {
        return undefined;
      }
    });
    for (const id of chunk) {
      const key = `${tableId}:${id}`;
      const pending = answers.then((found) => (found === undefined ? undefined : (found.get(id) ?? null)));
      labels.set(key, pending);
      forgetOnFailure(labels, key, pending, (value) => value === undefined);
    }
  }
  return Promise.all(recordIds.map(async (id) => [id, await labels.get(`${tableId}:${id}`)!] as const)).then(
    (entries) => new Map(entries),
  );
}

/**
 * Drop cached labels — all of them, or those of records in one table — so the next render reads
 * them again (a record was renamed, deleted or restored, or the table was reloaded).
 */
export function invalidateRelationLabels(tableId?: string): void {
  if (tableId === undefined) {
    primaryFields.clear();
    labels.clear();
    return;
  }
  primaryFields.delete(tableId);
  for (const key of labels.keys()) if (key.startsWith(`${tableId}:`)) labels.delete(key);
}

/** Tests only. */
export function resetRelationLabelCache(): void {
  invalidateRelationLabels();
}

/** Labels for the relation values of `records` in `fields` (pass only the fields on screen), filled in as they arrive. */
export function useRelationLabels(fields: readonly TableField[], records: readonly TableRecord[]): RelationLabelLookup {
  const [known, setKnown] = useState<ReadonlyMap<string, string>>(() => new Map());
  const targets = useMemo(() => relationTargetsOf(fields, records), [fields, records]);

  useEffect(() => {
    if (targets.size === 0) return;
    let cancelled = false;
    // One request per target table; each table's labels show as soon as they land.
    for (const [tableId, ids] of targets) {
      void labelsOf(tableId, [...ids]).then((answers) => {
        if (cancelled) return;
        setKnown((prev) => {
          const next = new Map(prev);
          let changed = false;
          for (const [id, label] of answers) {
            const key = `${tableId}:${id}`;
            // A failed lookup keeps what is shown; a record now unreadable or gone loses its label.
            if (label === undefined) continue;
            if (label === null) {
              if (next.delete(key)) changed = true;
            } else if (next.get(key) !== label) {
              next.set(key, label);
              changed = true;
            }
          }
          return changed ? next : prev;
        });
      });
    }
    return () => {
      cancelled = true;
    };
  }, [targets]);

  return useMemo<RelationLabelLookup>(
    () => (field, recordId) => {
      const target = field.config?.relation?.targetTableId;
      return target ? known.get(`${String(target)}:${recordId}`) : undefined;
    },
    [known],
  );
}

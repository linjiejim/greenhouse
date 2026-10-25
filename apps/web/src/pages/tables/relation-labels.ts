/**
 * Relation cells show the linked record's primary field, not its id.
 *
 * The record query answers ids only, so the labels are looked up here: the target table's schema
 * once (its primary field, else its first), then each linked record by id. Answers are cached per
 * page load (a renamed record shows its new name after a reload); a record the viewer cannot read
 * or that is gone stays `#<id>`.
 */

import { useEffect, useMemo, useState } from 'react';
import { getTableRecord, getTableSchema, type TableField, type TableRecord } from '../../lib/api/tables';

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

const primaryFields = new Map<string, Promise<string | null>>();
const labels = new Map<string, Promise<string | null>>();

function primaryFieldOf(tableId: string): Promise<string | null> {
  let pending = primaryFields.get(tableId);
  if (!pending) {
    pending = getTableSchema(tableId)
      .then((schema) => {
        const field = schema.fields.find((entry) => entry.is_primary) ?? schema.fields[0];
        return field ? String(field.id) : null;
      })
      .catch(() => null);
    primaryFields.set(tableId, pending);
  }
  return pending;
}

function labelOf(tableId: string, recordId: string): Promise<string | null> {
  const key = `${tableId}:${recordId}`;
  let pending = labels.get(key);
  if (!pending) {
    pending = primaryFieldOf(tableId).then((primary) =>
      primary === null
        ? null
        : getTableRecord(tableId, recordId)
            .then((record) => primaryLabelOf(record, primary))
            .catch(() => null),
    );
    labels.set(key, pending);
  }
  return pending;
}

/** Tests only. */
export function resetRelationLabelCache(): void {
  primaryFields.clear();
  labels.clear();
}

/** Labels for the relation values of `records`, filled in as they arrive. */
export function useRelationLabels(fields: readonly TableField[], records: readonly TableRecord[]): RelationLabelLookup {
  const [known, setKnown] = useState<ReadonlyMap<string, string>>(() => new Map());
  const targets = useMemo(() => relationTargetsOf(fields, records), [fields, records]);
  const wanted = useMemo(
    () => [...targets].flatMap(([tableId, ids]) => [...ids].map((id) => [tableId, id] as const)),
    [targets],
  );

  useEffect(() => {
    if (wanted.length === 0) return;
    let cancelled = false;
    void Promise.all(
      wanted.map(async ([tableId, id]) => [`${tableId}:${id}`, await labelOf(tableId, id)] as const),
    ).then((answers) => {
      if (cancelled) return;
      setKnown((prev) => {
        const next = new Map(prev);
        let changed = false;
        for (const [key, label] of answers) {
          if (label !== null && next.get(key) !== label) {
            next.set(key, label);
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [wanted]);

  return useMemo<RelationLabelLookup>(
    () => (field, recordId) => {
      const target = field.config?.relation?.targetTableId;
      return target ? known.get(`${String(target)}:${recordId}`) : undefined;
    },
    [known],
  );
}

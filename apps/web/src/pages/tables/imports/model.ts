/**
 * What the import dialog works out from an import and its table (TBL-10): the fields a column can
 * go into, how each column reads with or without a header, the rows to import, a column moved to
 * a field, and the required fields left without a column. The components draw it.
 */

import { IMPORT_SAMPLES, isComputedType, type BaseImport, type Field } from '@greenhouse/contract';

export type Mapping = ReadonlyArray<string | null>;

/** Fields a column can go into: those the reader sees, but computed fields and attachments. */
export const importTargets = (fields: readonly Field[]) =>
  fields.filter((field) => !isComputedType(field.type) && field.type !== 'attachment');

export interface ShownColumn {
  index: number;
  /** Its header; null when the first row is data (the dialog says 「第 N 列」). */
  name: string | null;
  samples: string[];
}

/** The columns as they read with or without a header: with one, the first row names them. */
export function shownColumns(item: Pick<BaseImport, 'columns'>, header: boolean): ShownColumn[] {
  return item.columns.map((column) => ({
    index: column.index,
    name: header && column.first ? column.first : null,
    samples: (header ? column.samples : [column.first, ...column.samples]).filter(Boolean).slice(0, IMPORT_SAMPLES),
  }));
}

/** Rows to import with this header choice (the server counted them with the draft's own). */
export const rowsWith = (item: Pick<BaseImport, 'total_rows' | 'header'>, header: boolean) =>
  Math.max(0, item.total_rows + (item.header ? 1 : 0) - (header ? 1 : 0));

/** A draft's mapping kept to the fields a column can still go into: a field deleted since reads as none. */
export function liveMapping(mapping: Mapping, targets: readonly Field[]): Array<string | null> {
  const ids = new Set(targets.map((field) => field.id));
  return mapping.map((id) => (id && ids.has(id) ? id : null));
}

/** A column into a field, or into none; the field leaves the column it was in. */
export function mapColumn(mapping: Mapping, index: number, fieldId: string | null): Array<string | null> {
  return mapping.map((current, at) => (at === index ? fieldId : fieldId && current === fieldId ? null : current));
}

/** Required fields no column goes into: the import does not start without them. */
export function missingRequired(fields: readonly Field[], mapping: Mapping): Field[] {
  const mapped = new Set(mapping);
  return fields.filter((field) => field.required && !isComputedType(field.type) && !mapped.has(field.id));
}

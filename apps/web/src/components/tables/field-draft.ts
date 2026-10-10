/**
 * Editing representation of Tables values, shared by every editor (record
 * dialog, inline cells, the form page, later app forms).
 *
 * A draft is what a control holds while someone types — text for anything
 * typed character by character (numbers, dates, record ids), so a half-typed
 * `1.` or `12, ` is never parsed away under the cursor — and the stored shape
 * for discrete choices. `toFieldDraft` / `fromFieldDraft` are the only
 * conversions between the two.
 */

import type { TableRecordValues } from '@greenhouse/types/tables';
import type { TableField } from '../../lib/api/tables';
import { fieldConfig, isComputedField } from './field-types';

export type FieldDraft = string | boolean | string[] | Array<number | string>;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** ISO instant → the `datetime-local` value in the viewer's zone. */
export function isoToLocalInput(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function isMultiRelation(field: Pick<TableField, 'type' | 'config'>): boolean {
  return field.type === 'relation' && fieldConfig(field).relation?.multiple === true;
}

export function toFieldDraft(field: Pick<TableField, 'type' | 'config'>, stored: unknown): FieldDraft {
  switch (field.type) {
    case 'boolean':
      return stored === true;
    case 'multi_select':
    case 'multi_user':
      return Array.isArray(stored) ? stored.map(String) : [];
    case 'attachment':
      return Array.isArray(stored) ? (stored as Array<number | string>) : [];
    case 'relation':
      if (Array.isArray(stored)) return stored.join(', ');
      return stored === null || stored === undefined ? '' : String(stored);
    case 'datetime':
      return typeof stored === 'string' ? isoToLocalInput(stored) : '';
    default:
      return stored === null || stored === undefined ? '' : String(stored);
  }
}

function recordIds(text: string): number[] {
  return text
    .split(/[,;\s]+/)
    .map((entry) => Number(entry.trim().replace(/^#/, '')))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Draft → stored value; `null` means empty. */
export function fromFieldDraft(field: Pick<TableField, 'type' | 'config'>, draft: FieldDraft): unknown {
  switch (field.type) {
    case 'boolean':
      return draft === true;
    case 'multi_select':
    case 'multi_user':
    case 'attachment':
      return Array.isArray(draft) ? draft : [];
    case 'number': {
      if (typeof draft !== 'string' || draft.trim() === '') return null;
      const number = Number(draft);
      return Number.isFinite(number) ? number : null;
    }
    case 'datetime': {
      if (typeof draft !== 'string' || !draft) return null;
      const date = new Date(draft);
      return Number.isNaN(date.valueOf()) ? null : date.toISOString();
    }
    case 'relation': {
      const ids = recordIds(typeof draft === 'string' ? draft : '');
      if (isMultiRelation(field)) return ids;
      return ids[0] ?? null;
    }
    default:
      return typeof draft === 'string' && draft !== '' ? draft : null;
  }
}

/** Drafts for every writable field of a record (or of a blank one). */
export function recordDrafts(
  fields: TableField[],
  record: { values: TableRecordValues; computed_values?: TableRecordValues } | null,
): Record<string, FieldDraft> {
  return Object.fromEntries(
    fields
      .filter((field) => !isComputedField(field))
      .map((field) => [String(field.id), toFieldDraft(field, record?.values[String(field.id)])]),
  );
}

/**
 * Drafts → the `values` of a write. Creating omits empty fields (the server
 * applies its defaults and required checks); updating sends `null` to clear.
 * Booleans and multi-value fields are always sent: unchecked is a value.
 */
export function valuesFromDrafts(
  fields: TableField[],
  drafts: Record<string, FieldDraft>,
  mode: 'create' | 'update',
): TableRecordValues {
  const values: TableRecordValues = {};
  for (const field of fields) {
    if (isComputedField(field)) continue;
    const key = String(field.id);
    if (!(key in drafts)) continue;
    const value = fromFieldDraft(field, drafts[key]!);
    if (value === null && mode === 'create') continue;
    values[key] = value;
  }
  return values;
}

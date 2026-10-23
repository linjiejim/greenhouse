/**
 * Table fields on the phone. React-free (./table-fields.test.ts): the live fields of a table in
 * order, a record's title, how each field type reads as text, and the quick-add form — only the
 * simple types (text, number, date, single select, checkbox) are written from the phone; the rest
 * stay read-only here. Values are keyed by field id as a string; formula and rollup results live
 * in `computed_values`.
 */

import type { TableField, TableRecord } from '../shared/greenhouse-types';

export interface SelectOption {
  id: string;
  label: string;
  color?: string;
}

export function fieldConfig(field: Pick<TableField, 'config'>): Record<string, unknown> {
  if (!field.config) return {};
  try {
    const value: unknown = JSON.parse(field.config);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function selectOptions(field: Pick<TableField, 'config'>): SelectOption[] {
  const options = fieldConfig(field).options;
  if (!Array.isArray(options)) return [];
  return options.flatMap((option): SelectOption[] => {
    const o = option as Record<string, unknown>;
    return typeof o?.id === 'string' && typeof o.label === 'string'
      ? [{ id: o.id, label: o.label, ...(typeof o.color === 'string' ? { color: o.color } : {}) }]
      : [];
  });
}

/** The table's fields that are not archived: the primary first, then by position. */
export function liveFields(fields: readonly TableField[]): TableField[] {
  return fields
    .filter((field) => !field.archived_at)
    .sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.position - b.position || a.id - b.id);
}

/** A field's value on a record: a computed result when there is one, else the stored value. */
export function cellValue(field: Pick<TableField, 'id'>, record: Pick<TableRecord, 'values' | 'computed_values'>): unknown {
  const key = String(field.id);
  const computed = record.computed_values?.[key];
  return computed !== undefined && computed !== null ? computed : record.values?.[key];
}

export interface FieldWords {
  yes: string;
  no: string;
  /** A calendar day (`YYYY-MM-DD`) or an ISO time as people read it. */
  date: (value: string) => string;
  /** A user id → their name. */
  user: (id: string) => string;
}

/** How a value reads in a list or a detail row ('' for nothing). */
export function displayValue(field: Pick<TableField, 'type' | 'config'>, value: unknown, words: FieldWords): string {
  if (value === null || value === undefined || value === '') return '';
  const list = Array.isArray(value) ? value : [value];
  switch (field.type) {
    case 'boolean':
      return value === true ? words.yes : value === false ? words.no : '';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? value.toLocaleString('en-US', { maximumFractionDigits: 6 })
        : '';
    case 'date':
    case 'datetime':
      return typeof value === 'string' ? words.date(value) : '';
    case 'single_select':
    case 'multi_select': {
      const options = selectOptions(field);
      return list
        .map((id) => options.find((option) => option.id === id)?.label ?? '')
        .filter(Boolean)
        .join(', ');
    }
    case 'user':
    case 'multi_user':
      return list
        .filter((id): id is string => typeof id === 'string')
        .map(words.user)
        .join(', ');
    case 'relation':
      return list
        .filter((id) => typeof id === 'number')
        .map((id) => `#${id}`)
        .join(', ');
    case 'attachment':
      return list.length ? String(list.length) : '';
    default:
      if (typeof value === 'string') return value;
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
      return list.every((item) => typeof item === 'string' || typeof item === 'number') ? list.join(', ') : '';
  }
}

/** A record's title: its primary field as text, else `#id`. */
export function recordTitle(fields: readonly TableField[], record: TableRecord, words: FieldWords): string {
  const primary = fields.find((field) => field.is_primary && !field.archived_at);
  const title = primary ? displayValue(primary, cellValue(primary, record), words).trim() : '';
  return title || `#${record.id}`;
}

/** The types the phone writes; everything else is edited on the web. */
export const QUICK_ADD_TYPES = ['text', 'number', 'date', 'single_select', 'boolean'] as const;
export type QuickAddType = (typeof QUICK_ADD_TYPES)[number];

export const isQuickAdd = (field: Pick<TableField, 'type'>): field is TableField & { type: QuickAddType } =>
  (QUICK_ADD_TYPES as readonly string[]).includes(field.type);

/** The fields the quick-add form shows, in table order. */
export function quickAddFields(fields: readonly TableField[]): TableField[] {
  return liveFields(fields).filter(isQuickAdd);
}

/** What the form holds per field: text for text / number / date, an option id or null, a boolean. */
export type Draft = Record<string, string | boolean | null | undefined>;

export type DraftProblem = { kind: 'required' | 'number' | 'date'; field: string };

/**
 * The form as a record's `values`, or the first problem. Empty optional fields are left out; a
 * checkbox is always written (unchecked = false).
 */
export function draftValues(
  fields: readonly TableField[],
  draft: Draft,
): { ok: true; values: Record<string, unknown> } | { ok: false; problem: DraftProblem } {
  const values: Record<string, unknown> = {};
  for (const field of quickAddFields(fields)) {
    const key = String(field.id);
    const raw = draft[key];
    if (field.type === 'boolean') {
      values[key] = raw === true;
      continue;
    }
    const text = typeof raw === 'string' ? raw.trim() : raw;
    if (text === '' || text === null || text === undefined) {
      if (field.required) return { ok: false, problem: { kind: 'required', field: field.name } };
      continue;
    }
    if (field.type === 'number') {
      const n = Number(String(text).replace(/,/g, ''));
      if (!Number.isFinite(n) || String(text).trim() === '') return { ok: false, problem: { kind: 'number', field: field.name } };
      values[key] = n;
    } else if (field.type === 'date') {
      const day = String(text);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
        return { ok: false, problem: { kind: 'date', field: field.name } };
      }
      values[key] = day;
    } else if (field.type === 'single_select') {
      if (!selectOptions(field).some((option) => option.id === text)) continue;
      values[key] = text;
    } else {
      values[key] = String(text).slice(0, 10_000);
    }
  }
  return { ok: true, values };
}

/** Roles that may add records (editor and up). */
export const canAddRecords = (role: string | null | undefined) => role === 'owner' || role === 'builder' || role === 'editor';

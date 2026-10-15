/**
 * Fields and values: a field's settings kept to what its type uses, a value checked against its
 * field, the words a record is found by, and what changed between two versions of a record.
 * Lookups that need the database (members, linked records, files) are the caller's; this file
 * says what to look up.
 */

import {
  LONG_TEXT_MAX,
  MAX_LIST_VALUES,
  OPTION_COLORS,
  TEXT_MAX,
  isEmptyValue,
  isLinkType,
  type FieldConfig,
  type FieldType,
} from '@greenhouse/contract';
import { searchTokens, type BaseFieldConfig, type BaseFieldRow, type BaseRecordChange } from '@greenhouse/db';
import { invalidInput } from '../../http/errors.js';

/** The settings a type uses, with defaults; everything else is dropped. Relation targets are checked by the caller. */
export function normalizeConfig(type: FieldType, input: FieldConfig | undefined): BaseFieldConfig {
  const config = input ?? {};
  switch (type) {
    case 'single_select':
    case 'multi_select': {
      const options = config.options ?? [];
      const ids = new Set<string>();
      for (const option of options) {
        if (ids.has(option.id)) throw invalidInput(`Two options share the id ${option.id}.`);
        ids.add(option.id);
      }
      return {
        options: options.map((option) => ({
          id: option.id,
          label: option.label.trim(),
          color: (OPTION_COLORS as readonly string[]).includes(option.color) ? option.color : 'gray',
        })),
      };
    }
    case 'number':
      return {
        ...(config.precision === undefined ? {} : { precision: config.precision }),
        ...(config.currency ? { currency: config.currency } : {}),
      };
    case 'member':
      return { multiple: config.multiple === true };
    case 'relation':
      if (!config.table_id) throw invalidInput('A relation needs the data table it links to.');
      return { table_id: config.table_id, multiple: config.multiple !== false };
    default:
      return {};
  }
}

/** Types a field can change between while keeping its values as they are. */
const TEXT_KINDS: readonly FieldType[] = ['text', 'long_text', 'url', 'email', 'phone'];
export function canChangeType(from: FieldType, to: FieldType): boolean {
  if (from === to) return true;
  if (TEXT_KINDS.includes(from) && TEXT_KINDS.includes(to)) return true;
  return (from === 'single_select' && to === 'multi_select') || (from === 'date' && to === 'datetime');
}

/** A stored value carried into the new type (single → multi select wraps it; a day becomes midnight UTC). */
export function convertValue(from: FieldType, to: FieldType, value: unknown): unknown {
  if (from === 'single_select' && to === 'multi_select') return typeof value === 'string' ? [value] : value;
  if (from === 'date' && to === 'datetime') return typeof value === 'string' ? `${value}T00:00:00.000Z` : value;
  return value;
}

/** What a value refers to that the caller must check exists: members, records, files. */
export interface ValueRefs {
  members: Set<string>;
  /** Linked record ids by the table they must be in. */
  records: Map<string, Set<string>>;
  files: Set<string>;
}

export const emptyRefs = (): ValueRefs => ({ members: new Set(), records: new Map(), files: new Set() });

const isDay = (value: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
};

function ids(field: BaseFieldRow, value: unknown, max: number): string[] {
  const list = typeof value === 'string' ? [value] : value;
  if (!Array.isArray(list) || list.some((entry) => typeof entry !== 'string' || !entry || entry.length > 64)) {
    throw invalidValue(field, 'a list of ids');
  }
  const unique = [...new Set(list as string[])];
  if (unique.length > max) throw invalidValue(field, max === 1 ? 'one id' : `at most ${max} ids`);
  return unique;
}

const invalidValue = (field: BaseFieldRow, expected: string) =>
  invalidInput(`「${field.name}」 expects ${expected}.`, { field: field.id, field_name: field.name, expected });

/**
 * One value checked against its field and put in its stored form ('' and [] become null). The
 * ids it names are added to `refs` for the caller to check.
 */
export function normalizeValue(field: BaseFieldRow, value: unknown, refs: ValueRefs): unknown {
  if (field.type === 'checkbox') {
    if (value === null || value === undefined) return false;
    if (typeof value !== 'boolean') throw invalidValue(field, 'true or false');
    return value;
  }
  if (isEmptyValue(value)) return null;
  const config = field.config;
  switch (field.type) {
    case 'text':
    case 'phone': {
      if (typeof value !== 'string' || value.length > (field.type === 'phone' ? 64 : TEXT_MAX)) {
        throw invalidValue(field, field.type === 'phone' ? 'a phone number' : `text up to ${TEXT_MAX} characters`);
      }
      return value;
    }
    case 'long_text':
      if (typeof value !== 'string' || value.length > LONG_TEXT_MAX) {
        throw invalidValue(field, `text up to ${LONG_TEXT_MAX} characters`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) throw invalidValue(field, 'a number');
      return value;
    case 'date':
      if (typeof value !== 'string' || !isDay(value)) throw invalidValue(field, 'a date (YYYY-MM-DD)');
      return value;
    case 'datetime': {
      const instant = typeof value === 'string' ? new Date(value) : null;
      if (!instant || Number.isNaN(instant.valueOf())) throw invalidValue(field, 'a date and time (ISO 8601)');
      return instant.toISOString();
    }
    case 'url': {
      if (typeof value !== 'string' || value.length > 2000) throw invalidValue(field, 'a web address');
      try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
      } catch {
        throw invalidValue(field, 'a web address starting with http:// or https://');
      }
      return value;
    }
    case 'email':
      if (typeof value !== 'string' || value.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        throw invalidValue(field, 'an email address');
      }
      return value;
    case 'single_select':
      if (typeof value !== 'string' || !config.options?.some((option) => option.id === value)) {
        throw invalidValue(field, 'one of its options');
      }
      return value;
    case 'multi_select': {
      const chosen = ids(field, value, MAX_LIST_VALUES);
      if (chosen.some((id) => !config.options?.some((option) => option.id === id))) {
        throw invalidValue(field, 'some of its options');
      }
      return chosen;
    }
    case 'member': {
      const chosen = ids(field, value, config.multiple ? MAX_LIST_VALUES : 1);
      for (const id of chosen) refs.members.add(id);
      return chosen;
    }
    case 'attachment': {
      const chosen = ids(field, value, 100);
      for (const id of chosen) refs.files.add(id);
      return chosen;
    }
    case 'relation':
    case 'parent':
    case 'dependency': {
      const max = field.type === 'parent' || (field.type === 'relation' && !config.multiple) ? 1 : MAX_LIST_VALUES;
      const chosen = ids(field, value, max);
      const table = field.type === 'relation' ? config.table_id! : field.tableId;
      const set = refs.records.get(table) ?? new Set<string>();
      for (const id of chosen) set.add(id);
      refs.records.set(table, set);
      return chosen;
    }
  }
}

/** Fields whose values live in their own rows rather than in `values`. */
export const keptApart = (field: Pick<BaseFieldRow, 'type'>) => isLinkType(field.type) || field.type === 'attachment';

/** The words a record is found by: its title (A), option labels (B), its other text (C). */
export function searchOf(fields: readonly BaseFieldRow[], values: Record<string, unknown>) {
  const title: string[] = [];
  const labels: string[] = [];
  const body: string[] = [];
  for (const field of fields) {
    const value = values[field.id];
    if (isEmptyValue(value)) continue;
    if (field.isPrimary && typeof value === 'string') title.push(value);
    else if (field.type === 'single_select' || field.type === 'multi_select') {
      for (const id of Array.isArray(value) ? value : [value]) {
        const label = field.config.options?.find((option) => option.id === id)?.label;
        if (label) labels.push(label);
      }
    } else if (['text', 'long_text', 'url', 'email', 'phone'].includes(field.type) && typeof value === 'string') {
      body.push(value);
    }
  }
  return { searchA: searchTokens(...title), searchB: searchTokens(...labels), searchC: searchTokens(...body) };
}

const CUT = 300;
const cut = (value: unknown) =>
  typeof value === 'string' && value.length > CUT ? `${value.slice(0, CUT)}…` : value === undefined ? null : value;
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Field by field, what is different between two versions of a record (long text cut short). */
export function changesBetween(
  fieldIds: Iterable<string>,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): BaseRecordChange[] {
  const changes: BaseRecordChange[] = [];
  for (const field of fieldIds) {
    if (same(before[field], after[field])) continue;
    changes.push({ field, before: cut(before[field]), after: cut(after[field]) });
  }
  return changes;
}

/** The record's title: its primary field's text. */
export const titleOf = (primary: BaseFieldRow | undefined, values: Record<string, unknown>) => {
  const value = primary ? values[primary.id] : null;
  return typeof value === 'string' ? value : '';
};

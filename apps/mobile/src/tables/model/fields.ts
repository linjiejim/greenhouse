/**
 * Tables fields on the phone — pure, no React / React Native, so the root
 * vitest pins them (./fields.test.ts). Mirrors the web's
 * `components/tables/field-types.ts` + `field-value.tsx` rules (the web modules
 * import the web i18n and cannot be vendored; the rules are small):
 *
 *  - a field's config arrives JSON-encoded from `/api/tables` (`TableField.config`)
 *    and as an object from the apps gateway (`AppRuntimeView.tables[].fields`);
 *  - a record shows the computed value for computed fields, else the stored one;
 *  - every value reads as plain text the same way (`valueText`), select / people
 *    values also as chips (`valueChips`);
 *  - the form maps each type onto one control (`controlFor`) and turns its draft
 *    back into the wire value (`wireValue`), sending only what changed.
 */

import {
  COMPUTED_FIELD_TYPES,
  type TableFieldConfig,
  type TableFieldType,
  type TableRecordValues,
  type TableSelectOption,
} from '../../shared/tables';

/** What every surface needs of a field: `/api/tables` rows and app runtime fields both fit. */
export interface FieldLike {
  id: number;
  name: string;
  type: TableFieldType | string;
  /** JSON text (`/api/tables`) or the parsed object (apps gateway). */
  config: unknown;
  is_primary?: boolean;
  isPrimary?: boolean;
  required?: boolean;
  position?: number;
}

const configCache = new WeakMap<object, TableFieldConfig>();

/** The field's config, parsed once per field object; `{}` when missing or malformed. */
export function fieldConfig(field: Pick<FieldLike, 'config'>): TableFieldConfig {
  const raw = field.config;
  if (raw && typeof raw === 'object') return raw as TableFieldConfig;
  if (typeof raw !== 'string' || !raw) return {};
  const key = field as object;
  const cached = configCache.get(key);
  if (cached) return cached;
  let parsed: TableFieldConfig = {};
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value as TableFieldConfig;
  } catch {
    parsed = {};
  }
  configCache.set(key, parsed);
  return parsed;
}

export function isPrimaryField(field: FieldLike): boolean {
  return field.is_primary === true || field.isPrimary === true;
}

export function isComputed(field: Pick<FieldLike, 'type'>): boolean {
  return (COMPUTED_FIELD_TYPES as readonly string[]).includes(field.type);
}

/** The type a value reads as: a formula reads as its result type. */
export function effectiveType(field: FieldLike): string {
  if (field.type === 'formula') return fieldConfig(field).formula?.resultType ?? 'text';
  return field.type;
}

export function selectOptions(field: FieldLike): TableSelectOption[] {
  return fieldConfig(field).options ?? [];
}

/** The primary field (else the first one) — what titles a record. */
export function primaryField<F extends FieldLike>(fields: readonly F[]): F | undefined {
  return fields.find(isPrimaryField) ?? fields[0];
}

/** A record's value for one field: the computed value when there is one, else the stored one. */
export function recordValue(
  record: { values: TableRecordValues; computed_values?: TableRecordValues },
  fieldId: number,
): unknown {
  const key = String(fieldId);
  const computed = record.computed_values?.[key];
  return computed === undefined ? record.values[key] : computed;
}

export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

/** How names and labels resolve — users from the directory / gateway refs, related rows from refs. */
export interface ValueLabels {
  user: (id: string) => string | undefined;
  /** A related record's label; `null` = outside the reader's scope. */
  record?: (tableId: number, recordId: number) => string | null | undefined;
  file?: (id: string) => string | undefined;
  yes: string;
  no: string;
  /** Shown for a related row the reader cannot see. */
  noAccess: string;
  /** BCP-47 tag for numbers and dates. */
  locale: string;
}

/**
 * A stored number as people read it: grouped the way the UI language groups
 * (760,000), with every decimal it was stored with — never rounded for show.
 */
export function formatFieldNumber(value: number, locale: string): string {
  const text = String(value);
  if (!Number.isFinite(value) || /e/i.test(text)) return text;
  const decimals = Math.min(text.split('.')[1]?.length ?? 0, 20);
  try {
    return new Intl.NumberFormat(locale, { maximumFractionDigits: decimals }).format(value);
  } catch {
    return text;
  }
}

/** `YYYY-MM-DD` as a short local day (a calendar day — formatted in UTC so no offset moves it). */
export function formatDayValue(day: string, locale: string): string {
  const date = new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.valueOf())) return day;
  try {
    return new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(
      date,
    );
  } catch {
    return day.slice(0, 10);
  }
}

/** An instant in the reader's zone. Hermes parses ISO strings (what the API sends). */
export function formatDateTimeValue(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  try {
    return date.toLocaleString(locale, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return value;
  }
}

function scalarText(value: unknown, labels: ValueLabels): string {
  if (typeof value === 'boolean') return value ? labels.yes : labels.no;
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return formatFieldNumber(value, labels.locale);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function idsOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value];
}

/** Relation targets (record ids) of a relation value. */
export function relationIds(value: unknown): number[] {
  return idsOf(value)
    .map((entry) => (typeof entry === 'object' && entry && 'id' in entry ? (entry as { id: unknown }).id : entry))
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Attachment file ids of an attachment value. */
export function attachmentIds(value: unknown): number[] {
  return idsOf(value)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * Select / people / related values as separate chips; null for types that read
 * as one line of text.
 */
export function valueChips(field: FieldLike, value: unknown, labels: ValueLabels): string[] | null {
  const type = effectiveType(field);
  const config = fieldConfig(field);
  const option = (id: unknown) => config.options?.find((entry) => entry.id === id)?.label ?? String(id);
  switch (type) {
    case 'single_select':
    case 'multi_select':
      return idsOf(value).map(option);
    case 'user':
    case 'multi_user':
      return idsOf(value).map((id) => labels.user(String(id)) ?? String(id));
    case 'relation': {
      const target = config.relation?.targetTableId ?? 0;
      return relationIds(value).map((id) => {
        const label = labels.record?.(target, id);
        return label === null ? labels.noAccess : (label ?? `#${id}`);
      });
    }
    case 'attachment':
      return attachmentIds(value).map((id) => labels.file?.(String(id)) ?? `#${id}`);
    case 'lookup':
      return idsOf(value)
        .flat()
        .map((entry) => scalarText(entry, labels));
    default:
      return null;
  }
}

/** One value as one line of text ('' when empty) — list subtitles, VoiceOver, kanban cards. */
export function valueText(field: FieldLike, value: unknown, labels: ValueLabels): string {
  if (isEmptyValue(value)) return '';
  const chips = valueChips(field, value, labels);
  if (chips) return chips.join(', ');
  const type = effectiveType(field);
  if (type === 'boolean') return value === true ? labels.yes : labels.no;
  if ((type === 'number' || type === 'rollup') && typeof value === 'number')
    return formatFieldNumber(value, labels.locale);
  if (type === 'date' && typeof value === 'string') return formatDayValue(value, labels.locale);
  if (type === 'datetime' && typeof value === 'string') return formatDateTimeValue(value, labels.locale);
  if (Array.isArray(value)) return value.map((entry) => scalarText(entry, labels)).join(', ');
  return scalarText(value, labels);
}

/** A record's title: its primary field as text, else `#id`. */
export function recordTitle(
  record: { id: number; values: TableRecordValues; computed_values?: TableRecordValues },
  fields: readonly FieldLike[],
  labels: ValueLabels,
): string {
  const primary = primaryField(fields);
  const text = primary ? valueText(primary, recordValue(record, primary.id), labels).trim() : '';
  return text || `#${record.id}`;
}

// ─── Editing ──────────────────────────────────────────────

/** The one control each field type edits with (spec 20261011-mobile-tables-apps §3). */
export type FieldControl =
  | 'text'
  | 'long_text'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'single_select'
  | 'user'
  | 'multi_select'
  | 'multi_user'
  | 'relation'
  | 'attachment'
  | 'readonly';

export function controlFor(field: Pick<FieldLike, 'type'>): FieldControl {
  if (isComputed(field)) return 'readonly';
  switch (field.type) {
    case 'text':
    case 'url':
    case 'email':
    case 'phone':
      return 'text';
    case 'long_text':
    case 'number':
    case 'boolean':
    case 'date':
    case 'datetime':
    case 'single_select':
    case 'user':
    case 'multi_select':
    case 'multi_user':
    case 'relation':
    case 'attachment':
      return field.type;
    default:
      return 'readonly';
  }
}

/** The system keyboard a text-like field wants. */
export function keyboardFor(type: string): 'default' | 'url' | 'email-address' | 'phone-pad' | 'decimal-pad' {
  switch (type) {
    case 'url':
      return 'url';
    case 'email':
      return 'email-address';
    case 'phone':
      return 'phone-pad';
    case 'number':
      return 'decimal-pad';
    default:
      return 'default';
  }
}

/** Whether a relation field holds several records. */
export function relationMultiple(field: FieldLike): boolean {
  return fieldConfig(field).relation?.multiple === true;
}

/**
 * What a form control holds for a stored value: text-like and number fields edit a
 * string, multi-valued ones an array, a boolean a boolean, dates a `YYYY-MM-DD` /
 * ISO string or null.
 */
export function draftValue(field: FieldLike, stored: unknown): unknown {
  switch (controlFor(field)) {
    case 'text':
    case 'long_text':
      return typeof stored === 'string' ? stored : stored == null ? '' : String(stored);
    case 'number':
      return typeof stored === 'number' ? String(stored) : typeof stored === 'string' ? stored : '';
    case 'boolean':
      return stored === true;
    case 'date':
      return typeof stored === 'string' && /^\d{4}-\d{2}-\d{2}/.test(stored) ? stored.slice(0, 10) : null;
    case 'datetime':
      return typeof stored === 'string' && stored ? stored : null;
    case 'single_select':
    case 'user':
      return typeof stored === 'string' && stored ? stored : null;
    case 'multi_select':
    case 'multi_user':
      return idsOf(stored).map(String);
    case 'relation':
      return relationIds(stored);
    case 'attachment':
      return attachmentIds(stored);
    default:
      return stored;
  }
}

/** A number draft is a number (or empty). */
export function numberDraftValid(draft: unknown): boolean {
  if (typeof draft !== 'string' || draft.trim() === '') return true;
  return Number.isFinite(Number(draft.trim().replace(/,/g, '')));
}

/** The draft as the API takes it; `null` clears the field. */
export function wireValue(field: FieldLike, draft: unknown): unknown {
  switch (controlFor(field)) {
    case 'text':
    case 'long_text': {
      const text = typeof draft === 'string' ? draft : '';
      return text.trim() === '' ? null : text;
    }
    case 'number': {
      const text = typeof draft === 'string' ? draft.trim().replace(/,/g, '') : '';
      if (text === '') return null;
      const value = Number(text);
      return Number.isFinite(value) ? value : null;
    }
    case 'boolean':
      return draft === true;
    case 'date':
    case 'datetime':
    case 'single_select':
    case 'user':
      return typeof draft === 'string' && draft ? draft : null;
    case 'multi_select':
    case 'multi_user':
      return Array.isArray(draft) && draft.length ? draft.map(String) : null;
    case 'relation': {
      // the store takes a single relation as one record id, a multiple one as an array
      const ids = Array.isArray(draft) ? draft.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
      if (!ids.length) return null;
      return relationMultiple(field) ? ids : ids[0]!;
    }
    case 'attachment':
      return Array.isArray(draft) && draft.length ? draft.map(Number) : null;
    default:
      return draft;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * The values to send: every editable field whose draft differs from where it
 * started (all non-empty ones for a new record), as wire values.
 */
export function changedValues(
  fields: readonly FieldLike[],
  editable: ReadonlySet<number>,
  initial: Readonly<Record<string, unknown>>,
  draft: Readonly<Record<string, unknown>>,
  opts: { create: boolean },
): TableRecordValues {
  const out: TableRecordValues = {};
  for (const field of fields) {
    if (!editable.has(field.id)) continue;
    const key = String(field.id);
    if (!(key in draft)) continue;
    const next = wireValue(field, draft[key]);
    if (opts.create) {
      if (!isEmptyValue(next) && !(field.type === 'boolean' && next === false)) out[key] = next;
      continue;
    }
    if (!sameValue(wireValue(field, initial[key]), next)) out[key] = next;
  }
  return out;
}

/** Required editable fields left empty (D3: required only binds the fields the writer may edit). */
export function missingRequired(
  fields: readonly FieldLike[],
  editable: ReadonlySet<number>,
  draft: Readonly<Record<string, unknown>>,
): FieldLike[] {
  return fields.filter((field) => {
    if (!field.required || !editable.has(field.id) || controlFor(field) === 'readonly') return false;
    if (field.type === 'boolean') return false;
    return isEmptyValue(wireValue(field, draft[String(field.id)]));
  });
}

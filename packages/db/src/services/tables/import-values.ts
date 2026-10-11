/**
 * Import values — the text of one spreadsheet cell → a field value.
 *
 * Pure (no database). The caller hands in what matching needs: the member
 * directory, the relation labels already restricted to what the writer may
 * read (D14), and the time zone for datetimes written without an offset. The
 * result is a value `validateTableFieldValue` accepts, or the reason the cell
 * cannot be imported. The record write still validates everything again
 * (required fields, scope, select options), so this module decides *meaning*,
 * never permission.
 *
 * Also here, because they read cells the same way: column type inference for
 * new fields, header ↔ field-name matching, and the select options a column
 * would add.
 */

import type { TableFieldConfig, TableFieldType, TableSelectOption } from '@greenhouse/types/tables';
import { zoneOffsetMs } from './query.js';

export interface ImportField {
  id: number;
  name: string;
  type: TableFieldType;
  config: TableFieldConfig;
}

export interface ImportDirectoryUser {
  id: string;
  email: string;
  nickname: string;
}

/** Lookup tables built once per import (`buildImportUserDirectory`). */
export interface ImportUserDirectory {
  byId: ReadonlySet<string>;
  /** Lower-cased email → id. */
  byEmail: ReadonlyMap<string, string>;
  /** Lower-cased nickname → ids (a shared name is ambiguous). */
  byName: ReadonlyMap<string, readonly string[]>;
}

export type ImportDateOrder = 'mdy' | 'dmy';

export interface ImportValueContext {
  /** IANA zone for datetimes without an offset. */
  timeZone: string;
  /** Day / month order of ambiguous `03/04/2024` dates in this column (default mdy). */
  dateOrder?: ImportDateOrder;
  users?: ImportUserDirectory;
  /**
   * Relation fields only: the target table's primary text → record ids, limited
   * to records the writer may read. Undefined = the target is not available to
   * the writer, so no label matches.
   */
  relationLabels?: ReadonlyMap<string, readonly number[]>;
}

/** `value: undefined` = leave the field unset (an empty cell). */
export type ImportCellResult = { ok: true; value: unknown } | { ok: false; error: string };

const MAX_SHOWN = 60;
/** Labels a new select option may carry (the option validator's limit). */
const MAX_OPTION_LABEL = 100;
const MAX_SELECT_OPTIONS = 100;

/** Separators between several values in one cell: comma, semicolon, the Chinese 顿号, line breaks. */
const LIST_SEPARATOR = /\s*[,;，；、\n]\s*/;

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on', 'checked', '✓', '✔', '√', '是', '对', '真', '有', '已']);
const FALSE_WORDS = new Set([
  'false',
  'no',
  'n',
  '0',
  'off',
  'unchecked',
  '✗',
  '✘',
  '×',
  '否',
  '不',
  '不是',
  '错',
  '假',
  '无',
  '没有',
  '未',
]);

const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/** `Mar`, `march`, `Sept` → 3 / 3 / 9; anything that is not a month name (or its 3+ letter start) → undefined. */
function monthNumber(name: string): number | undefined {
  const lower = name.toLowerCase();
  if (lower.length < 3) return undefined;
  const index = MONTH_NAMES.findIndex((month) => month.startsWith(lower));
  return index === -1 ? undefined : index + 1;
}

function shown(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN)}…` : flat;
}

function failure(field: Pick<ImportField, 'name'>, message: string): ImportCellResult {
  return { ok: false, error: `${field.name}: ${message}` };
}

function normalizeCell(raw: string): string {
  return raw.normalize('NFKC').trim();
}

function splitList(text: string): string[] {
  return [...new Set(text.split(LIST_SEPARATOR).map((part) => part.trim()))].filter(Boolean);
}

// ─── Numbers ──────────────────────────────────────────────

/**
 * `1,234.5`, `(1,234)`, `¥ 99`, `12.5%` (→ 0.125, as a spreadsheet stores it),
 * `1 234`, `1e3`. A comma is only ever a thousands separator (groups of three);
 * `1,5` is refused rather than guessed.
 */
export function parseImportNumber(raw: string): number | null {
  let text = normalizeCell(raw);
  if (!text) return null;
  let negative = false;
  const parenthesized = /^\((.+)\)$/.exec(text);
  if (parenthesized) {
    negative = true;
    text = parenthesized[1]!.trim();
  }
  text = text
    .replace(/^(?:US\$|RMB|CNY|USD|EUR|[$€£¥₩₹])\s*/i, '')
    .replace(/\s*(?:元|[$€£¥])$/, '')
    .trim();
  let percent = false;
  if (text.endsWith('%')) {
    percent = true;
    text = text.slice(0, -1).trim();
  }
  text = text.replace(/(?<=\d)[\s_'](?=\d)/g, '');
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replaceAll(',', '');
  if (!/^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(text)) return null;
  let value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (negative) value = -value;
  if (percent) value /= 100;
  return value;
}

// ─── Dates ────────────────────────────────────────────────

function isoDay(year: number, month: number, day: number): string | null {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function fullYear(text: string): number {
  const year = Number(text);
  if (text.length > 2) return year;
  return year < 50 ? 2000 + year : 1900 + year;
}

/** The calendar day written in `text` (no time part), or null. */
function parseDayPart(text: string, order: ImportDateOrder): string | null {
  let match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?$/.exec(text);
  if (match) return isoDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{4})(\d{2})(\d{2})$/.exec(text);
  if (match) return isoDay(Number(match[1]), Number(match[2]), Number(match[3]));
  match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(text);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = fullYear(match[3]!);
    const dayFirst = first > 12 || (second <= 12 && order === 'dmy');
    return dayFirst ? isoDay(year, second, first) : isoDay(year, first, second);
  }
  match = /^(\d{1,2})[\s-]([a-z]{3,9})\.?[\s,-]+(\d{4}|\d{2})$/i.exec(text);
  if (match) {
    const month = monthNumber(match[2]!);
    return month ? isoDay(fullYear(match[3]!), month, Number(match[1])) : null;
  }
  match = /^([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i.exec(text);
  if (match) {
    const month = monthNumber(match[1]!);
    return month ? isoDay(Number(match[3]), month, Number(match[2])) : null;
  }
  return null;
}

interface TimeOfDay {
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const TIME_PART = /^(上午|下午)?\s*(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?\s*([ap]\.?\s?m\.?)?$/i;

function parseTimePart(text: string): TimeOfDay | null {
  const match = TIME_PART.exec(text.trim());
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? 0);
  const millisecond = Number((match[5] ?? '0').padEnd(3, '0').slice(0, 3));
  const meridiem = match[6]?.toLowerCase().replace(/[.\s]/g, '') ?? (match[1] === '下午' ? 'pm' : match[1] ? 'am' : '');
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second, millisecond };
}

/** Splits `<day> <time>` / `<day>T<time>`; the time is optional. */
function splitDayAndTime(text: string): { day: string; time: string | null } {
  const match = /^(.+?)(?:T|\s+)((?:上午|下午)?\s*\d{1,2}:\d{2}.*)$/.exec(text);
  return match ? { day: match[1]!.trim(), time: match[2]!.trim() } : { day: text, time: null };
}

/**
 * A calendar day in any common spelling → `YYYY-MM-DD`: ISO, `2024/3/5`,
 * `2024年3月5日`, `20240305`, `03/04/2024` (order per column), `5 Mar 2024`,
 * `Mar 5, 2024`. A trailing time is ignored — a date field stores the day as written.
 */
export function parseImportDate(raw: string, order: ImportDateOrder = 'mdy'): string | null {
  const text = normalizeCell(raw);
  if (!text) return null;
  const direct = parseDayPart(text, order);
  if (direct) return direct;
  const { day, time } = splitDayAndTime(text);
  return time !== null ? parseDayPart(day, order) : null;
}

/** The instant a wall-clock time in `timeZone` names (DST-safe: the offset is re-read at the candidate). */
function wallTimeToIso(day: string, time: TimeOfDay, timeZone: string): string {
  const local =
    Date.parse(`${day}T00:00:00.000Z`) + ((time.hour * 60 + time.minute) * 60 + time.second) * 1000 + time.millisecond;
  const first = local - zoneOffsetMs(local, timeZone);
  return new Date(local - zoneOffsetMs(first, timeZone)).toISOString();
}

/**
 * A datetime → ISO instant. With an offset (`Z`, `+08:00`) it is exact; without
 * one it is wall-clock time in `timeZone` (the importer's zone); a bare day is
 * that day's midnight there.
 */
export function parseImportDateTime(raw: string, timeZone: string, order: ImportDateOrder = 'mdy'): string | null {
  const text = normalizeCell(raw);
  if (!text) return null;
  const zoned = /^(\d{4}-\d{2}-\d{2})[T\s](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(text);
  if (zoned) {
    const offset = zoned[3]!.toUpperCase() === 'Z' ? 'Z' : zoned[3]!.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const time = zoned[2]!.length === 4 ? `0${zoned[2]}` : zoned[2]!;
    const instant = Date.parse(`${zoned[1]}T${time}${offset}`);
    return Number.isNaN(instant) ? null : new Date(instant).toISOString();
  }
  const { day: dayText, time: timeText } = splitDayAndTime(text);
  const day = parseDayPart(dayText, order);
  if (!day) return null;
  const time = timeText === null ? { hour: 0, minute: 0, second: 0, millisecond: 0 } : parseTimePart(timeText);
  return time ? wallTimeToIso(day, time, timeZone) : null;
}

/**
 * `dmy` when some value in the column can only be day-first (`25/12/2024`);
 * otherwise `mdy`. Decided per column, because one cell cannot tell `03/04` apart.
 */
export function inferImportDateOrder(values: readonly string[]): ImportDateOrder {
  for (const raw of values) {
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(normalizeCell(raw));
    if (match && Number(match[1]) > 12 && Number(match[2]) <= 12) return 'dmy';
  }
  return 'mdy';
}

// ─── Select options, users ────────────────────────────────

function findOption(options: readonly TableSelectOption[], label: string): TableSelectOption | undefined {
  const lower = label.toLowerCase();
  return (
    options.find((option) => option.label === label) ??
    options.find((option) => option.label.trim().toLowerCase() === lower) ??
    options.find((option) => option.id === label)
  );
}

function selectLabels(field: ImportField, text: string): string[] {
  if (field.type === 'single_select') return [text];
  // A configured label may itself contain a separator ("Red, dark").
  if (findOption(field.config.options ?? [], text)) return [text];
  return splitList(text);
}

/** The cell's labels that are not options of `field` yet (in order, deduplicated). */
export function missingSelectLabels(field: ImportField, raw: string): string[] {
  const text = raw.trim();
  if (!text || (field.type !== 'single_select' && field.type !== 'multi_select')) return [];
  const options = field.config.options ?? [];
  return selectLabels(field, text).filter((label) => !findOption(options, label));
}

function optionSlug(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'option'
  );
}

/**
 * `options` plus one new option per label (ids unique, labels ≤ 100 characters,
 * at most 100 options in all). Labels that do not fit are left out — their
 * cells then fail like any unknown option.
 */
export function withImportedOptions(
  options: readonly TableSelectOption[],
  labels: readonly string[],
): TableSelectOption[] {
  const next = [...options];
  const ids = new Set(next.map((option) => option.id));
  for (const label of labels) {
    if (next.length >= MAX_SELECT_OPTIONS) break;
    if (label.length > MAX_OPTION_LABEL || findOption(next, label)) continue;
    const slug = optionSlug(label);
    let suffix = next.length + 1;
    while (ids.has(`${slug}-${suffix}`)) suffix += 1;
    const id = `${slug}-${suffix}`;
    ids.add(id);
    next.push({ id, label });
  }
  return next;
}

export function buildImportUserDirectory(users: readonly ImportDirectoryUser[]): ImportUserDirectory {
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const user of users) {
    if (user.email) byEmail.set(user.email.trim().toLowerCase(), user.id);
    const name = user.nickname?.trim().toLowerCase();
    if (name) byName.set(name, [...(byName.get(name) ?? []), user.id]);
  }
  return { byId: new Set(users.map((user) => user.id)), byEmail, byName };
}

function matchUser(directory: ImportUserDirectory, label: string): { id: string } | { error: string } {
  const lower = label.toLowerCase();
  const byEmail = directory.byEmail.get(lower.replace(/^mailto:/, ''));
  if (byEmail) return { id: byEmail };
  const byName = directory.byName.get(lower) ?? [];
  if (byName.length === 1) return { id: byName[0]! };
  if (byName.length > 1) return { error: `"${shown(label)}" matches several members — use their email` };
  if (directory.byId.has(label)) return { id: label };
  return { error: `no member named "${shown(label)}"` };
}

// ─── The one coercion ─────────────────────────────────────

/**
 * One cell → one field value. Empty cells leave the field unset; attachments
 * and computed fields are never imported.
 */
export function coerceImportValue(field: ImportField, raw: string, ctx: ImportValueContext): ImportCellResult {
  // Labels (text, options, names, linked records) are matched as written;
  // numbers, dates and yes / no are read after width normalization (１２ → 12).
  const label = raw.trim();
  const text = normalizeCell(raw);
  if (!text) return { ok: true, value: undefined };

  switch (field.type) {
    case 'text':
    case 'long_text': {
      const value = label;
      const max = field.type === 'text' ? 10_000 : 100_000;
      return value.length <= max
        ? { ok: true, value }
        : failure(field, `longer than ${max.toLocaleString('en-US')} characters`);
    }
    case 'number': {
      const value = parseImportNumber(text);
      return value === null ? failure(field, `"${shown(raw)}" is not a number`) : { ok: true, value };
    }
    case 'boolean': {
      const lower = text.toLowerCase();
      if (TRUE_WORDS.has(lower)) return { ok: true, value: true };
      if (FALSE_WORDS.has(lower)) return { ok: true, value: false };
      return failure(field, `"${shown(raw)}" is not yes / no`);
    }
    case 'date': {
      const value = parseImportDate(text, ctx.dateOrder);
      return value === null ? failure(field, `"${shown(raw)}" is not a date`) : { ok: true, value };
    }
    case 'datetime': {
      const value = parseImportDateTime(text, ctx.timeZone, ctx.dateOrder);
      return value === null ? failure(field, `"${shown(raw)}" is not a date and time`) : { ok: true, value };
    }
    case 'single_select':
    case 'multi_select': {
      const options = field.config.options ?? [];
      const ids: string[] = [];
      for (const part of selectLabels(field, label)) {
        const option = findOption(options, part);
        if (!option) return failure(field, `"${shown(part)}" is not an option`);
        if (!ids.includes(option.id)) ids.push(option.id);
      }
      return { ok: true, value: field.type === 'single_select' ? ids[0] : ids };
    }
    case 'user':
    case 'multi_user': {
      if (!ctx.users) return failure(field, 'the member directory is unavailable');
      const names = field.type === 'user' ? [label] : splitList(label);
      const ids: string[] = [];
      for (const name of names) {
        const match = matchUser(ctx.users, name);
        if ('error' in match) return failure(field, match.error);
        if (!ids.includes(match.id)) ids.push(match.id);
      }
      return { ok: true, value: field.type === 'user' ? ids[0] : ids };
    }
    case 'url': {
      const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text)
        ? text
        : /^[^\s/@]+\.[^\s]+$/.test(text)
          ? `https://${text}`
          : null;
      try {
        const url = candidate ? new URL(candidate) : null;
        if (url && (url.protocol === 'http:' || url.protocol === 'https:') && candidate!.length <= 2_000) {
          return { ok: true, value: candidate };
        }
      } catch {
        // Fall through to the refusal.
      }
      return failure(field, `"${shown(raw)}" is not a web address`);
    }
    case 'email': {
      const value = text.replace(/^mailto:/i, '');
      return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
        ? { ok: true, value }
        : failure(field, `"${shown(raw)}" is not an email address`);
    }
    case 'phone':
      return text.length <= 64 ? { ok: true, value: text } : failure(field, 'longer than 64 characters');
    case 'relation': {
      const labels = ctx.relationLabels;
      if (!labels) return failure(field, 'the linked table is not available to you');
      const multiple = field.config.relation?.multiple === true;
      const parts = labels.has(label) || !multiple ? [label] : splitList(label);
      const ids: number[] = [];
      for (const part of parts) {
        const matches = labels.get(part) ?? [];
        if (matches.length === 0) return failure(field, `no linked record named "${shown(part)}"`);
        if (matches.length > 1) return failure(field, `"${shown(part)}" matches several linked records`);
        if (!ids.includes(matches[0]!)) ids.push(matches[0]!);
      }
      return { ok: true, value: multiple ? ids : ids[0] };
    }
    case 'attachment':
      return failure(field, 'attachments cannot be imported');
    case 'formula':
    case 'rollup':
    case 'lookup':
      return failure(field, 'computed fields cannot be imported');
  }
}

// ─── Columns ──────────────────────────────────────────────

const INFERENCE_SAMPLE = 500;

function hasTime(text: string): boolean {
  return splitDayAndTime(text).time !== null || /T\d{1,2}:\d{2}/.test(text);
}

/**
 * The field type a new field for this column should get: number, boolean, date,
 * datetime, email, url, single select (few repeated values), long text, text.
 */
export function inferImportColumnType(values: readonly string[]): TableFieldType {
  const cells = values.map(normalizeCell).filter(Boolean).slice(0, INFERENCE_SAMPLE);
  if (cells.length === 0) return 'text';
  const every = (test: (cell: string) => boolean) => cells.every(test);
  if (every((cell) => parseImportNumber(cell) !== null)) return 'number';
  if (every((cell) => TRUE_WORDS.has(cell.toLowerCase()) || FALSE_WORDS.has(cell.toLowerCase()))) return 'boolean';
  const order = inferImportDateOrder(cells);
  if (every((cell) => !hasTime(cell) && parseImportDate(cell, order) !== null)) return 'date';
  if (every((cell) => parseImportDateTime(cell, 'UTC', order) !== null)) return 'datetime';
  if (every((cell) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cell))) return 'email';
  if (every((cell) => /^https?:\/\/\S+$/i.test(cell) || /^www\.\S+\.\S+$/i.test(cell))) return 'url';
  if (values.some((value) => value.length > 255 || value.includes('\n'))) return 'long_text';
  const distinct = new Set(cells);
  if (
    cells.length >= 4 &&
    distinct.size <= 12 &&
    distinct.size <= cells.length / 2 &&
    [...distinct].every((cell) => cell.length <= 40)
  ) {
    return 'single_select';
  }
  return 'text';
}

function headerKey(text: string): string {
  return text
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, ' ');
}

/** The field whose name matches this header (case, width and spacing ignored), if exactly one does. */
export function matchImportHeader<T extends Pick<ImportField, 'name'>>(
  header: string,
  fields: readonly T[],
): T | undefined {
  const key = headerKey(header);
  if (!key) return undefined;
  const matches = fields.filter((field) => headerKey(field.name) === key);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * Table cell text — the text of one spreadsheet / clipboard cell → a field value.
 *
 * The one reading of cell text in Tables. The CSV / Excel import
 * (`coerceImportValue` in packages/db) and the grid's paste (`parsePastedCell`
 * in apps/web) both call `coerceTableCellText`, so whatever imports also pastes
 * (`✓`, `on`, `¥1,200`, `50%`, `2024年3月5日`, a member's email). Pure and
 * dependency-free: it runs in the browser and in the API.
 *
 * Linked records are the one thing it does not read, because their meaning
 * depends on data only the caller holds: the import matches primary text among
 * the records the writer may read, the grid reads record ids. Both callers
 * handle `relation` before calling here.
 *
 * It decides *meaning*, never permission: the record write validates the value
 * again (required fields, scope, select options).
 */

import { zoneOffsetMs } from './date-tokens.js';
import type { TableFieldConfig, TableFieldType, TableSelectOption } from './tables.js';

export interface TableCellTextField {
  name: string;
  type: TableFieldType;
  config: TableFieldConfig;
}

export interface TableCellTextUser {
  id: string;
  email: string;
  nickname: string;
}

/** Lookup tables built once per import / paste (`buildTableCellUserDirectory`). */
export interface TableCellUserDirectory {
  byId: ReadonlySet<string>;
  /** Lower-cased email → id. */
  byEmail: ReadonlyMap<string, string>;
  /** Lower-cased nickname → ids (a shared name is ambiguous). */
  byName: ReadonlyMap<string, readonly string[]>;
}

export type TableCellDateOrder = 'mdy' | 'dmy';

export interface TableCellTextContext {
  /** IANA zone for datetimes written without an offset (the importer's / paster's zone). */
  timeZone: string;
  /** Day / month order of ambiguous `03/04/2024` dates in this column (default mdy). */
  dateOrder?: TableCellDateOrder;
  /** Members a person cell may name; without it person cells are refused. */
  users?: TableCellUserDirectory;
}

/** `value: undefined` = leave the field unset (an empty cell). */
export type TableCellTextResult = { ok: true; value: unknown } | { ok: false; error: string };

const MAX_SHOWN = 60;

/** Separators between several values in one cell: comma, semicolon, their full-width forms, the 顿号, line breaks. */
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

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

/** A cell as quoted in an error message: one line, at most 60 characters. */
export function shownCellText(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_SHOWN ? `${flat.slice(0, MAX_SHOWN)}…` : flat;
}

/** The refusal for one cell, prefixed with the field's name. */
export function tableCellTextFailure(field: Pick<TableCellTextField, 'name'>, message: string): TableCellTextResult {
  return { ok: false, error: `${field.name}: ${message}` };
}

/** Width-normalized (`１２` → `12`) and trimmed: how numbers, dates and yes / no are read. */
export function normalizeCellText(raw: string): string {
  return raw.normalize('NFKC').trim();
}

/** The values of a multi-value cell, trimmed, deduplicated, empties dropped. */
export function splitCellList(text: string): string[] {
  return [...new Set(text.split(LIST_SEPARATOR).map((part) => part.trim()))].filter(Boolean);
}

// ─── Numbers, yes / no ────────────────────────────────────

/**
 * `1,234.5`, `(1,234)`, `¥ 99`, `12.5%` (→ 0.125, as a spreadsheet stores it),
 * `1 234`, `1e3`. A comma is only ever a thousands separator (groups of three);
 * `1,5` is refused rather than guessed.
 */
export function parseCellNumber(raw: string): number | null {
  let text = normalizeCellText(raw);
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

/** `yes` / `on` / `✓` / `是` → true, `no` / `off` / `✗` / `否` → false, anything else → null. */
export function parseCellBoolean(raw: string): boolean | null {
  const lower = normalizeCellText(raw).toLowerCase();
  if (TRUE_WORDS.has(lower)) return true;
  if (FALSE_WORDS.has(lower)) return false;
  return null;
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
function parseDayPart(text: string, order: TableCellDateOrder): string | null {
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

/**
 * Splits `<day> <time>` / `<day>T<time>`; the time is optional. A comma between
 * the two (`May 14, 2026, 10:30 PM` — how the grid shows a datetime) is dropped.
 */
function splitDayAndTime(text: string): { day: string; time: string | null } {
  const match = /^(.+?)(?:T|,?\s+)((?:上午|下午)?\s*\d{1,2}:\d{2}.*)$/.exec(text);
  return match ? { day: match[1]!.trim(), time: match[2]!.trim() } : { day: text, time: null };
}

/** True when the cell carries a time of day (`2024-03-05 10:00`, `…T10:00`). */
export function cellTextHasTime(raw: string): boolean {
  const text = normalizeCellText(raw);
  return splitDayAndTime(text).time !== null || /T\d{1,2}:\d{2}/.test(text);
}

/**
 * A calendar day in any common spelling → `YYYY-MM-DD`: ISO, `2024/3/5`,
 * `2024年3月5日`, `20240305`, `03/04/2024` (order per column), `5 Mar 2024`,
 * `Mar 5, 2024`. A trailing time is ignored — a date field stores the day as written.
 */
export function parseCellDate(raw: string, order: TableCellDateOrder = 'mdy'): string | null {
  const text = normalizeCellText(raw);
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
 * one it is wall-clock time in `timeZone`; a bare day is that day's midnight there.
 */
export function parseCellDateTime(raw: string, timeZone: string, order: TableCellDateOrder = 'mdy'): string | null {
  const text = normalizeCellText(raw);
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
export function inferCellDateOrder(values: readonly string[]): TableCellDateOrder {
  for (const raw of values) {
    const match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})\b/.exec(normalizeCellText(raw));
    if (match && Number(match[1]) > 12 && Number(match[2]) <= 12) return 'dmy';
  }
  return 'mdy';
}

// ─── Addresses ────────────────────────────────────────────

/** An email address (a `mailto:` prefix is dropped), or null. */
export function parseCellEmail(raw: string): string | null {
  const value = normalizeCellText(raw).replace(/^mailto:/i, '');
  return value.length <= 320 && EMAIL_PATTERN.test(value) ? value : null;
}

/** An http(s) address; a bare host (`www.example.com`) gets `https://`. Anything else → null. */
export function parseCellUrl(raw: string): string | null {
  const text = normalizeCellText(raw);
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text)
    ? text
    : /^[^\s/@]+\.[^\s]+$/.test(text)
      ? `https://${text}`
      : null;
  if (!candidate || candidate.length > 2_000) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : null;
  } catch {
    return null;
  }
}

// ─── Select options, members ──────────────────────────────

/** The option a label names: exact label, then label ignoring case, then option id. */
export function findCellOption(options: readonly TableSelectOption[], label: string): TableSelectOption | undefined {
  const lower = label.toLowerCase();
  return (
    options.find((option) => option.label === label) ??
    options.find((option) => option.label.trim().toLowerCase() === lower) ??
    options.find((option) => option.id === label) ??
    options.find((option) => option.id.toLowerCase() === lower)
  );
}

/** The option labels a select cell names (a configured label may itself contain a separator: "Red, dark"). */
export function cellSelectLabels(field: TableCellTextField, text: string): string[] {
  if (field.type === 'single_select') return [text];
  if (findCellOption(field.config.options ?? [], text)) return [text];
  return splitCellList(text);
}

export function buildTableCellUserDirectory(users: readonly TableCellTextUser[]): TableCellUserDirectory {
  const byEmail = new Map<string, string>();
  const byName = new Map<string, string[]>();
  for (const user of users) {
    if (user.email) byEmail.set(user.email.trim().toLowerCase(), user.id);
    const name = user.nickname?.trim().toLowerCase();
    if (name) byName.set(name, [...(byName.get(name) ?? []), user.id]);
  }
  return { byId: new Set(users.map((user) => user.id)), byEmail, byName };
}

function matchUser(directory: TableCellUserDirectory, label: string): { id: string } | { error: string } {
  const lower = label.toLowerCase();
  const byEmail = directory.byEmail.get(lower.replace(/^mailto:/, ''));
  if (byEmail) return { id: byEmail };
  const byName = directory.byName.get(lower) ?? [];
  if (byName.length === 1) return { id: byName[0]! };
  if (byName.length > 1) return { error: `"${shownCellText(label)}" matches several members — use their email` };
  if (directory.byId.has(label)) return { id: label };
  return { error: `no member named "${shownCellText(label)}"` };
}

// ─── The one coercion ─────────────────────────────────────

/**
 * One cell → one field value. Empty cells leave the field unset (the caller
 * decides whether that means "skip" or "clear"); attachments and computed fields
 * are never read from text; linked records are the caller's (see the header).
 */
export function coerceTableCellText(
  field: TableCellTextField,
  raw: string,
  ctx: TableCellTextContext,
): TableCellTextResult {
  // Labels (text, options, names) are matched as written; numbers, dates and
  // yes / no are read after width normalization (１２ → 12).
  const label = raw.trim();
  const text = normalizeCellText(raw);
  if (!text) return { ok: true, value: undefined };

  switch (field.type) {
    case 'text':
    case 'long_text': {
      const max = field.type === 'text' ? 10_000 : 100_000;
      return label.length <= max
        ? { ok: true, value: label }
        : tableCellTextFailure(field, `longer than ${max.toLocaleString('en-US')} characters`);
    }
    case 'number': {
      const value = parseCellNumber(text);
      return value === null
        ? tableCellTextFailure(field, `"${shownCellText(raw)}" is not a number`)
        : { ok: true, value };
    }
    case 'boolean': {
      const value = parseCellBoolean(text);
      return value === null
        ? tableCellTextFailure(field, `"${shownCellText(raw)}" is not yes / no`)
        : { ok: true, value };
    }
    case 'date': {
      const value = parseCellDate(text, ctx.dateOrder);
      return value === null
        ? tableCellTextFailure(field, `"${shownCellText(raw)}" is not a date`)
        : { ok: true, value };
    }
    case 'datetime': {
      const value = parseCellDateTime(text, ctx.timeZone, ctx.dateOrder);
      return value === null
        ? tableCellTextFailure(field, `"${shownCellText(raw)}" is not a date and time`)
        : { ok: true, value };
    }
    case 'single_select':
    case 'multi_select': {
      const options = field.config.options ?? [];
      const ids: string[] = [];
      for (const part of cellSelectLabels(field, label)) {
        const option = findCellOption(options, part);
        if (!option) return tableCellTextFailure(field, `"${shownCellText(part)}" is not an option`);
        if (!ids.includes(option.id)) ids.push(option.id);
      }
      return { ok: true, value: field.type === 'single_select' ? ids[0] : ids };
    }
    case 'user':
    case 'multi_user': {
      if (!ctx.users) return tableCellTextFailure(field, 'the member directory is unavailable');
      const names = field.type === 'user' ? [label] : splitCellList(label);
      const ids: string[] = [];
      for (const name of names) {
        const match = matchUser(ctx.users, name);
        if ('error' in match) return tableCellTextFailure(field, match.error);
        if (!ids.includes(match.id)) ids.push(match.id);
      }
      return { ok: true, value: field.type === 'user' ? ids[0] : ids };
    }
    case 'url': {
      const value = parseCellUrl(text);
      return value === null
        ? tableCellTextFailure(field, `"${shownCellText(raw)}" is not a web address`)
        : { ok: true, value };
    }
    case 'email': {
      const value = parseCellEmail(text);
      return value === null
        ? tableCellTextFailure(field, `"${shownCellText(raw)}" is not an email address`)
        : { ok: true, value };
    }
    case 'phone':
      return text.length <= 64 ? { ok: true, value: text } : tableCellTextFailure(field, 'longer than 64 characters');
    case 'relation':
      return tableCellTextFailure(field, 'linked records cannot be read from text here');
    case 'attachment':
      return tableCellTextFailure(field, 'files cannot be read from text');
    case 'formula':
    case 'rollup':
    case 'lookup':
      return tableCellTextFailure(field, 'computed fields cannot be written');
  }
}

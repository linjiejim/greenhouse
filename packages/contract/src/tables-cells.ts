/**
 * A cell as text and back: what a copy, a CSV export and the grid show (formatCell), and what a
 * paste or an import reads (parseCell). The server still checks every value it is sent; these
 * only translate. Dates are YYYY-MM-DD; a date-time shows in the reader's time zone.
 */

import { isComputedError, isComputedPending, type Field } from './tables.js';

export interface CellContext {
  timeZone: string;
  memberName?: (id: string) => string | undefined;
  /** A member by name or email (case-insensitive), for reading pasted text. */
  findMember?: (text: string) => string | undefined;
  /** A linked record's title. */
  linkedTitle?: (id: string) => string | undefined;
  /** A record of a table by its title, for reading pasted links. */
  findRecord?: (tableId: string, title: string) => string | undefined;
  fileName?: (id: string) => string | undefined;
}

/** Why a pasted or imported text cannot go into a field. */
export class CellParseError extends Error {
  constructor(
    readonly reason: 'number' | 'date' | 'datetime' | 'option' | 'member' | 'record' | 'unsupported',
    readonly text: string,
  ) {
    super(`Cannot read "${text}" (${reason})`);
    this.name = 'CellParseError';
  }
}

const pad = (value: number) => String(value).padStart(2, '0');

/** One formatter per time zone: making one costs far more than using it (a timeline reads thousands of values). */
const clocks = new Map<string, Intl.DateTimeFormat>();
function clockOf(timeZone: string): Intl.DateTimeFormat {
  let clock = clocks.get(timeZone);
  if (!clock) {
    clock = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    clocks.set(timeZone, clock);
  }
  return clock;
}

/** The calendar day and wall-clock time of an instant in a time zone. */
export function zonedParts(iso: string, timeZone: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return null;
  const parts = clockOf(timeZone).formatToParts(date);
  const pick = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: pick('year'), month: pick('month'), day: pick('day'), hour: pick('hour'), minute: pick('minute') };
}

/** YYYY-MM-DD of an instant in a time zone (today: `zonedDay(new Date().toISOString(), tz)`). */
export function zonedDay(iso: string, timeZone: string): string {
  const parts = zonedParts(iso, timeZone);
  return parts ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)}` : '';
}

/** The instant a wall-clock time (YYYY-MM-DD and HH:mm) is in a time zone. */
export function zonedInstant(day: string, time: string, timeZone: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(year, month - 1, date, hour, minute);
  // The zone's offset at the guess, then once more at the result (a DST change in between).
  const offset = (at: number) => {
    const parts = zonedParts(new Date(at).toISOString(), timeZone)!;
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - at;
  };
  const first = guess - offset(guess);
  return new Date(guess - offset(first)).toISOString();
}

export const isEmptyValue = (value: unknown) =>
  value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);

const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((id) => typeof id === 'string') : []);

/** The table a link field points to: a relation's target, else the field's own table. */
export const linkTarget = (field: Pick<Field, 'type' | 'table_id' | 'config'>) =>
  field.type === 'relation' ? (field.config.table_id ?? '') : field.table_id;

/** A computed value as text: a failure as `#` and its reason, one on its way as nothing. */
function formatComputed(field: Field, value: unknown, ctx: CellContext): string {
  if (isComputedError(value)) return `#${value.error}`;
  if (isComputedPending(value) || isEmptyValue(value)) return '';
  if (field.type === 'lookup') {
    return (Array.isArray(value) ? value : [value])
      .filter((item) => item !== null && item !== undefined && item !== '' && typeof item !== 'object')
      .map(String)
      .join(', ');
  }
  const result = field.type === 'ai' ? 'text' : (field.config.result ?? (field.type === 'rollup' ? 'number' : 'text'));
  const as = { ...field, type: result, config: { precision: field.config.precision } } as Field;
  if (result === 'checkbox') return value === true ? 'true' : 'false';
  return formatCell(as, value, ctx);
}

/** A value as plain text: options by label, members by name, links by title, files by name. */
export function formatCell(field: Field, value: unknown, ctx: CellContext): string {
  switch (field.type) {
    case 'formula':
    case 'lookup':
    case 'rollup':
    case 'ai':
      return formatComputed(field, value, ctx);
  }
  if (field.type === 'checkbox') return value === true ? 'true' : 'false';
  if (isEmptyValue(value)) return '';
  switch (field.type) {
    case 'number': {
      if (typeof value !== 'number') return '';
      return field.config.precision !== undefined ? value.toFixed(field.config.precision) : String(value);
    }
    case 'datetime': {
      const parts = typeof value === 'string' ? zonedParts(value, ctx.timeZone) : null;
      return parts ? `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}` : '';
    }
    case 'single_select':
      return field.config.options?.find((option) => option.id === value)?.label ?? '';
    case 'multi_select':
      return list(value)
        .map((id) => field.config.options?.find((option) => option.id === id)?.label)
        .filter(Boolean)
        .join(', ');
    case 'member':
      return list(value)
        .map((id) => ctx.memberName?.(id) ?? '')
        .filter(Boolean)
        .join(', ');
    case 'attachment':
      return list(value)
        .map((id) => ctx.fileName?.(id) ?? '')
        .filter(Boolean)
        .join(', ');
    case 'relation':
    case 'parent':
    case 'dependency':
      return list(value)
        .map((id) => ctx.linkedTitle?.(id) ?? '')
        .filter(Boolean)
        .join(', ');
    default:
      return typeof value === 'string' ? value : String(value);
  }
}

const TRUE_WORDS = new Set(['true', '1', 'yes', 'y', '是', '✓', '✔', 'x', 'checked', '已勾选']);

/** Several names in one cell: commas (either width), semicolons or new lines. */
export const splitList = (text: string) =>
  text
    .split(/[,，;；\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

/** YYYY-MM-DD from 2026-10-16, 2026/10/16, 2026.10.16 or 2026年10月16日. */
export function parseDay(text: string): string | null {
  const match = /^(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*日?$/.exec(text.trim());
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Text into a value for the field; an empty text clears it. Throws CellParseError when the text
 * is not something the field can hold. Attachments cannot be pasted.
 */
export function parseCell(field: Field, raw: string, ctx: CellContext): unknown {
  const text = raw.trim();
  if (field.type === 'checkbox') return TRUE_WORDS.has(text.toLowerCase());
  if (!text) return null;
  switch (field.type) {
    case 'text':
    case 'long_text':
      return raw;
    case 'url':
    case 'email':
    case 'phone':
      return text;
    case 'number': {
      const cleaned = text.replace(/[,\s，]/g, '').replace(/^[¥$€£]/, '');
      const number = cleaned.endsWith('%') ? Number(cleaned.slice(0, -1)) / 100 : Number(cleaned);
      if (!cleaned || !Number.isFinite(number)) throw new CellParseError('number', text);
      return number;
    }
    case 'date': {
      const day = parseDay(text.split(/[ T]/)[0] ?? '');
      if (!day) throw new CellParseError('date', text);
      return day;
    }
    case 'datetime': {
      const match = /^(.+?)[ T](\d{1,2}):(\d{2})/.exec(text);
      const day = parseDay(match ? match[1]! : text);
      if (!day) {
        const instant = new Date(text);
        if (Number.isNaN(instant.valueOf())) throw new CellParseError('datetime', text);
        return instant.toISOString();
      }
      const time = match ? `${pad(Number(match[2]))}:${match[3]}` : '00:00';
      return zonedInstant(day, time, ctx.timeZone);
    }
    case 'single_select': {
      const option = findOption(field, text);
      if (!option) throw new CellParseError('option', text);
      return option;
    }
    case 'multi_select': {
      const ids = splitList(text).map((part) => {
        const option = findOption(field, part);
        if (!option) throw new CellParseError('option', part);
        return option;
      });
      return [...new Set(ids)];
    }
    case 'member': {
      const ids = splitList(text).map((part) => {
        const id = ctx.findMember?.(part);
        if (!id) throw new CellParseError('member', part);
        return id;
      });
      const unique = [...new Set(ids)];
      return field.config.multiple ? unique : unique.slice(0, 1);
    }
    case 'relation':
    case 'parent':
    case 'dependency': {
      const table = linkTarget(field);
      const ids = splitList(text).map((part) => {
        const id = ctx.findRecord?.(table, part);
        if (!id) throw new CellParseError('record', part);
        return id;
      });
      const unique = [...new Set(ids)];
      return field.type === 'parent' || (field.type === 'relation' && !field.config.multiple)
        ? unique.slice(0, 1)
        : unique;
    }
    case 'attachment':
    case 'formula':
    case 'lookup':
    case 'rollup':
    case 'ai':
      throw new CellParseError('unsupported', text);
  }
}

function findOption(field: Field, text: string): string | undefined {
  const wanted = text.toLowerCase();
  return field.config.options?.find((option) => option.label.toLowerCase() === wanted || option.id === text)?.id;
}

/** A cell of CSV: text, or a number as formatted (written as it is). */
export type CsvCell = string | { number: string };

/**
 * Text a spreadsheet would run as a formula (it starts with =, +, -, @, a tab or a return) is
 * kept as text with a ' in front; numbers are left as they are.
 */
export const safeCsvText = (text: string) => (/^[=+\-@\t\r]/.test(text) ? `'${text}` : text);

/**
 * One line of CSV: text made safe to open in a spreadsheet (safeCsvText), then fields with a
 * comma, quote or line break are quoted and quotes doubled.
 */
export function csvLine(cells: readonly CsvCell[]): string {
  return cells
    .map((cell) => (typeof cell === 'string' ? safeCsvText(cell) : cell.number))
    .map((cell) => (/[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell))
    .join(',');
}

/** Rows of tab-separated text (a spreadsheet's copy): quoted cells may hold tabs and line breaks. */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const source = text.replace(/\r\n?/g, '\n');
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === '\t') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += char;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** Rows as tab-separated text for the clipboard, quoting cells with tabs, quotes or line breaks. */
export function toClipboard(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((cell) => (/[\t"\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join('\t'))
    .join('\n');
}

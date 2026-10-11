/**
 * An uploaded spreadsheet → a header row and rows of cell text (Tables import).
 *
 * - CSV / TSV: `@greenhouse/utils/csv` (encoding detection incl. GB18030,
 *   delimiter sniffing, our own export's formula guard removed).
 * - .xlsx: exceljs, first worksheet with data, every cell flattened by
 *   `cellToImportValue`. A .xlsx is a zip, so before exceljs inflates anything
 *   the entries are inflated once more here as a stream, counting real output
 *   bytes: a small upload cannot expand past `XLSX_MAX_UNCOMPRESSED_BYTES`
 *   (the sizes a zip declares are not trusted).
 *
 * Every refusal is an `ImportFileError` whose message is safe to show.
 */

import { Inflate } from 'fflate';
import type { CellValue, Workbook as ExcelWorkbook } from 'exceljs';
import { TABLE_IMPORT_MAX_COLUMNS, TABLE_IMPORT_MAX_ROWS } from '@greenhouse/db';
import { decodeCsvBytes, parseCsv } from '@greenhouse/utils/csv';
import { resolveWorkbookCtor } from '../../files/extract-text.js';

/** Upload ceiling for one import file. */
export const IMPORT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** What every entry of a .xlsx may inflate to, in total. */
export const XLSX_MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;
const XLSX_MAX_ENTRIES = 2_000;
/** Compressed bytes per inflate push: bounds the transient buffer (deflate expands ≤ ~1032×). */
const INFLATE_SLICE = 16 * 1024;

export type ImportFileKind = 'csv' | 'xlsx';

export class ImportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFileError';
  }
}

export interface ParsedImportFile {
  kind: ImportFileKind;
  header: string[];
  rows: string[][];
}

export function importFileKind(name: string, contentType = ''): ImportFileKind | null {
  if (/\.xlsx$/i.test(name) || contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return 'xlsx';
  }
  if (/\.(csv|tsv|txt)$/i.test(name) || /^text\/(csv|tab-separated-values|plain)$/.test(contentType)) return 'csv';
  return null;
}

// ─── Zip guard ────────────────────────────────────────────

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0;
}

const NOT_A_WORKBOOK = 'This file is not a readable .xlsx workbook';
const TOO_LARGE = 'This workbook expands to more data than an import accepts';
const TOO_WIDE = `The file has more than ${TABLE_IMPORT_MAX_COLUMNS} columns`;

/**
 * Inflate every entry the central directory lists (what exceljs will read),
 * streaming, and refuse the file once the real output passes the ceiling.
 * ZIP64 archives are refused outright: no workbook under 10 MB needs them.
 */
export function assertXlsxWithinLimits(bytes: Uint8Array, maxBytes = XLSX_MAX_UNCOMPRESSED_BYTES): void {
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65_557); at -= 1) {
    if (u32(bytes, at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ImportFileError(NOT_A_WORKBOOK);
  const count = u16(bytes, end + 10);
  let offset = u32(bytes, end + 16);
  if (count === 0xffff || offset === 0xffffffff) throw new ImportFileError(TOO_LARGE);
  if (count > XLSX_MAX_ENTRIES) throw new ImportFileError(TOO_LARGE);

  let total = 0;
  const spend = (length: number) => {
    total += length;
    if (total > maxBytes) throw new ImportFileError(TOO_LARGE);
  };
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > bytes.length || u32(bytes, offset) !== 0x02014b50) throw new ImportFileError(NOT_A_WORKBOOK);
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw new ImportFileError(TOO_LARGE);
    offset += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) {
      throw new ImportFileError(NOT_A_WORKBOOK);
    }
    const dataStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) throw new ImportFileError(NOT_A_WORKBOOK);
    if (method === 0) {
      spend(compressedSize);
      continue;
    }
    if (method !== 8) throw new ImportFileError(NOT_A_WORKBOOK);
    const inflater = new Inflate((chunk) => spend(chunk.length));
    try {
      for (let at = dataStart; at < dataEnd; at += INFLATE_SLICE) {
        const sliceEnd = Math.min(at + INFLATE_SLICE, dataEnd);
        inflater.push(bytes.subarray(at, sliceEnd), sliceEnd === dataEnd);
      }
      if (compressedSize === 0) inflater.push(new Uint8Array(0), true);
    } catch (error) {
      if (error instanceof ImportFileError) throw error;
      throw new ImportFileError(NOT_A_WORKBOOK);
    }
  }
}

// ─── Cells ────────────────────────────────────────────────

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0');
}

/**
 * Excel stores wall-clock values and exceljs hands them over as UTC Dates, so
 * the UTC fields are the time as written: a whole day → `YYYY-MM-DD`, anything
 * else → `YYYY-MM-DD HH:mm[:ss]` without a zone (the importer's zone applies).
 */
function excelDateText(date: Date): string {
  if (Number.isNaN(date.valueOf())) return '';
  const day = `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = date.getUTCSeconds();
  if (hours === 0 && minutes === 0 && seconds === 0) return day;
  return `${day} ${pad(hours)}:${pad(minutes)}${seconds ? `:${pad(seconds)}` : ''}`;
}

/**
 * One exceljs cell value → its text: rich text joined, a hyperlink's text (or
 * its address when the text is empty), a formula's cached result, dates as
 * above, errors (`#N/A`, `#DIV/0!` …) as empty.
 */
export function cellToImportValue(value: CellValue | unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (value instanceof Date) return excelDateText(value);
  if (typeof value !== 'object') return '';
  const cell = value as Record<string, unknown>;
  if (Array.isArray(cell.richText)) {
    return (cell.richText as Array<{ text?: unknown }>)
      .map((run) => (typeof run.text === 'string' ? run.text : ''))
      .join('');
  }
  if ('error' in cell) return '';
  if ('hyperlink' in cell) {
    const text = cellToImportValue(cell.text);
    return text || (typeof cell.hyperlink === 'string' ? cell.hyperlink : '');
  }
  if ('formula' in cell || 'sharedFormula' in cell) return cellToImportValue(cell.result);
  if ('text' in cell) return cellToImportValue(cell.text);
  return '';
}

// ─── Files ────────────────────────────────────────────────

const NUL = String.fromCharCode(0);

function normalizeRows(rows: string[][]): Omit<ParsedImportFile, 'kind'> {
  const cleaned = rows
    .map((row) => row.map((cell) => (cell.includes(NUL) ? cell.replaceAll(NUL, '') : cell)))
    .filter((row) => row.some((cell) => cell.trim() !== ''));
  if (cleaned.length === 0) throw new ImportFileError('The file has no rows');
  if (cleaned.length - 1 > TABLE_IMPORT_MAX_ROWS) {
    throw new ImportFileError(`The file has more than ${TABLE_IMPORT_MAX_ROWS.toLocaleString('en-US')} rows`);
  }
  // Trailing empty columns (a stray delimiter, formatted but empty cells) do not count.
  let width = 0;
  for (const row of cleaned) {
    for (let column = row.length - 1; column >= width; column -= 1) {
      if (row[column]!.trim() !== '') {
        width = column + 1;
        break;
      }
    }
  }
  if (width > TABLE_IMPORT_MAX_COLUMNS) throw new ImportFileError(TOO_WIDE);
  const square = cleaned.map((row) => Array.from({ length: width }, (_, column) => row[column] ?? ''));
  const [header, ...data] = square;
  return { header: header!, rows: data };
}

async function readWorkbook(bytes: Uint8Array): Promise<string[][]> {
  assertXlsxWithinLimits(bytes);
  const Workbook = resolveWorkbookCtor(await import('exceljs'));
  const workbook: ExcelWorkbook = new Workbook();
  try {
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  } catch {
    throw new ImportFileError(NOT_A_WORKBOOK);
  }
  const sheet = workbook.worksheets.find((candidate) => candidate.actualRowCount > 0);
  if (!sheet) throw new ImportFileError('The workbook has no rows');
  if (sheet.actualRowCount > TABLE_IMPORT_MAX_ROWS + 1) {
    throw new ImportFileError(`The file has more than ${TABLE_IMPORT_MAX_ROWS.toLocaleString('en-US')} rows`);
  }
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // Only cells holding a value: a formatted-but-empty cell far to the right
    // must not cost a loop over every column before it.
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const text = cellToImportValue(cell.value);
      if (column > TABLE_IMPORT_MAX_COLUMNS) {
        if (text.trim() !== '') throw new ImportFileError(TOO_WIDE);
        return;
      }
      cells[column - 1] = text;
    });
    rows.push(Array.from(cells, (cell) => cell ?? ''));
  });
  return rows;
}

/** Bytes of an uploaded csv / tsv / xlsx → header + rows of text (≤ 10,000 rows × 100 columns). */
export async function parseImportFile(input: {
  name: string;
  contentType?: string;
  bytes: Uint8Array;
}): Promise<ParsedImportFile> {
  const kind = importFileKind(input.name, input.contentType);
  if (!kind) throw new ImportFileError('Import a .csv, .tsv or .xlsx file');
  if (input.bytes.length > IMPORT_FILE_MAX_BYTES) throw new ImportFileError('The file is larger than 10 MB');
  if (kind === 'xlsx') return { ...normalizeRows(await readWorkbook(input.bytes)), kind };
  const { text } = decodeCsvBytes(input.bytes);
  // The header plus 10,000 data rows; one more means the file is too long.
  const parsed = parseCsv(text, { maxRows: TABLE_IMPORT_MAX_ROWS + 1 });
  if (parsed.truncated) {
    throw new ImportFileError(`The file has more than ${TABLE_IMPORT_MAX_ROWS.toLocaleString('en-US')} rows`);
  }
  return { ...normalizeRows(parsed.rows), kind };
}

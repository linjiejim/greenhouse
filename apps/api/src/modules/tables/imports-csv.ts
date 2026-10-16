/**
 * Reading an uploaded CSV file (TBL-10): UTF-8 with or without a byte order mark, rows ending in
 * CRLF, LF or CR, cells quoted to hold commas, quotes ("") and line breaks. The reader walks the
 * text once without regular expressions and stops at the first cell, row or column past its
 * limits, so a hostile file costs no more than its own length. Like a spreadsheet it is lenient
 * where nothing is lost (a quote inside an unquoted cell is text, text after a closing quote
 * joins the cell) and strict where something would be (a quote that never closes).
 */

import {
  IMPORT_SAMPLES,
  LONG_TEXT_MAX,
  MAX_IMPORT_COLUMNS,
  MAX_IMPORT_ROWS,
  type ImportFileError,
} from '@greenhouse/contract';

/** Why a file cannot be read; `row` is the row of the file it happened in. */
export class CsvError extends Error {
  constructor(
    readonly code: Exclude<ImportFileError, 'too_large'>,
    readonly row?: number,
  ) {
    super(row ? `${code} (row ${row})` : code);
    this.name = 'CsvError';
  }
}

export interface CsvLimits {
  /** Characters in one cell: what a long text field holds. */
  cell: number;
  /** Characters in one row, quotes and commas included. */
  row: number;
  /** Cells in one row; empty ones past it are dropped. */
  columns: number;
  /** Rows that are not blank, the first included (scanCsv). */
  rows: number;
}

export const CSV_LIMITS: CsvLimits = {
  cell: LONG_TEXT_MAX,
  row: 1_000_000,
  columns: MAX_IMPORT_COLUMNS,
  rows: MAX_IMPORT_ROWS + 1,
};

/** Characters of a header or a sample value kept to show. */
const SHOWN = 100;
/** Rows below the first that sample values come from. */
const SAMPLE_ROWS = 20;

const QUOTE = 0x22;
const COMMA = 0x2c;
const CR = 0x0d;
const LF = 0x0a;

/** The text of an uploaded file; a binary file, or text in another encoding than UTF-8, is refused. */
export function decodeCsv(bytes: Uint8Array): string {
  if (!bytes.byteLength) throw new CsvError('empty_file');
  // UTF-16, as spreadsheets save "Unicode text".
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    throw new CsvError('not_utf8');
  }
  // Text never holds a NUL byte; workbooks, images and archives do.
  if (bytes.includes(0)) throw new CsvError('not_csv');
  try {
    // Fatal: GBK or Latin-1 bytes refuse the file instead of turning into replacement characters.
    // The byte order mark, when there is one, is dropped.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvError('not_utf8');
  }
}

/** Where unquoted text from `from` ends: at the next comma, line break or the end. */
function unquotedEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length) {
    const code = text.charCodeAt(at);
    if (code === COMMA || code === CR || code === LF) break;
    at++;
  }
  return at;
}

/** Line breaks inside a quoted cell are kept as LF, whichever the file used. */
const lineFeeds = (cell: string) => (cell.includes('\r') ? cell.split('\r\n').join('\n').split('\r').join('\n') : cell);

export interface CsvRow {
  /** The row in the file, counting every row from 1 (blank ones too), as a spreadsheet numbers them. */
  number: number;
  cells: string[];
}

/** The rows of a CSV text in order, without the blank ones (every cell empty or spaces). */
export function* readCsv(text: string, limits: CsvLimits = CSV_LIMITS): Generator<CsvRow> {
  let at = 0;
  let number = 0;
  while (at < text.length) {
    number++;
    const start = at;
    const cells: string[] = [];
    let blank = true;
    for (;;) {
      let cell: string;
      if (text.charCodeAt(at) === QUOTE) {
        cell = '';
        let from = at + 1;
        for (;;) {
          const close = text.indexOf('"', from);
          if (close < 0) throw new CsvError('unclosed_quote', number);
          if (cell.length + close - from > limits.cell) throw new CsvError('cell_too_long', number);
          cell += text.slice(from, close);
          // A doubled quote is a quote in the text; a single one closes the cell.
          if (text.charCodeAt(close + 1) !== QUOTE) {
            at = close + 1;
            break;
          }
          cell += '"';
          from = close + 2;
        }
        // Text between the closing quote and the comma joins the cell, as spreadsheets read it.
        const end = unquotedEnd(text, at);
        cell = lineFeeds(cell + text.slice(at, end));
        at = end;
      } else {
        const end = unquotedEnd(text, at);
        cell = text.slice(at, end);
        at = end;
      }
      if (cell.length > limits.cell) throw new CsvError('cell_too_long', number);
      if (at - start > limits.row) throw new CsvError('row_too_long', number);
      const filled = cell.trim() !== '';
      if (filled) blank = false;
      if (cells.length < limits.columns) cells.push(cell);
      else if (filled) throw new CsvError('too_many_columns', number);
      const code = text.charCodeAt(at);
      if (code === COMMA) {
        at++;
        continue;
      }
      if (code === CR) at += text.charCodeAt(at + 1) === LF ? 2 : 1;
      else if (code === LF) at++;
      break;
    }
    if (!blank) yield { number, cells };
  }
}

/**
 * A cell as it was before the export kept it from running as a formula: the CSV export writes
 * text starting with =, +, -, @ or a line break with a ' in front (safeCsvText in the contract).
 */
export function unguard(cell: string): string {
  if (cell.length < 2 || cell[0] !== "'") return cell;
  return '=+-@\t\r\n'.includes(cell[1]!) ? cell.slice(1) : cell;
}

/** The rows to import, in order: those that are not blank, without the first when it is the header. */
export function* dataRows(text: string, header: boolean): Generator<CsvRow> {
  let skip = header;
  for (const row of readCsv(text)) {
    if (skip) {
      skip = false;
      continue;
    }
    yield { number: row.number, cells: row.cells.map(unguard) };
  }
}

export interface CsvSummary {
  /** The first row's cells, one per column, trimmed and cut short. */
  first: string[];
  /** Per column, a few values from the rows below the first, trimmed and cut short. */
  samples: string[][];
  /** Rows that are not blank, the first included. */
  rows: number;
}

/** A header or sample as shown: unguarded, trimmed and cut short. */
const shown = (cell: string) => {
  const text = unguard(cell).trim();
  return text.length > SHOWN ? `${text.slice(0, SHOWN)}…` : text;
};

/**
 * What the upload keeps of a file: its first row, sample values and how many rows it has. The
 * columns are as many as the widest row has cells, up to its last that is not empty.
 */
export function scanCsv(text: string, limits: CsvLimits = CSV_LIMITS): CsvSummary {
  let first: string[] | null = null;
  const below: string[][] = [];
  let rows = 0;
  let width = 0;
  for (const row of readCsv(text, limits)) {
    rows++;
    if (rows > limits.rows) throw new CsvError('too_many_rows', row.number);
    for (let index = row.cells.length - 1; index >= width; index--) {
      if (row.cells[index]!.trim()) {
        width = index + 1;
        break;
      }
    }
    if (!first) first = row.cells;
    else if (below.length < SAMPLE_ROWS) below.push(row.cells);
  }
  if (!first) throw new CsvError('empty_file');
  const head = first;
  const columns = Array.from({ length: width }, (_, index) => index);
  return {
    first: columns.map((index) => shown(head[index] ?? '')),
    samples: columns.map((index) =>
      below
        .map((cells) => shown(cells[index] ?? ''))
        .filter(Boolean)
        .slice(0, IMPORT_SAMPLES),
    ),
    rows,
  };
}

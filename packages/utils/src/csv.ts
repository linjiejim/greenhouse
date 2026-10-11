/**
 * Reading CSV / TSV — RFC 4180 plus the shapes real spreadsheet exports take.
 *
 * One reader for every place that takes a delimited file (Tables import first).
 * Deliberately a small hand-written state machine rather than a dependency:
 * exceljs' CSV reader coerces cells (`00123` → 123) and drags in fast-csv, and
 * an import must hand the caller exactly the text that was in the cell.
 *
 * What it handles:
 * - quoted fields, `""` escapes, delimiters and line breaks inside quotes;
 * - CRLF, LF and lone CR line endings (old Mac Excel);
 * - `,` `;` and tab delimiters, sniffed from the first records (Excel in many
 *   European locales writes `;`), and Excel's `sep=;` first line;
 * - bytes in UTF-8 (BOM or not), UTF-16 (BOM or the NUL pattern), and — when
 *   the bytes are not valid UTF-8 — GB18030, which is what a Chinese Excel
 *   "Save as CSV" produces (a superset of GBK / GB2312);
 * - NUL characters are dropped (PostgreSQL jsonb cannot store `\u0000`);
 * - the `'` our own exports put before a cell starting with `= + - @` (formula
 *   neutralization, see `safeCsvCell`) is removed again, so an export round-trips.
 *
 * Lenient where spreadsheets are sloppy: a quote inside an unquoted field is a
 * literal character, text after a closing quote is kept, and an unterminated
 * quote runs to the end of the input instead of failing the whole file.
 */

export type CsvDelimiter = ',' | ';' | '\t';
export const CSV_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t'];

export type CsvEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030';

export interface DecodedCsvText {
  text: string;
  encoding: CsvEncoding;
}

export interface CsvParseOptions {
  /** Skip sniffing and split on this delimiter. */
  delimiter?: CsvDelimiter;
  /** Stop after this many rows; `truncated` reports whether more followed. */
  maxRows?: number;
  /** Drop rows whose every cell is empty (blank lines). Default true. */
  skipEmptyRows?: boolean;
  /** Remove the `'` our exports add before `= + - @`. Default true. */
  unguardFormulas?: boolean;
}

export interface CsvParseResult {
  rows: string[][];
  delimiter: CsvDelimiter;
  /** True when `maxRows` cut the file short. */
  truncated: boolean;
}

const NUL = String.fromCharCode(0);

function stripNul(text: string): string {
  return text.includes(NUL) ? text.replaceAll(NUL, '') : text;
}

/**
 * BOM-less UTF-16: text in the Latin range stored as UTF-16 has a NUL in every
 * other byte. Returns the byte order, or null for anything that is not that.
 */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const sample = bytes.subarray(0, 512);
  if (sample.length < 4) return null;
  let even = 0;
  let odd = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) even += 1;
    else odd += 1;
  }
  const half = sample.length / 2;
  if (odd / half >= 0.4 && even / half < 0.1) return 'utf-16le';
  if (even / half >= 0.4 && odd / half < 0.1) return 'utf-16be';
  return null;
}

/**
 * Bytes → text. A BOM wins; otherwise strict UTF-8, falling back to GB18030
 * when the bytes are not valid UTF-8 (they cannot be both in practice: GBK's
 * two-byte sequences are almost never well-formed UTF-8). The BOM and NUL
 * characters never reach the caller.
 */
export function decodeCsvBytes(bytes: Uint8Array): DecodedCsvText {
  let encoding: CsvEncoding;
  let body = bytes;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8';
    body = bytes.subarray(3);
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    body = bytes.subarray(2);
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    body = bytes.subarray(2);
  } else {
    encoding = sniffUtf16(bytes) ?? 'utf-8';
  }

  let text: string;
  if (encoding === 'utf-8') {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      encoding = 'gb18030';
      text = new TextDecoder('gb18030').decode(body);
    }
  } else {
    text = new TextDecoder(encoding).decode(body);
  }
  return { text: stripNul(text.replace(/^\uFEFF/, '')), encoding };
}

/** `'=SUM(A1)` → `=SUM(A1)`: undo the formula guard our CSV exports add. Other `'` stay. */
export function unguardCsvCell(value: string): string {
  return value.length > 1 && value[0] === "'" && /^[=+\-@]/.test(value.slice(1)) ? value.slice(1) : value;
}

interface ReadState {
  rows: string[][];
  truncated: boolean;
}

/**
 * The state machine. Calls `onRow` for each record and stops early when it
 * returns false (the sniffer and `maxRows` use that).
 */
function readRecords(text: string, delimiter: string, onRow: (row: string[]) => boolean): void {
  let row: string[] = [];
  let field = '';
  let quoted = false;
  /** Inside a quoted section of the current field. */
  let inQuotes = false;
  let index = 0;
  const length = text.length;

  const endField = () => {
    row.push(field);
    field = '';
    quoted = false;
  };
  const endRow = (): boolean => {
    endField();
    const keepGoing = onRow(row);
    row = [];
    return keepGoing;
  };

  while (index < length) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      // Keep line breaks inside quotes, normalized to \n.
      if (char === '\r') {
        field += '\n';
        index += text[index + 1] === '\n' ? 2 : 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"' && field === '' && !quoted) {
      quoted = true;
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === delimiter) {
      endField();
      index += 1;
      continue;
    }
    if (char === '\n' || char === '\r') {
      index += char === '\r' && text[index + 1] === '\n' ? 2 : 1;
      if (!endRow()) return;
      continue;
    }
    // A quote that does not open the field is a literal (`5" screen`), and text
    // after a closing quote is kept (`"abc"def` → `abcdef`).
    field += char;
    index += 1;
  }
  // The last record, unless the input ended with a line break.
  if (field !== '' || row.length > 0 || quoted) endRow();
}

function isEmptyRow(row: string[]): boolean {
  return row.every((cell) => cell === '');
}

/**
 * Pick the delimiter that splits the first records most consistently into more
 * than one column. Ties go to the earlier candidate (`,` before `;` before tab).
 */
export function sniffCsvDelimiter(text: string, candidates: readonly CsvDelimiter[] = CSV_DELIMITERS): CsvDelimiter {
  const sample = text.slice(0, 64 * 1024);
  let best: { delimiter: CsvDelimiter; score: number } | null = null;
  for (const delimiter of candidates) {
    const counts: number[] = [];
    readRecords(sample, delimiter, (row) => {
      if (!isEmptyRow(row)) counts.push(row.length);
      return counts.length < 20;
    });
    if (counts.length === 0) continue;
    // The modal column count and how many records share it.
    const frequency = new Map<number, number>();
    for (const count of counts) frequency.set(count, (frequency.get(count) ?? 0) + 1);
    const [mode, hits] = [...frequency].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]!;
    if (mode < 2) continue;
    const score = (hits / counts.length) * 1000 + mode;
    if (!best || score > best.score) best = { delimiter, score };
  }
  return best?.delimiter ?? candidates[0] ?? ',';
}

/** Parse delimited text into rows of cells. Cells are never trimmed or coerced. */
export function parseCsv(input: string, options: CsvParseOptions = {}): CsvParseResult {
  let text = stripNul(input.replace(/^\uFEFF/, ''));
  let delimiter = options.delimiter;
  // Excel's explicit hint, written as the first line of some exports.
  const hint = /^sep=([,;\t])\r?\n/i.exec(text);
  if (hint) {
    delimiter ??= hint[1] as CsvDelimiter;
    text = text.slice(hint[0].length);
  }
  delimiter ??= sniffCsvDelimiter(text);

  const skipEmpty = options.skipEmptyRows !== false;
  const unguard = options.unguardFormulas !== false;
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY;
  const state: ReadState = { rows: [], truncated: false };
  readRecords(text, delimiter, (row) => {
    if (skipEmpty && isEmptyRow(row)) return true;
    if (state.rows.length >= maxRows) {
      state.truncated = true;
      return false;
    }
    state.rows.push(unguard ? row.map(unguardCsvCell) : row);
    return true;
  });
  return { rows: state.rows, delimiter, truncated: state.truncated };
}

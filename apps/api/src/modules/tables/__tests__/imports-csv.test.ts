import { describe, expect, it } from 'vitest';
import { csvLine } from '@greenhouse/contract';
import {
  CSV_LIMITS,
  CsvError,
  dataRows,
  decodeCsv,
  readCsv,
  scanCsv,
  unguard,
  type CsvLimits,
} from '../imports-csv.js';

const rows = (text: string, limits?: CsvLimits) => [...readCsv(text, limits)];
const cells = (text: string, limits?: CsvLimits) => rows(text, limits).map((row) => row.cells);
const bytes = (text: string) => new TextEncoder().encode(text);

/** The problem a reading stops at, and the row it names. */
function problem(read: () => unknown) {
  try {
    read();
  } catch (error) {
    if (error instanceof CsvError) return { code: error.code, row: error.row };
    throw error;
  }
  return null;
}

describe('decodeCsv', () => {
  it('reads UTF-8 with or without a byte order mark', () => {
    expect(decodeCsv(bytes('名称,数量\n苹果,3'))).toBe('名称,数量\n苹果,3');
    expect(decodeCsv(new Uint8Array([0xef, 0xbb, 0xbf, ...bytes('名称\n')]))).toBe('名称\n');
  });

  it('refuses other encodings, binary files and empty ones', () => {
    // 「名称」 in GBK, as Excel saves a plain CSV on a Chinese Windows.
    expect(problem(() => decodeCsv(new Uint8Array([0xc3, 0xfb, 0xb3, 0xc6, 0x0a])))).toEqual({
      code: 'not_utf8',
      row: undefined,
    });
    expect(problem(() => decodeCsv(new Uint8Array([0xff, 0xfe, 0x41, 0x00])))?.code).toBe('not_utf8');
    // A workbook is a ZIP: its headers hold NUL bytes.
    expect(problem(() => decodeCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00])))?.code).toBe(
      'not_csv',
    );
    expect(problem(() => decodeCsv(new Uint8Array())))?.toEqual({ code: 'empty_file', row: undefined });
  });
});

describe('readCsv', () => {
  it('splits rows on CRLF, LF or CR, and cells on commas', () => {
    expect(cells('a,b\r\nc,d\ne,f\rg,h')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
      ['g', 'h'],
    ]);
    expect(cells('a,b\r\n')).toEqual([['a', 'b']]);
  });

  it('reads quoted cells holding commas, quotes and line breaks', () => {
    expect(cells('"a,b","say ""hi""","one\r\ntwo",plain\n"x\ny",z')).toEqual([
      ['a,b', 'say "hi"', 'one\ntwo', 'plain'],
      ['x\ny', 'z'],
    ]);
    // An empty quoted cell, and a quoted cell at the end of the file.
    expect(cells('"",b,"c"')).toEqual([['', 'b', 'c']]);
  });

  it('is lenient like a spreadsheet where nothing is lost', () => {
    // A quote inside an unquoted cell is text; text after a closing quote joins the cell.
    expect(cells('5" screen,"ab"cd,e')).toEqual([['5" screen', 'abcd', 'e']]);
    // A trailing comma is one more (empty) cell; spaces stay.
    expect(cells(' a , b ,')).toEqual([[' a ', ' b ', '']]);
  });

  it('skips blank rows but numbers rows as a spreadsheet does', () => {
    const read = rows('name\n\n , \napple\n"multi\nline",x\npear\n');
    expect(read.map((row) => [row.number, row.cells[0]])).toEqual([
      [1, 'name'],
      [4, 'apple'],
      [5, 'multi\nline'],
      [6, 'pear'],
    ]);
  });

  it('stops at a quote that never closes, naming its row', () => {
    expect(problem(() => cells('a,b\nc,"never closed\nd,e'))).toEqual({ code: 'unclosed_quote', row: 2 });
    expect(problem(() => cells('"ends with a quote""'))).toEqual({ code: 'unclosed_quote', row: 1 });
  });

  it('stops at a cell, row or column past its limits', () => {
    const small: CsvLimits = { cell: 5, row: 12, columns: 3, rows: 10 };
    expect(cells('12345,ab', small)).toEqual([['12345', 'ab']]);
    expect(problem(() => cells('ok\n123456', small))).toEqual({ code: 'cell_too_long', row: 2 });
    expect(problem(() => cells('"12""345"', small))).toEqual({ code: 'cell_too_long', row: 1 });
    expect(problem(() => cells('1234,1234,1234', small))).toEqual({ code: 'row_too_long', row: 1 });
    expect(problem(() => cells('a,b,c,d', small))).toEqual({ code: 'too_many_columns', row: 1 });
    // Empty cells past the last column are dropped, as spreadsheets write them.
    expect(cells('a,b,c,,,', small)).toEqual([['a', 'b', 'c']]);
  });

  it('reads back what the CSV export writes, formula guard and all', () => {
    const written = [
      ['名称', 'Notes', 'Phone'],
      ['A, with comma', 'He said "yes"', '+86 138 0000 0000'],
      ['Two\nlines', '=SUM(A1:A3)', '-2.5'],
    ];
    const file = `\uFEFF${written.map(csvLine).join('\r\n')}\r\n`;
    expect(file).toContain(`'=SUM`);
    expect([...dataRows(decodeCsv(bytes(file)), false)].map((row) => row.cells)).toEqual(written);
  });

  it('drops only the guard the export adds', () => {
    expect(unguard(`'=1+1`)).toBe('=1+1');
    expect(unguard(`'-5`)).toBe('-5');
    expect(unguard(`'tis`)).toBe(`'tis`);
    expect(unguard(`'`)).toBe(`'`);
    expect(scanCsv(`'@name\n'+1`)).toMatchObject({ first: ['@name'], samples: [['+1']] });
  });

  it('takes time in proportion to the file, whatever it holds', () => {
    const hostile = [
      `"${'""'.repeat(200_000)}`, // doubled quotes that never close
      ','.repeat(2_000_000), // one row of empty cells
      `"${'a'.repeat(50_000)}"${'b'.repeat(50_000)}\n`.repeat(20), // text after closing quotes
      '\n'.repeat(1_000_000), // blank rows
      'x\r'.repeat(1_000_000), // lone CRs
    ];
    for (const text of hostile) {
      const started = performance.now();
      problem(() => {
        for (const row of readCsv(text, { ...CSV_LIMITS, columns: 50 })) void row;
      });
      expect(performance.now() - started).toBeLessThan(2_000);
    }
  });
});

describe('scanCsv and dataRows', () => {
  it('keeps the first row, a few sample values per column and the number of rows', () => {
    const text = 'Name, Count ,,\nApple,3\n,4\nPear,,x\nPlum,5\n\nFig,6\n';
    expect(scanCsv(text)).toEqual({
      first: ['Name', 'Count', ''],
      samples: [['Apple', 'Pear', 'Plum'], ['3', '4', '5'], ['x']],
      rows: 6,
    });
  });

  it('cuts long headers and samples short', () => {
    const long = 'h'.repeat(150);
    const summary = scanCsv(`${long}\n${'v'.repeat(120)}`);
    expect(summary.first[0]).toBe(`${'h'.repeat(100)}…`);
    expect(summary.samples[0]![0]).toBe(`${'v'.repeat(100)}…`);
  });

  it('refuses an empty file and one with too many rows', () => {
    expect(problem(() => scanCsv('\n \n,,\n'))).toEqual({ code: 'empty_file', row: undefined });
    expect(problem(() => scanCsv('h\n1\n2\n3', { ...CSV_LIMITS, rows: 3 }))).toEqual({
      code: 'too_many_rows',
      row: 4,
    });
  });

  it('gives the rows to import, without the first when it is the header', () => {
    const text = 'name\n\napple\npear';
    expect([...dataRows(text, true)].map((row) => [row.number, row.cells[0]])).toEqual([
      [3, 'apple'],
      [4, 'pear'],
    ]);
    expect([...dataRows(text, false)].map((row) => row.cells[0])).toEqual(['name', 'apple', 'pear']);
  });
});

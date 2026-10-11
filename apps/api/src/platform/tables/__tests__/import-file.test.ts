/**
 * Import file parsing: a generated .xlsx (rich text, hyperlinks, formulas,
 * errors, dates, empty rows), the decompressed-size guard against zip bombs
 * (including one that lies about its sizes), and CSV in GBK / with our own
 * export's formula guard.
 */

import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { zipSync } from 'fflate';
import {
  assertXlsxWithinLimits,
  cellToImportValue,
  ImportFileError,
  importFileKind,
  parseImportFile,
} from '../import-file.js';

async function workbookBytes(build: (sheet: ExcelJS.Worksheet) => void, options: { emptyFirst?: boolean } = {}) {
  const workbook = new ExcelJS.Workbook();
  if (options.emptyFirst) workbook.addWorksheet('Empty');
  build(workbook.addWorksheet('Data'));
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

/** Patch every central-directory "uncompressed size" of a zip to `size` (a lying archive). */
function lieAboutSizes(bytes: Uint8Array, size: number): Uint8Array {
  const out = Uint8Array.from(bytes);
  const view = new DataView(out.buffer);
  for (let at = 0; at + 46 <= out.length; at += 1) {
    if (view.getUint32(at, true) === 0x02014b50) view.setUint32(at + 24, size, true);
    if (view.getUint32(at, true) === 0x04034b50) view.setUint32(at + 22, size, true);
  }
  return out;
}

describe('cellToImportValue', () => {
  it('flattens every exceljs cell shape to text', () => {
    expect(cellToImportValue(null)).toBe('');
    expect(cellToImportValue(42.5)).toBe('42.5');
    expect(cellToImportValue(true)).toBe('true');
    expect(cellToImportValue({ richText: [{ text: 'Bold ' }, { text: 'plain' }] })).toBe('Bold plain');
    expect(cellToImportValue({ text: 'Docs', hyperlink: 'https://example.com' })).toBe('Docs');
    expect(cellToImportValue({ text: '', hyperlink: 'https://example.com' })).toBe('https://example.com');
    expect(cellToImportValue({ text: { richText: [{ text: 'Rich link' }] }, hyperlink: 'https://x.example' })).toBe(
      'Rich link',
    );
    expect(cellToImportValue({ formula: 'A1*2', result: 85 })).toBe('85');
    expect(cellToImportValue({ sharedFormula: 'B2', result: 'ok' })).toBe('ok');
    expect(cellToImportValue({ formula: '1/0', result: { error: '#DIV/0!' } })).toBe('');
    expect(cellToImportValue({ error: '#N/A' })).toBe('');
    expect(cellToImportValue(new Date(Date.UTC(2024, 2, 5)))).toBe('2024-03-05');
    expect(cellToImportValue(new Date(Date.UTC(2024, 2, 5, 14, 30)))).toBe('2024-03-05 14:30');
    expect(cellToImportValue(new Date(Date.UTC(2024, 2, 5, 14, 30, 15)))).toBe('2024-03-05 14:30:15');
    expect(cellToImportValue({ formula: 'TODAY()', result: new Date(Date.UTC(2024, 0, 1)) })).toBe('2024-01-01');
  });
});

describe('parseImportFile — xlsx', () => {
  it('reads the first worksheet with data, column positions intact', async () => {
    const bytes = await workbookBytes(
      (sheet) => {
        sheet.addRow(['Name', 'Amount', 'Due', 'Link', 'Doubled', 'Broken']);
        sheet.addRow([
          { richText: [{ text: 'Ac', font: { bold: true } }, { text: 'me' }] },
          1234.5,
          new Date(Date.UTC(2024, 2, 5)),
          { text: 'Site', hyperlink: 'https://acme.example' },
          { formula: 'B2*2', result: 2469 },
          { error: '#N/A' },
        ]);
        sheet.addRow([]);
        const row = sheet.getRow(4);
        row.getCell(1).value = 'Globex';
        row.getCell(3).value = new Date(Date.UTC(2024, 2, 6, 9, 15));
        row.commit();
      },
      { emptyFirst: true },
    );
    const parsed = await parseImportFile({ name: 'deals.xlsx', bytes });
    expect(parsed).toEqual({
      kind: 'xlsx',
      header: ['Name', 'Amount', 'Due', 'Link', 'Doubled', 'Broken'],
      rows: [
        ['Acme', '1234.5', '2024-03-05', 'Site', '2469', ''],
        ['Globex', '', '2024-03-06 09:15', '', '', ''],
      ],
    });
  });

  // Builds a 10,002-row workbook: slow on a loaded machine.
  it('refuses files that are not workbooks, too wide or too long', { timeout: 60_000 }, async () => {
    await expect(parseImportFile({ name: 'x.xlsx', bytes: new TextEncoder().encode('not a zip') })).rejects.toThrow(
      ImportFileError,
    );
    const wide = await workbookBytes((sheet) => {
      sheet.addRow(Array.from({ length: 101 }, (_, index) => `c${index}`));
    });
    await expect(parseImportFile({ name: 'wide.xlsx', bytes: wide })).rejects.toThrow(/more than 100 columns/);
    const long = await workbookBytes((sheet) => {
      for (let index = 0; index < 10_002; index += 1) sheet.addRow([`r${index}`]);
    });
    await expect(parseImportFile({ name: 'long.xlsx', bytes: long })).rejects.toThrow(/more than 10,000 rows/);
  });
});

describe('assertXlsxWithinLimits', () => {
  it('measures real inflated bytes, not the sizes the zip declares', () => {
    const bomb = zipSync({ 'xl/worksheets/sheet1.xml': new Uint8Array(4 * 1024 * 1024) }, { level: 9 });
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect(() => assertXlsxWithinLimits(bomb, 1024 * 1024)).toThrow(/expands to more data/);
    // The same archive claiming its entry is tiny is still caught.
    expect(() => assertXlsxWithinLimits(lieAboutSizes(bomb, 10), 1024 * 1024)).toThrow(/expands to more data/);
    expect(() => assertXlsxWithinLimits(bomb, 8 * 1024 * 1024)).not.toThrow();
    expect(() => assertXlsxWithinLimits(new Uint8Array(100))).toThrow(/not a readable .xlsx/);
  });

  it('passes a real workbook', async () => {
    const bytes = await workbookBytes((sheet) => sheet.addRow(['a', 1]));
    expect(() => assertXlsxWithinLimits(bytes)).not.toThrow();
  });
});

describe('parseImportFile — csv', () => {
  it('decodes GBK, keeps text as written and removes our export guard', async () => {
    // 姓名,金额\n张三,"'=1+1"\n
    const bytes = Uint8Array.from([
      0xd0, 0xd5, 0xc3, 0xfb, 0x2c, 0xbd, 0xf0, 0xb6, 0xee, 0x0a, 0xd5, 0xc5, 0xc8, 0xfd, 0x2c, 0x22, 0x27, 0x3d, 0x31,
      0x2b, 0x31, 0x22, 0x0a,
    ]);
    expect(await parseImportFile({ name: 'people.csv', bytes })).toEqual({
      kind: 'csv',
      header: ['姓名', '金额'],
      rows: [['张三', '=1+1']],
    });
  });

  it('squares ragged rows, drops trailing empty columns and blank rows, strips NUL', async () => {
    const text = `a,b,,\n1${String.fromCharCode(0)}\n , \n2,3,,\n`;
    expect(await parseImportFile({ name: 'x.csv', bytes: new TextEncoder().encode(text) })).toEqual({
      kind: 'csv',
      header: ['a', 'b'],
      rows: [
        ['1', ''],
        ['2', '3'],
      ],
    });
  });

  it('enforces the row and size limits and the file kinds', async () => {
    const rows = ['h', ...Array.from({ length: 10_001 }, (_, index) => String(index))].join('\n');
    await expect(parseImportFile({ name: 'x.csv', bytes: new TextEncoder().encode(rows) })).rejects.toThrow(
      /more than 10,000 rows/,
    );
    await expect(parseImportFile({ name: 'x.csv', bytes: new Uint8Array(10 * 1024 * 1024 + 1) })).rejects.toThrow(
      /larger than 10 MB/,
    );
    await expect(parseImportFile({ name: 'x.pdf', bytes: new Uint8Array(1) })).rejects.toThrow(
      /\.csv, \.tsv or \.xlsx/,
    );
    expect(importFileKind('a.TSV')).toBe('csv');
    expect(importFileKind('upload', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('xlsx');
  });
});

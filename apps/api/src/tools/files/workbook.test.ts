import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildCsv, buildXlsx, validateSheets, LIMITS, type SheetSpec } from './workbook.js';

describe('buildCsv', () => {
  it('prepends a UTF-8 BOM so Excel reads non-ASCII correctly', () => {
    const buf = buildCsv({ name: 'S', columns: ['名称'], rows: [['值']] });
    expect([...buf.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(buf.subarray(3).toString('utf8')).toBe('名称\r\n值');
  });

  it('quotes cells containing commas, quotes, or newlines', () => {
    const buf = buildCsv({
      name: 'S',
      columns: ['a', 'b', 'c'],
      rows: [['x,y', 'he said "hi"', 'line1\nline2']],
    });
    const text = buf.subarray(3).toString('utf8');
    expect(text).toBe('a,b,c\r\n"x,y","he said ""hi""","line1\nline2"');
  });

  it('renders null/boolean/number cells predictably', () => {
    const buf = buildCsv({ name: 'S', columns: ['a', 'b', 'c'], rows: [[null, true, 42]] });
    expect(buf.subarray(3).toString('utf8')).toBe('a,b,c\r\n,true,42');
  });

  it('pads and truncates rows to the column count', () => {
    const buf = buildCsv({ name: 'S', columns: ['a', 'b', 'c'], rows: [['1'], ['1', '2', '3', '4']] });
    expect(buf.subarray(3).toString('utf8')).toBe('a,b,c\r\n1,,\r\n1,2,3');
  });
});

describe('buildXlsx', () => {
  it('produces a valid workbook with the given sheets, header, and data', async () => {
    const sheets: SheetSpec[] = [
      { name: 'Revenue', columns: ['Region', 'Total'], rows: [['APAC', 100]] },
      { name: 'Costs', columns: ['Item', 'Amount'], rows: [['Cloud', 50]] },
    ];
    const buf = await buildXlsx(sheets);
    expect([...buf.subarray(0, 2)]).toEqual([0x50, 0x4b]); // "PK" zip magic

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Revenue', 'Costs']);
    expect(wb.getWorksheet('Revenue')!.getRow(1).values).toEqual([undefined, 'Region', 'Total']);
    expect(wb.getWorksheet('Revenue')!.getRow(2).values).toEqual([undefined, 'APAC', 100]);
  });

  it('sanitizes and de-duplicates sheet names', async () => {
    const buf = await buildXlsx([
      { name: 'A/B:C', columns: ['x'], rows: [] },
      { name: 'A/B:C', columns: ['x'], rows: [] },
    ]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const [first, second] = wb.worksheets.map((w) => w.name);
    expect(first).toBe('A B C');
    expect(second).not.toBe(first);
  });
});

describe('validateSheets', () => {
  it('rejects an empty sheet set', () => {
    expect(() => validateSheets([])).toThrow(/at least one sheet/i);
  });

  it('rejects a sheet with no columns', () => {
    expect(() => validateSheets([{ name: 'S', columns: [], rows: [] }])).toThrow(/no columns/i);
  });

  it('enforces the row cap', () => {
    const rows = Array.from({ length: LIMITS.rows + 1 }, () => ['x']);
    expect(() => validateSheets([{ name: 'S', columns: ['a'], rows }])).toThrow(/rows/i);
  });

  it('accepts a well-formed sheet', () => {
    expect(() => validateSheets([{ name: 'S', columns: ['a', 'b'], rows: [['1', '2']] }])).not.toThrow();
  });
});

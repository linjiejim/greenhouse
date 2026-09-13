import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { buildTabularCsv, buildTabularXlsx, safeCsvCell, type TabularExportColumn } from './tabular-export.js';

const columns: TabularExportColumn[] = [
  { key: 'id', label: 'ID' },
  { key: 'customer_no', label: '客户编号' },
  { key: 'name', label: '客户名称' },
  { key: 'country', label: '国家' },
  { key: 'sales_amount', label: '累计销售额 (USD)' },
  { key: 'notes', label: '备注' },
];

const rows = [
  {
    id: 1,
    customer_no: 'CST00001',
    name: '深圳 "绿植", Inc.',
    country: '中国',
    sales_amount: 1234.5,
    notes: '=HYPERLINK("https://example.test")',
  },
  {
    id: 2,
    customer_no: 'CST00002',
    name: 'Second\nCustomer',
    country: null,
    sales_amount: 0,
    notes: '@SUM(1,2)',
  },
];

describe('generic tabular export files', () => {
  it('quotes CSV values, preserves CJK and neutralizes formulas', () => {
    const csv = buildTabularCsv(columns, rows).toString('utf8');
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"深圳 ""绿植"", Inc."');
    expect(csv).toContain('"Second\nCustomer"');
    expect(csv).toContain(`"'=HYPERLINK(""https://example.test"")"`);
    expect(safeCsvCell('-1+2')).toBe(`"'-1+2"`);
    expect(safeCsvCell(-1)).toBe('"-1"');
  });

  it('creates a readable XLSX with a frozen/filterable header and all rows', async () => {
    const buffer = await buildTabularXlsx(columns, rows, 'Customers');
    expect(buffer.subarray(0, 2).toString()).toBe('PK');

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.read(Readable.from(buffer));
    const sheet = workbook.getWorksheet('Customers');
    expect(sheet).toBeDefined();
    expect(sheet!.rowCount).toBe(3);
    expect(sheet!.getCell('A1').value).toBe('ID');
    expect(sheet!.getCell('C2').value).toBe('深圳 "绿植", Inc.');
    expect(sheet!.getCell('F2').value).toBe('=HYPERLINK("https://example.test")');
    expect(sheet!.autoFilter).toBeTruthy();
    expect(sheet!.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });
});

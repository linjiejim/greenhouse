/**
 * Deterministic CSV/XLSX generation for generic tabular datasets.
 *
 * Authorization and data loading stay with each source adapter. This module
 * receives only rows already approved for export and never queries a database.
 */

import ExcelJS from 'exceljs';

export type TabularExportFormat = 'csv' | 'xlsx';

export interface TabularExportColumn {
  key: string;
  label: string;
}

export interface GeneratedTabularExport {
  buffer: Buffer;
  contentType: string;
}

function displayValue(value: unknown): string | number | boolean {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  return JSON.stringify(value);
}

/** Neutralize spreadsheet formulas in text-based CSV imports. */
export function safeCsvCell(value: unknown): string {
  const displayed = displayValue(value);
  const raw = String(displayed);
  const neutralized = typeof displayed === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

export function buildTabularCsv(
  columns: readonly TabularExportColumn[],
  rows: ReadonlyArray<Record<string, unknown>>,
): Buffer {
  const lines = [
    columns.map((column) => safeCsvCell(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => safeCsvCell(row[column.key])).join(',')),
  ];
  return Buffer.from(`\uFEFF${lines.join('\r\n')}\r\n`, 'utf8');
}

function columnWidth(column: TabularExportColumn, rows: ReadonlyArray<Record<string, unknown>>): number {
  let width = column.label.length * 2;
  for (const row of rows.slice(0, 500)) {
    width = Math.max(width, String(displayValue(row[column.key])).length);
  }
  return Math.min(42, Math.max(10, width + 2));
}

function worksheetName(raw: string): string {
  return (
    raw
      .replace(/[[\]:*?/\\]/g, '-')
      .trim()
      .slice(0, 31) || 'Data'
  );
}

export async function buildTabularXlsx(
  columns: readonly TabularExportColumn[],
  rows: ReadonlyArray<Record<string, unknown>>,
  sheetName = 'Data',
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Greenhouse';
  workbook.created = new Date();
  const worksheet = workbook.addWorksheet(worksheetName(sheetName), {
    views: [{ state: 'frozen', ySplit: 1 }],
  });

  worksheet.columns = columns.map((column) => ({
    header: column.label,
    key: column.key,
    width: columnWidth(column, rows),
  }));
  worksheet.addRows(
    rows.map((row) => Object.fromEntries(columns.map((column) => [column.key, displayValue(row[column.key])]))),
  );

  const header = worksheet.getRow(1);
  header.height = 24;
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.alignment = { vertical: 'middle' };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F7D32' } };
  if (columns.length > 0) {
    worksheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, rows.length + 1), column: columns.length },
    };
  }
  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber > 1) row.alignment = { vertical: 'top', wrapText: true };
  });

  const data = await workbook.xlsx.writeBuffer();
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

export async function generateTabularExport(input: {
  format: TabularExportFormat;
  columns: readonly TabularExportColumn[];
  rows: ReadonlyArray<Record<string, unknown>>;
  sheetName?: string;
}): Promise<GeneratedTabularExport> {
  if (input.format === 'csv') {
    return {
      buffer: buildTabularCsv(input.columns, input.rows),
      contentType: 'text/csv; charset=utf-8',
    };
  }
  return {
    buffer: await buildTabularXlsx(input.columns, input.rows, input.sheetName),
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };
}

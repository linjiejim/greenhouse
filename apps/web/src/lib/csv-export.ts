/**
 * Shared browser CSV export helpers.
 *
 * UTF-8 BOM keeps CJK readable in desktop Excel. Every cell is quoted and
 * formula-like text is neutralized before a user opens the file in a
 * spreadsheet application.
 */

export interface CsvColumn {
  key: string;
  label: string;
}

function csvValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function escapeCsvCell(value: unknown): string {
  const raw = csvValue(value);
  const neutralized = typeof value === 'string' && /^[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${neutralized.replace(/"/g, '""')}"`;
}

export function serializeCsv(columns: readonly CsvColumn[], rows: ReadonlyArray<Record<string, unknown>>): string {
  const lines = [
    columns.map((column) => escapeCsvCell(column.label)).join(','),
    ...rows.map((row) => columns.map((column) => escapeCsvCell(row[column.key])).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function safeCsvFilename(title: string | undefined, fallback = 'table'): string {
  const stem = Array.from((title || fallback).trim().replace(/[<>:"/\\|?*]/g, '-'))
    .map((character) => (character.charCodeAt(0) < 32 ? '-' : character))
    .join('')
    .replace(/\s+/g, '-')
    .slice(0, 80);
  return `${stem || fallback}-${new Date().toISOString().slice(0, 10)}.csv`;
}

export function downloadCsv(filename: string, csv: string): void {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function markdownTableToCsv(table: HTMLTableElement): string {
  const tableRows = Array.from(table.querySelectorAll('tr'));
  const width = tableRows.reduce((max, row) => Math.max(max, row.cells.length), 0);
  const columns = Array.from({ length: width }, (_, index) => ({
    key: String(index),
    label: tableRows[0]?.cells[index]?.textContent?.trim() ?? `Column ${index + 1}`,
  }));
  const rows = tableRows
    .slice(1)
    .map((row) =>
      Object.fromEntries(columns.map((column, index) => [column.key, row.cells[index]?.textContent?.trim() ?? ''])),
    );
  return serializeCsv(columns, rows);
}

/**
 * Clipboard-friendly table text. Tabs/newlines preserve rows and columns when
 * pasted into Sheets, Excel, Numbers, or a plain-text editor.
 */
export function markdownTableToTsv(table: HTMLTableElement): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.cells)
        .map((cell) => cell.textContent?.trim() ?? '')
        .join('\t'),
    )
    .join('\n');
}

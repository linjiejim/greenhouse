/** @vitest-environment happy-dom */

import { describe, expect, it } from 'vitest';
import { escapeCsvCell, markdownTableToTsv, serializeCsv } from './csv-export';

describe('browser CSV serializer', () => {
  it('uses BOM + CRLF, escapes quotes/newlines and blocks spreadsheet formulas', () => {
    const csv = serializeCsv(
      [
        { key: 'name', label: '客户' },
        { key: 'note', label: '备注' },
      ],
      [
        { name: 'A, "B"', note: '=cmd|x' },
        { name: '第二\n行', note: '@SUM(1,2)' },
      ],
    );

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('"A, ""B"""');
    expect(csv).toContain(`"'=cmd|x"`);
    expect(csv).toContain('"第二\n行"');
    expect(csv.endsWith('\r\n')).toBe(true);
    expect(escapeCsvCell('+1')).toBe(`"'+1"`);
    expect(escapeCsvCell(-1)).toBe('"-1"');
  });

  it('serializes rendered markdown tables as clipboard-friendly TSV', () => {
    const table = document.createElement('table');
    table.innerHTML = '<tr><th>Name</th><th>Count</th></tr><tr><td>Basil</td><td>3</td></tr>';

    expect(markdownTableToTsv(table)).toBe('Name\tCount\nBasil\t3');
  });
});

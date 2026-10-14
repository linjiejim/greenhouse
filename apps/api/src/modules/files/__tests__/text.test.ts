import { describe, expect, it } from 'vitest';
import { fileText } from '../text.js';

/** A small valid PDF with one line of text on each page. */
function pdfWithPages(lines: string[]): Uint8Array {
  const objects: string[] = [];
  const pageIds = lines.map((_, index) => 4 + index * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${lines.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  lines.forEach((line, index) => {
    const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
    objects[4 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`;
    objects[5 + index * 2] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = out.length;
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = out.length;
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

const pdf = { contentType: 'application/pdf', name: 'report.pdf' };

describe('reading the text of a file', () => {
  it('reads a PDF page by page and stops at the page limit', async () => {
    // Reading hands the bytes to the PDF reader, so each read gets its own copy.
    const bytes = () => pdfWithPages(['First page', 'Second page', 'Third page']);
    const all = await fileText(pdf, bytes());
    expect(all).toContain('First page');
    expect(all).toContain('Third page');
    const two = await fileText(pdf, bytes(), { maxPages: 2 });
    expect(two).toContain('Second page');
    expect(two).not.toContain('Third page');
  });

  it('keeps at most the characters asked for, decoding only the start of a long file', async () => {
    expect(await fileText(pdf, pdfWithPages(['First page', 'Second page']), { maxChars: 5 })).toBe('First');
    const long = new TextEncoder().encode('水'.repeat(2_000_000));
    const text = await fileText({ contentType: 'text/plain', name: 'long.txt' }, long, { maxChars: 1_000 });
    expect(text).toBe('水'.repeat(1_000));
    expect(await fileText({ contentType: 'image/png', name: 'x.png' }, new Uint8Array(4))).toBeNull();
  });
});

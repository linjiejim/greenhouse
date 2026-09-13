/**
 * What this module owes its callers is a correct NO.
 *
 * Every refusal has to name which failure it is, because the agent routes on
 * the reason: a scan goes to a sandbox, an encrypted file goes back to the
 * user for the password, a parse failure is worth retrying at all. Collapsing
 * them into one "cannot read" — or worse, returning the empty string a scanned
 * page really does extract to — is what lets a model summarise a document
 * nobody ever read.
 */

import { describe, it, expect } from 'vitest';
import { Workbook } from 'exceljs';
import { strToU8, zipSync } from 'fflate';
import { extractText, isExtractable, resolveWorkbookCtor } from '../extract-text.js';
import { encryptedPdf, malformedPdf, pdfWithText, pdfWithoutTextLayer } from './pdf-fixtures.js';

/** Word's own markup, minus the parts we deliberately never read. */
function docxBuffer(body: string): Buffer {
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  return Buffer.from(
    zipSync({
      '[Content_Types].xml': strToU8('<Types/>'),
      'word/document.xml': strToU8(document),
    }),
  );
}

function para(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function row(cells: string[]): string {
  return `<w:tr>${cells.map((c) => `<w:tc>${para(c)}</w:tc>`).join('')}</w:tr>`;
}

const PARAGRAPH_BODY = [para('Greenhouse Quotation'), para('R&amp;D 报价'), para('Valid for 30 days')].join('');

const TABLE_BODY = `<w:tbl>${[
  row(['Model', 'Qty', 'Price']),
  row(['LPH-Pro', '6', '$129.00']),
  row(['LPH-Lite', '12', '$79.00']),
].join('')}</w:tbl>`;

async function xlsxBuffer(): Promise<Buffer> {
  const wb = new Workbook();
  const sheet = wb.addWorksheet('Q3');
  sheet.addRow(['product', 'qty']);
  sheet.addRow(['Greenhouse Air', 40]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/**
 * The .xlsx test above cannot catch the bug this guards: Vitest's CJS interop
 * synthesizes a named `Workbook` binding that Node's real ESM loader does not,
 * so `import { Workbook } from 'exceljs'` was green here while every attached
 * spreadsheet on the server died with "Workbook is not a constructor". These
 * assert the module shapes directly instead of the one this runner happens to
 * produce.
 */
describe('resolveWorkbookCtor — CJS/ESM interop', () => {
  class FakeWorkbook {}

  it('reads through default, as Node ESM presents a CJS module', () => {
    expect(resolveWorkbookCtor({ default: { Workbook: FakeWorkbook } })).toBe(FakeWorkbook);
  });

  it('still accepts a synthesized named export', () => {
    expect(resolveWorkbookCtor({ Workbook: FakeWorkbook })).toBe(FakeWorkbook);
  });

  it('fails loudly when neither shape has a constructor', () => {
    expect(() => resolveWorkbookCtor({ default: {} })).toThrow(/no Workbook constructor/);
  });
});

describe('extractText — formats it can read', () => {
  it('reads plain text', async () => {
    const res = await extractText(Buffer.from('a,b\n1,2\n'), 'data.csv', 'text/csv');
    expect(res).toEqual({ ok: true, text: 'a,b\n1,2\n' });
  });

  it('reads an .xlsx workbook as CSV per sheet', async () => {
    const res = await extractText(
      await xlsxBuffer(),
      'sales.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('## sheet: Q3');
    expect(res.text).toContain('Greenhouse Air,40');
  });

  it('reads a PDF that has a text layer', async () => {
    const res = await extractText(pdfWithText('Payment terms are net 30 days'), 'terms.pdf', 'application/pdf');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('net 30 days');
  });

  it('detects format from the filename when the content type is useless', async () => {
    const res = await extractText(pdfWithText('from the extension'), 'terms.pdf', 'application/octet-stream');
    expect(res.ok).toBe(true);
  });
});

/**
 * UTF-16 text files (routine for Windows/ad-platform CSV exports) used to be
 * decoded as UTF-8: the model received mojibake with a NUL between every
 * character reported as a SUCCESSFUL read, and once that landed in
 * messages.pipeline the \u0000 escapes broke the friction miner's ::jsonb cast
 * — one bad attachment killed a whole day's sweep. The NUL guarantee is
 * therefore part of this module's contract, not a nicety.
 */
describe('extractText — text encodings', () => {
  const csv = 'id\tname\n1\tAcme\n';

  it('decodes UTF-16LE with a BOM', async () => {
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, 'utf16le')]);
    const res = await extractText(buffer, 'leads.csv', 'text/csv');
    expect(res).toEqual({ ok: true, text: csv });
  });

  it('decodes UTF-16BE with a BOM', async () => {
    const be = Buffer.from(csv, 'utf16le').swap16();
    const buffer = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    const res = await extractText(buffer, 'leads.csv', 'text/csv');
    expect(res).toEqual({ ok: true, text: csv });
  });

  it('sniffs BOM-less UTF-16LE from its zero high bytes', async () => {
    const res = await extractText(Buffer.from(csv, 'utf16le'), 'leads.csv', 'text/csv');
    expect(res).toEqual({ ok: true, text: csv });
  });

  it('strips a UTF-8 BOM', async () => {
    const res = await extractText(Buffer.from('\uFEFF' + csv, 'utf8'), 'leads.csv', 'text/csv');
    expect(res).toEqual({ ok: true, text: csv });
  });

  it('never emits NUL characters, whatever the input', async () => {
    // Sparse NULs in otherwise-normal text: stays on the UTF-8 branch
    // (below the UTF-16 sniff floor), and the strip still applies.
    const res = await extractText(
      Buffer.from('header\u0000 row, one stray NUL\u0000\n', 'utf8'),
      'weird.txt',
      'text/plain',
    );
    expect(res).toEqual({ ok: true, text: 'header row, one stray NUL\n' });
  });

  it('leaves ordinary UTF-8 CJK text alone', async () => {
    const text = '产品,数量\n育苗盆,40\n';
    const res = await extractText(Buffer.from(text, 'utf8'), 'data.csv', 'text/csv');
    expect(res).toEqual({ ok: true, text });
  });
});

describe('extractText — each refusal names its own reason', () => {
  it('reports a scanned PDF as having no text layer, not as empty text', async () => {
    const res = await extractText(pdfWithoutTextLayer(3), 'scan.pdf', 'application/pdf');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no_text_layer');
    expect(res.message).toMatch(/scan/i);
    // The counts are in the message so a human can sanity-check the verdict.
    expect(res.message).toContain('3 page(s)');
  });

  it('reports a password-protected PDF as encrypted', async () => {
    const res = await extractText(encryptedPdf(), 'locked.pdf', 'application/pdf');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('encrypted');
    expect(res.message).toMatch(/password-protected/);
  });

  it('reports a corrupt PDF as a parse failure rather than crashing', async () => {
    const res = await extractText(malformedPdf(), 'broken.pdf', 'application/pdf');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('extract_failed');
  });

  it('refuses a format it has no branch for', async () => {
    const res = await extractText(Buffer.from([0x00, 0x01]), 'clip.mp4', 'video/mp4');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('unsupported');
    expect(res.message).toContain('clip.mp4');
  });

  it('turns a broken workbook into a failure, not an exception', async () => {
    const res = await extractText(Buffer.from('not a zip archive'), 'sales.xlsx', 'application/octet-stream');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('extract_failed');
  });

  it('leaves the caller a routing sentence to write — the message never states one', async () => {
    const res = await extractText(pdfWithoutTextLayer(1), 'scan.pdf', 'application/pdf');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).not.toMatch(/mission|sandbox|download/i);
  });
});

describe('isExtractable', () => {
  it('recognises the readable formats without opening the bytes', () => {
    expect(isExtractable('application/pdf', 'a.pdf')).toBe(true);
    expect(isExtractable('text/csv', 'a.csv')).toBe(true);
    expect(isExtractable('application/octet-stream', 'a.xlsx')).toBe(true);
    expect(isExtractable('application/octet-stream', 'a.docx')).toBe(true);
    expect(isExtractable('video/mp4', 'a.mp4')).toBe(false);
  });
});

/**
 * .docx matters because of what actually shows up: quotations and contracts,
 * which the dev friction queue caught being refused twice in three days while
 * the requesting user had no sandbox to fall back to.
 */
describe('.docx', () => {
  const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  it('reads paragraphs in document order', async () => {
    const res = await extractText(docxBuffer(PARAGRAPH_BODY), 'quote.docx', DOCX_TYPE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Greenhouse Quotation');
    expect(res.text.indexOf('Greenhouse Quotation')).toBeLessThan(res.text.indexOf('Valid for 30 days'));
  });

  it('decodes XML entities and CJK rather than emitting escapes', async () => {
    const res = await extractText(docxBuffer(PARAGRAPH_BODY), 'quote.docx', DOCX_TYPE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('R&D 报价');
    expect(res.text).not.toContain('&amp;');
  });

  it('keeps table rows intact instead of flattening cells into paragraphs', async () => {
    // This is the whole reason the table branch exists: a quotation is models
    // against prices, and flattening re-pairs every price with the wrong row
    // while still looking like a successful read.
    const res = await extractText(docxBuffer(TABLE_BODY), 'quote.docx', DOCX_TYPE);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('LPH-Pro\t6\t$129.00');
    expect(res.text).toContain('LPH-Lite\t12\t$79.00');
  });

  it('refuses a document with no text rather than returning an empty success', async () => {
    const res = await extractText(docxBuffer('<w:p/>'), 'scan.docx', DOCX_TYPE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toBe('no_text_layer');
  });

  it('refuses a file that is not really a docx, and says what to do', async () => {
    const res = await extractText(Buffer.from('PK not a real zip'), 'old.docx', DOCX_TYPE);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/\.docx/);
  });

  it('names the fix for legacy binary Office files', async () => {
    // "unsupported" alone sends the model hunting for a sandbox; "re-save it"
    // is something the user can act on immediately.
    const res = await extractText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'quote.doc', 'application/msword');
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.message).toMatch(/re-saved as/i);
  });
});

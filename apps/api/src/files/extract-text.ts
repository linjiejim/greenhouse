/**
 * File → text, for every surface that lets an agent read a stored document.
 *
 * One implementation, two consumers: `read_attachment` (files dropped into a
 * conversation) and `crm_query.read_file` (files filed under a customer). A
 * second copy would mean the same PDF answers differently depending on where
 * it lives.
 *
 * The contract that matters is the FAILURE side. Every refusal names which
 * failure it is — encrypted, no text layer, or the parse itself broke — because
 * "I could not read this" is what routes the work somewhere else, and the right
 * somewhere-else differs per reason. A module that returned empty text for a
 * scanned page would let the agent "summarize" a document it never read.
 *
 * The routing sentence itself is NOT written here: what to do instead depends
 * on the surface (a chat attachment can go straight into a mission; a file in a
 * customer's cabinet has to be downloaded first). Callers append their own.
 */

import { unzipSync } from 'fflate';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { Workbook as ExcelWorkbook } from 'exceljs';

/** Beyond this we do not even fetch the bytes — a sandbox is the right tool. */
export const MAX_READABLE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MAX_CHARS = 20_000;
export const HARD_MAX_CHARS = 100_000;

/**
 * Wall-clock ceiling on a single PDF parse. A malformed or adversarial document
 * can drive pdf.js into pathological work; this bounds the damage to one slow
 * request instead of a wedged event loop.
 */
const PDF_EXTRACT_TIMEOUT_MS = 10_000;

/**
 * Below this many characters per page we call it a scan rather than a document.
 * A page of real prose is hundreds of characters; a scanned page yields zero,
 * or a few characters of stray OCR that would only mislead the model.
 */
const PDF_MIN_CHARS_PER_PAGE = 12;

export type ExtractFailureReason = 'unsupported' | 'encrypted' | 'no_text_layer' | 'extract_failed';

export type ExtractResult =
  | { ok: true; text: string }
  /** `message` states what happened, without the per-surface routing advice. */
  | { ok: false; reason: ExtractFailureReason; message: string };

/**
 * Formats we can turn into text on the API host. Anything absent is answered
 * with a refusal rather than a guess — a mojibake dump of a binary is worse
 * than an honest "I cannot read this".
 */
function isTextLike(contentType: string, name: string): boolean {
  if (contentType.startsWith('text/')) return true;
  if (/^application\/(json|xml|x-ndjson|javascript|x-yaml|yaml)$/.test(contentType)) return true;
  return /\.(txt|md|markdown|csv|tsv|json|jsonl|ndjson|ya?ml|xml|html?|log|ts|tsx|js|jsx|py|go|rs|java|sql|sh|toml|ini|env)$/i.test(
    name,
  );
}

function isSpreadsheet(contentType: string, name: string): boolean {
  return contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' || /\.xlsx$/i.test(name);
}

function isWordDocument(contentType: string, name: string): boolean {
  return (
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(name)
  );
}

/**
 * The legacy binary formats. Detected only so the refusal can name the fix —
 * "save it as .docx" is actionable, "unsupported format" is not.
 */
function isLegacyOfficeBinary(contentType: string, name: string): boolean {
  return contentType === 'application/msword' || /\.(docs?|xls|ppt)$/i.test(name);
}

function isPdf(contentType: string, name: string): boolean {
  return contentType === 'application/pdf' || /\.pdf$/i.test(name);
}

/** Whether `extractText` has a branch for this file at all (pre-flight checks). */
export function isExtractable(contentType: string, name: string): boolean {
  return (
    isTextLike(contentType, name) ||
    isSpreadsheet(contentType, name) ||
    isWordDocument(contentType, name) ||
    isPdf(contentType, name)
  );
}

/** Human-facing list of what this module reads, for tool descriptions. */
export const SUPPORTED_FORMATS_HINT = 'text, Markdown, CSV/TSV, JSON, XML/HTML, source code, .xlsx, .docx and PDF';

/**
 * Decode text bytes honouring UTF-16 BOMs, and never emit NUL characters.
 *
 * Windows/ad-platform exports are routinely UTF-16LE; decoding those as UTF-8
 * yields mojibake with a NUL between every character. That garbage reads as a
 * "successful" extraction, and once persisted into `messages.pipeline` the
 * `\u0000` escapes break the friction miner's `::jsonb` cast (PostgreSQL jsonb
 * cannot represent NUL), killing an entire day's sweep. So NUL stripping here
 * is load-bearing for downstream SQL, not cosmetic.
 */
export function decodeTextBuffer(buffer: Buffer): string {
  let text: string;
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    text = buffer.subarray(2).toString('utf16le');
  } else if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // Node has no big-endian UTF-16 decoder; byte-swap a copy (swap16 mutates,
    // and needs an even length — a truncated file may carry a dangling byte).
    const body = buffer.subarray(2);
    const even = Buffer.from(body.subarray(0, body.length - (body.length % 2)));
    text = even.swap16().toString('utf16le');
  } else if (looksUtf16WithoutBom(buffer)) {
    text = buffer.toString('utf16le');
  } else {
    text = buffer.toString('utf8');
  }
  return text.replace(/^\uFEFF/, '').replaceAll(String.fromCharCode(0), '');
}

/**
 * BOM-less UTF-16LE sniff: ASCII-range text stored as UTF-16LE has a zero high
 * byte at every odd index, so ~half the bytes are NUL. Real UTF-8 text has none
 * — the 40% floor keeps any plausible UTF-8 file out of this branch.
 */
function looksUtf16WithoutBom(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 512);
  if (sample.length < 4) return false;
  let zeros = 0;
  for (const byte of sample) if (byte === 0) zeros++;
  return zeros / sample.length >= 0.4;
}

type WorkbookCtor = new () => ExcelWorkbook;

/**
 * exceljs is CommonJS, so under Node's real ESM loader its named exports are
 * not statically detectable and `Workbook` exists only on `default` — while
 * Vitest's interop synthesizes the named binding. Destructuring `{ Workbook }`
 * therefore passed every test and threw "Workbook is not a constructor" on the
 * server for every .xlsx anyone attached. Both shapes are handled here, and a
 * module exposing neither fails loudly rather than as a confusing `new undefined`.
 */
export function resolveWorkbookCtor(mod: unknown): WorkbookCtor {
  const ns = mod as { default?: { Workbook?: unknown }; Workbook?: unknown } | null | undefined;
  const ctor = ns?.default?.Workbook ?? ns?.Workbook;
  if (typeof ctor !== 'function') {
    throw new Error('exceljs exposed no Workbook constructor');
  }
  return ctor as WorkbookCtor;
}

/** Excel → one CSV block per sheet. exceljs is already a dependency (exports). */
async function xlsxToText(buffer: Buffer): Promise<string> {
  const Workbook = resolveWorkbookCtor(await import('exceljs'));
  const wb = new Workbook();
  await wb.xlsx.load(new Uint8Array(buffer).buffer as ArrayBuffer);
  const blocks: string[] = [];
  wb.eachSheet((sheet) => {
    const rows: string[] = [];
    sheet.eachRow((row) => {
      const values = (row.values as unknown[]).slice(1).map((v) => {
        if (v == null) return '';
        if (typeof v === 'object' && 'text' in (v as Record<string, unknown>)) {
          return String((v as { text: unknown }).text);
        }
        if (typeof v === 'object' && 'result' in (v as Record<string, unknown>)) {
          return String((v as { result: unknown }).result ?? '');
        }
        return String(v);
      });
      rows.push(values.map((cell) => (/[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join(','));
    });
    blocks.push(`## sheet: ${sheet.name}\n${rows.join('\n')}`);
  });
  return blocks.join('\n\n');
}

/**
 * Ceiling on the decompressed `word/document.xml`. A .docx is a zip, so a small
 * upload can expand without bound; text-heavy XML routinely compresses 10:1 and
 * a hostile one does far better. Real documents are nowhere near this — a
 * 500-page manuscript lands around 5 MB of XML.
 */
const DOCX_MAX_XML_BYTES = 32 * 1024 * 1024;

function decodeXmlEntities(text: string): string {
  return (
    text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
      // Last, so an escaped entity (`&amp;lt;`) resolves to the literal `&lt;`
      // rather than being decoded a second time into `<`.
      .replace(/&amp;/g, '&')
  );
}

/**
 * The visible text of one paragraph or cell: `<w:t>` runs in document order,
 * with tabs and line breaks kept because they carry layout meaning in the
 * forms and quotations this mostly sees.
 */
function wordRunsToText(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*>|<w:br\b[^>]*>/g)) {
    if (match[1] !== undefined) out += decodeXmlEntities(match[1]);
    else if (match[0].startsWith('<w:tab')) out += '\t';
    else out += '\n';
  }
  return out;
}

/**
 * A table as tab-separated rows.
 *
 * Row structure is the point: a quotation is a table of models against prices,
 * and flattening the cells into consecutive paragraphs (which is what a plain
 * tag-strip does) silently re-pairs every price with the wrong product. Nested
 * tables are rare enough to accept degrading into flattened rows.
 */
function wordTableToText(xml: string): string {
  const rows: string[] = [];
  for (const row of xml.matchAll(/<w:tr[\s>][\s\S]*?<\/w:tr>/g)) {
    const cells: string[] = [];
    for (const cell of row[0].matchAll(/<w:tc[\s>][\s\S]*?<\/w:tc>/g)) {
      cells.push(wordRunsToText(cell[0]).replace(/\s+/g, ' ').trim());
    }
    if (cells.length > 0) rows.push(cells.join('\t'));
  }
  return rows.join('\n');
}

/**
 * .docx → its text layer.
 *
 * Only `word/document.xml` is read: no headers, footnotes, comments, embedded
 * objects or macros, and nothing is executed. Word always writes the `w:`
 * prefix, so matching it directly avoids pulling in an XML parser for a format
 * we only ever read one way.
 */
function docxToText(buffer: Buffer): ExtractResult {
  let xmlBytes: Uint8Array | undefined;
  try {
    const entries = unzipSync(new Uint8Array(buffer), {
      filter: (file) => file.name === 'word/document.xml' && file.originalSize <= DOCX_MAX_XML_BYTES,
    });
    xmlBytes = entries['word/document.xml'];
  } catch (err) {
    return { ok: false, reason: 'extract_failed', message: `This .docx could not be opened: ${toErrorMessage(err)}` };
  }

  if (!xmlBytes) {
    return {
      ok: false,
      reason: 'extract_failed',
      message:
        'This file is not a readable .docx — its main document part is missing or too large. If it was renamed from .doc, re-save it as .docx.',
    };
  }

  const xml = new TextDecoder('utf-8').decode(xmlBytes);
  const blocks: string[] = [];
  for (const block of xml.matchAll(/<w:tbl[\s>][\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/w:p>)/g)) {
    const text = block[0].startsWith('<w:tbl') ? wordTableToText(block[0]) : wordRunsToText(block[0]);
    if (text.trim().length > 0) blocks.push(text);
  }

  // NUL stripping is load-bearing downstream, not cosmetic: a NUL that
  // reaches `messages.pipeline` breaks the friction miner's `::jsonb` cast and
  // kills a whole day's sweep. Same reason `decodeTextBuffer` does it.
  const out = blocks.join('\n').replaceAll(String.fromCharCode(0), '');
  if (out.trim().length === 0) {
    // Same contract as a scanned PDF: an empty string presented as success
    // would let the agent "summarize" a document it never read.
    return {
      ok: false,
      reason: 'no_text_layer',
      message: 'This .docx has no extractable text — its content is likely images or embedded objects.',
    };
  }
  return { ok: true, text: out };
}

class ExtractTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExtractTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * PDF → its text layer, and nothing else.
 *
 * We parse, we never render and never execute: no page rasterisation, no XFA
 * forms, no embedded JavaScript. pdf.js 6 (bundled inside unpdf) has also
 * dropped the eval-based font path that CVE-2024-4367 abused — there is no
 * `new Function` left in the build — so the worst a hostile PDF achieves here
 * is a failed parse or a timeout, both of which are ordinary return values.
 */
async function pdfToText(buffer: Buffer): Promise<ExtractResult> {
  const { getDocumentProxy, extractText: extractPdfText } = await import('unpdf');

  // pdf.js takes ownership of the array it is handed; copy so a caller's buffer
  // is never detached underneath it.
  const bytes = new Uint8Array(buffer);

  let proxy: Awaited<ReturnType<typeof getDocumentProxy>> | undefined;
  const work = (async () => {
    proxy = await getDocumentProxy(bytes, { enableXfa: false });
    const { text, totalPages } = await extractPdfText(proxy, { mergePages: true });
    return { text, totalPages };
  })();

  // Release the pdf.js worker whenever the parse settles — including long after
  // we have stopped waiting for it. Teardown hangs off the loading task, not the
  // document proxy (which only exposes `cleanup()` for cached page resources).
  const settled = work.finally(() => void proxy?.loadingTask?.destroy().catch(() => {}));
  settled.catch(() => {}); // a post-timeout failure must not surface as unhandled

  let text: string;
  let totalPages: number;
  try {
    ({ text, totalPages } = await withTimeout(settled, PDF_EXTRACT_TIMEOUT_MS));
  } catch (err) {
    if (err instanceof ExtractTimeout) {
      return {
        ok: false,
        reason: 'extract_failed',
        message: `PDF parsing timed out after ${PDF_EXTRACT_TIMEOUT_MS / 1000}s — the file may be corrupt or unusually complex.`,
      };
    }
    // pdf.js throws a PasswordException by name; matching the name keeps this
    // independent of which pdf.js build unpdf ships.
    const name = (err as { name?: string })?.name ?? '';
    if (name === 'PasswordException') {
      return { ok: false, reason: 'encrypted', message: 'This PDF is password-protected, so its text cannot be read.' };
    }
    return { ok: false, reason: 'extract_failed', message: `This PDF could not be parsed: ${toErrorMessage(err)}` };
  }

  const trimmed = text.trim();
  if (trimmed.length < totalPages * PDF_MIN_CHARS_PER_PAGE) {
    return {
      ok: false,
      reason: 'no_text_layer',
      message: `This PDF has no usable text layer (${trimmed.length} characters across ${totalPages} page(s)) — it is almost certainly a scan or images.`,
    };
  }
  return { ok: true, text };
}

/**
 * Turn stored bytes into text, or say precisely why not.
 *
 * `name` drives format detection as much as `contentType` does: the drive stores
 * a content type derived from the filename, and chat attachments accept whatever
 * the browser claimed, so neither is trustworthy on its own.
 */
export async function extractText(buffer: Buffer, name: string, contentType: string): Promise<ExtractResult> {
  try {
    if (isPdf(contentType, name)) return await pdfToText(buffer);
    if (isSpreadsheet(contentType, name)) return { ok: true, text: await xlsxToText(buffer) };
    if (isWordDocument(contentType, name)) return docxToText(buffer);
    if (isTextLike(contentType, name)) return { ok: true, text: decodeTextBuffer(buffer) };
    if (isLegacyOfficeBinary(contentType, name)) {
      // The fix is one "Save As" away, so name it — an unqualified refusal here
      // sends the model looking for a sandbox it may not even have.
      return {
        ok: false,
        reason: 'unsupported',
        message: `${name} is in a legacy binary Office format, which cannot be read here — ask for it re-saved as .docx, .xlsx or PDF.`,
      };
    }
    return {
      ok: false,
      reason: 'unsupported',
      message: `${name} (${contentType}) is not a format that can be read as text here — readable formats are ${SUPPORTED_FORMATS_HINT}.`,
    };
  } catch (err) {
    return { ok: false, reason: 'extract_failed', message: `${name} could not be read: ${toErrorMessage(err)}` };
  }
}

/** The text inside a file, for the tools that read files and for knowledge search. */

import { getDocumentProxy } from 'unpdf';

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|x-sh|sql))/;
const TEXT_NAMES = /\.(md|txt|csv|tsv|json|ya?ml|xml|log)$/i;

/** Text, Markdown, CSV, JSON and the like: readable as they are. */
export function isTextFile(file: { contentType: string; name: string }): boolean {
  return TEXT_TYPES.test(file.contentType) || TEXT_NAMES.test(file.name);
}

/**
 * What reading one file may cost: the text kept, the PDF pages read and the time spent on
 * them. Reading stops at whichever comes first, so a 50 MB upload costs no more than a page of it.
 */
export interface TextLimits {
  maxChars?: number;
  maxPages?: number;
  deadlineMs?: number;
}

const DEFAULT_LIMITS = { maxChars: 100_000, maxPages: 100, deadlineMs: 10_000 };

/**
 * The text of a text file or a PDF, at most `maxChars` long; null for anything else (images,
 * archives, office files). The PDF reader takes the bytes over: pass ones nothing reads after.
 */
export async function fileText(
  file: { contentType: string; name: string },
  bytes: Uint8Array,
  limits: TextLimits = {},
): Promise<string | null> {
  const { maxChars, maxPages, deadlineMs } = { ...DEFAULT_LIMITS, ...limits };
  if (file.contentType === 'application/pdf') return pdfText(bytes, { maxChars, maxPages, deadlineMs });
  // A character takes at most four bytes: only the start of a long file is decoded.
  if (isTextFile(file)) return new TextDecoder().decode(bytes.subarray(0, maxChars * 4)).slice(0, maxChars);
  return null;
}

/** A PDF's text page by page, one at a time, until a limit is reached. */
async function pdfText(bytes: Uint8Array, limits: Required<TextLimits>): Promise<string> {
  const started = Date.now();
  const pdf = await getDocumentProxy(bytes);
  try {
    const pages: string[] = [];
    let length = 0;
    const last = Math.min(pdf.numPages, limits.maxPages);
    for (let number = 1; number <= last && length < limits.maxChars; number++) {
      if (Date.now() - started > limits.deadlineMs) break;
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const text = content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join('');
      page.cleanup();
      pages.push(text);
      length += text.length + 2;
    }
    return pages.join('\n\n').slice(0, limits.maxChars);
  } finally {
    await pdf.loadingTask.destroy();
  }
}

/** The text inside a file, for the tools that read files and for knowledge search. */

import { extractText, getDocumentProxy } from 'unpdf';

const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|csv|javascript|x-sh|sql))/;
const TEXT_NAMES = /\.(md|txt|csv|tsv|json|ya?ml|xml|log)$/i;

/** Text, Markdown, CSV, JSON and the like: readable as they are. */
export function isTextFile(file: { contentType: string; name: string }): boolean {
  return TEXT_TYPES.test(file.contentType) || TEXT_NAMES.test(file.name);
}

/** The text of a text file or a PDF; null for anything else (images, archives, office files). */
export async function fileText(file: { contentType: string; name: string }, bytes: Uint8Array): Promise<string | null> {
  if (file.contentType === 'application/pdf') {
    const pdf = await getDocumentProxy(bytes);
    const extracted = await extractText(pdf, { mergePages: true });
    return Array.isArray(extracted.text) ? extracted.text.join('\n\n') : extracted.text;
  }
  if (isTextFile(file)) return new TextDecoder().decode(bytes);
  return null;
}

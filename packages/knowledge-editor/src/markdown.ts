/**
 * Markdown → Tiptap (ProseMirror) JSON in Node, with the editor's own schema.
 *
 * Docs store only Markdown (data-model §12.2); there is no stored editor JSON. This builds the
 * document the web editor would build from the same Markdown, so the round-trip tests
 * (Markdown → editor → Markdown) can run without a browser.
 *
 * Pipeline: Markdown --(md-html)--> HTML --(@tiptap/html generateJSON)--> Tiptap JSON.
 * Runs in Node via @tiptap/html's server export (happy-dom backed). The Markdown→HTML half is
 * the browser editor's loader too (see md-html.ts).
 */

import { generateJSON } from '@tiptap/html';
import { knowledgeEditorExtensions } from './extensions.js';
import { markdownToEditorHtml } from './md-html.js';

export const EMPTY_TIPTAP_DOC = '{}';

/**
 * Convert canonical Markdown to a Tiptap JSON string: the document the editor builds from it.
 *
 * Returns '{}' for blank input or on any failure.
 */
export function markdownToTiptapJson(markdown: string | null | undefined): string {
  const md = (markdown ?? '').trim();
  if (!md) return EMPTY_TIPTAP_DOC;
  try {
    const json = generateJSON(markdownToEditorHtml(md), knowledgeEditorExtensions());
    return JSON.stringify(json);
  } catch {
    return EMPTY_TIPTAP_DOC;
  }
}

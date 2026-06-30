/**
 * Server-side Markdown → Tiptap (ProseMirror) JSON conversion.
 *
 * Markdown is the canonical content for knowledge-base docs; `content_json` is
 * the editor state the web UI renders. When a writer (e.g. the agent
 * knowledge_mutation tool) only supplies Markdown, we derive `content_json` here
 * so the two never drift — using the SAME schema the editor uses
 * (`knowledgeEditorExtensions`), so the result round-trips cleanly.
 *
 * Pipeline: Markdown --(marked)--> HTML --(@tiptap/html generateJSON)--> Tiptap JSON.
 * Runs in Node via @tiptap/html's server export (happy-dom backed).
 */

import { marked } from 'marked';
import { generateJSON } from '@tiptap/html';
import { knowledgeEditorExtensions } from './extensions.js';

export const EMPTY_TIPTAP_DOC = '{}';

/**
 * Convert canonical Markdown to a Tiptap JSON string ready to store in
 * knowledge_base.content_json.
 *
 * Returns '{}' for blank input or on any failure, so callers can store the
 * result unconditionally and let the editor fall back to rendering Markdown.
 */
export function markdownToTiptapJson(markdown: string | null | undefined): string {
  const md = (markdown ?? '').trim();
  if (!md) return EMPTY_TIPTAP_DOC;
  try {
    const html = marked.parse(md, { async: false, gfm: true }) as string;
    const json = generateJSON(html, knowledgeEditorExtensions());
    return JSON.stringify(json);
  } catch {
    return EMPTY_TIPTAP_DOC;
  }
}

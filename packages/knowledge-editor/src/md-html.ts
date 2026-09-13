/**
 * Markdown → HTML, the one entry point both editor loaders go through.
 *
 * Two callers, and they MUST agree or documents change shape as they move
 * between them:
 * - server: `markdown.ts` pipes this HTML into `generateJSON` to derive
 *   `content_json` for docs written as plain Markdown (agent tools, CLI import).
 * - browser: the Tiptap editor feeds this HTML to `setContent` when a doc has no
 *   usable `content_json`, so ProseMirror parses it against the same schema.
 *
 * The browser side used to own a hand-rolled line-based converter that only knew
 * headings, lists and blockquotes; everything else — tables, images, bold, inline
 * code — arrived as literal `<p>` text and the next save serialized that back
 * over the canonical Markdown, escaped. Full `marked` is what keeps the
 * round-trip lossless.
 *
 * A private `Marked` instance, not the module-level singleton: apps/web calls
 * `marked.setOptions({ breaks: true })` for chat rendering, and inheriting that
 * here would turn every soft wrap inside a doc into a hard `<br>` the first time
 * it round-tripped through the editor.
 */

import { Marked } from 'marked';

const editorMarked = new Marked({ gfm: true, breaks: false });

/** Parse canonical Markdown into HTML the knowledge editor schema can consume. */
export function markdownToEditorHtml(markdown: string | null | undefined): string {
  const md = (markdown ?? '').trim();
  if (!md) return '';
  return editorMarked.parse(md, { async: false }) as string;
}

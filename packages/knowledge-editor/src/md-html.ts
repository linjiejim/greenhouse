/**
 * Markdown → HTML for the knowledge editor.
 *
 * Docs store only Markdown (data-model §12.2). The web editor loads a doc by feeding this HTML
 * to Tiptap's `setContent`, so ProseMirror parses it against the editor schema; `markdown.ts`
 * does the same in Node for the round-trip tests. The HTML is NOT sanitised: raw HTML in the
 * Markdown passes through. It is only safe as input to ProseMirror's parser, which keeps nothing
 * but schema nodes; never put it into a page as HTML (a read-only view sanitises its own).
 *
 * A private `Marked` instance, not the module-level singleton: apps/web calls
 * `marked.setOptions({ breaks: true })` for chat rendering, and inheriting that here would turn
 * every soft wrap inside a doc into a hard `<br>` the first time it round-tripped through the
 * editor. Full `marked` (GFM) is what keeps the round-trip lossless.
 *
 * Mentions are links to `member:<id>` in Markdown (`[@Name](member:mbr_…)`). A link with that
 * target becomes the mention node's own HTML, because the link mark refuses unknown schemes and
 * the mention would otherwise turn into text.
 */

import { Marked } from 'marked';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const editorMarked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    link(token) {
      const id = /^member:([^\s]+)$/.exec(token.href)?.[1];
      if (!id) return false;
      const label = token.text.replace(/\\([\\[\]])/g, '$1').replace(/^@/, '');
      return `<span data-type="mention" data-id="${escapeHtml(id)}" data-label="${escapeHtml(label)}">@${escapeHtml(label)}</span>`;
    },
  },
});

/** Parse canonical Markdown into HTML the knowledge editor schema can consume. */
export function markdownToEditorHtml(markdown: string | null | undefined): string {
  const md = (markdown ?? '').trim();
  if (!md) return '';
  return editorMarked.parse(md, { async: false }) as string;
}

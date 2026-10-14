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
 *
 * A list whose items are all tasks (`- [ ] …`, `- [x] …`) becomes the task list nodes' HTML
 * (`ul[data-type=taskList]`, `li[data-type=taskItem][data-checked]`). A task in a list that also
 * has plain items keeps its box as the text it was written as, so nothing is lost on the way
 * through the editor.
 */

import { Marked, type Token, type Tokens } from 'marked';

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

/** A task item's blocks without its checkbox (marked puts it first, or first in the first paragraph). */
function withoutCheckbox(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    if (token.type === 'checkbox') continue;
    if (
      out.length === 0 &&
      (token.type === 'paragraph' || token.type === 'text') &&
      'tokens' in token &&
      token.tokens
    ) {
      const inner = token.tokens.filter((child) => child.type !== 'checkbox');
      if (!inner.length && token.type === 'paragraph') continue;
      out.push({ ...token, tokens: inner } as Token);
      continue;
    }
    out.push(token);
  }
  return out;
}

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
    list(token: Tokens.List) {
      if (token.ordered || !token.items.length || !token.items.every((entry) => entry.task)) return false;
      const items = token.items
        .map(
          (entry) =>
            `<li data-type="taskItem" data-checked="${entry.checked ? 'true' : 'false'}">${this.parser.parse(withoutCheckbox(entry.tokens))}</li>\n`,
        )
        .join('');
      return `<ul data-type="taskList">\n${items}</ul>\n`;
    },
    checkbox({ checked }) {
      return checked ? '[x] ' : '[ ] ';
    },
  },
});

/** Parse canonical Markdown into HTML the knowledge editor schema can consume. */
export function markdownToEditorHtml(markdown: string | null | undefined): string {
  const md = (markdown ?? '').trim();
  if (!md) return '';
  return editorMarked.parse(md, { async: false }) as string;
}

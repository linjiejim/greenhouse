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
 *
 * Mentions are links to `member:<id>` in Markdown (`[@Name](member:mbr_…)`). A
 * link with that target becomes the mention node's own HTML, because the link
 * mark refuses unknown schemes and the mention would otherwise turn into text.
 *
 * A list whose items are all tasks (`- [ ] …`, `- [x] …`) becomes the task list
 * nodes' HTML (`ul[data-type=taskList]`, `li[data-type=taskItem][data-checked]`).
 * A task in a list that also has plain items keeps its box as the text it was
 * written as, so nothing is lost on the way through the editor.
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

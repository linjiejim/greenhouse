/**
 * Editor suggestion menus — `/` block commands, `[[` document references and
 * `@` mentions.
 *
 * UI-ONLY: these add no schema nodes/marks (the `@` mention NODE itself lives in
 * the shared @greenhouse/knowledge-editor schema; only its dropdown is here), so the
 * server-side Markdown→JSON converter stays untouched.
 *
 * The dropdown is a plain DOM popup rather than tippy/floating-ui — it needs a
 * list, arrow-key navigation and Enter, and adding a positioning dependency for
 * that isn't worth it.
 */

import { Extension, type Editor, type Range } from '@tiptap/core';
import Suggestion from '@tiptap/suggestion';
import { PluginKey } from '@tiptap/pm/state';
import { listKnowledgeDocs } from '../../lib/api/knowledge';
import { fetchShareableUsers } from '../../lib/api';

export interface SuggestionMenuItem {
  label: string;
  hint?: string;
  run: (editor: Editor, range: Range) => void;
}

/** Tiptap suggestion `render()` implementation backed by a small DOM popup. */
function createMenuRenderer() {
  let el: HTMLDivElement | null = null;
  let items: SuggestionMenuItem[] = [];
  let selected = 0;
  let current: { editor: Editor; range: Range } | null = null;

  const destroy = () => {
    el?.remove();
    el = null;
  };

  const pick = (index: number) => {
    const item = items[index];
    if (item && current) item.run(current.editor, current.range);
    destroy();
  };

  const paint = () => {
    if (!el) return;
    el.replaceChildren();
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'px-2 py-1 text-xs text-fg-faint';
      empty.textContent = '—';
      el.appendChild(empty);
      return;
    }
    items.forEach((item, i) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'block w-full text-left px-2 py-1 text-sm truncate ' +
        (i === selected ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg-secondary');
      btn.textContent = item.hint ? `${item.label} · ${item.hint}` : item.label;
      // mousedown (not click) so the editor selection isn't lost first.
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(i);
      });
      el!.appendChild(btn);
    });
  };

  const place = (rect: DOMRect | null) => {
    if (!el || !rect) return;
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 4}px`;
  };

  return {
    onStart: (props: any) => {
      current = { editor: props.editor, range: props.range };
      items = props.items ?? [];
      selected = 0;
      el = document.createElement('div');
      el.className =
        'fixed z-50 min-w-[200px] max-w-[320px] max-h-64 overflow-y-auto rounded-md border border-edge bg-surface-raised shadow-lg py-1';
      document.body.appendChild(el);
      paint();
      place(props.clientRect?.() ?? null);
    },
    onUpdate: (props: any) => {
      current = { editor: props.editor, range: props.range };
      items = props.items ?? [];
      selected = 0;
      paint();
      place(props.clientRect?.() ?? null);
    },
    onKeyDown: (props: any) => {
      const key = props.event.key;
      if (key === 'Escape') {
        destroy();
        return true;
      }
      if (!el || items.length === 0) return false;
      if (key === 'ArrowDown') {
        selected = (selected + 1) % items.length;
        paint();
        return true;
      }
      if (key === 'ArrowUp') {
        selected = (selected - 1 + items.length) % items.length;
        paint();
        return true;
      }
      if (key === 'Enter' || key === 'Tab') {
        pick(selected);
        return true;
      }
      return false;
    },
    onExit: destroy,
  };
}

// ─── `/` block commands ─────────────────────────────────

const SLASH_ITEMS: SuggestionMenuItem[] = [
  { label: 'Heading 1', hint: 'h1', run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 1 }).run() },
  { label: 'Heading 2', hint: 'h2', run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 2 }).run() },
  { label: 'Heading 3', hint: 'h3', run: (e, r) => e.chain().focus().deleteRange(r).toggleHeading({ level: 3 }).run() },
  { label: 'Bullet list', hint: 'ul', run: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { label: 'Numbered list', hint: 'ol', run: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { label: 'Quote', hint: '>', run: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { label: 'Code block', hint: '```', run: (e, r) => e.chain().focus().deleteRange(r).toggleCodeBlock().run() },
  {
    label: 'Table',
    hint: '3×3',
    run: (e, r) => e.chain().focus().deleteRange(r).insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  { label: 'Divider', hint: '---', run: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
];

export const SlashCommands = Extension.create({
  name: 'knowledgeSlashCommands',
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        // Each Suggestion instance needs its own ProseMirror plugin key — they all
        // default to `suggestion$`, and three of them (slash / [[ / @) would throw
        // "Adding different instances of a keyed plugin".
        pluginKey: new PluginKey('knowledgeSlashSuggestion'),
        char: '/',
        startOfLine: false,
        items: ({ query }: { query: string }) =>
          SLASH_ITEMS.filter((i) => i.label.toLowerCase().includes(query.toLowerCase())),
        render: createMenuRenderer,
      }),
    ];
  },
});

// ─── `[[` document references ───────────────────────────

export const DocReference = Extension.create({
  name: 'knowledgeDocReference',
  addProseMirrorPlugins() {
    return [
      Suggestion({
        editor: this.editor,
        pluginKey: new PluginKey('knowledgeDocRefSuggestion'),
        char: '[[',
        startOfLine: false,
        items: async ({ query }: { query: string }) => {
          const docs = await listKnowledgeDocs({ search: query || undefined, status: 'published', limit: 8 }).catch(
            () => [],
          );
          return docs.map((d) => ({
            label: d.title,
            hint: d.slug,
            // Insert a real Link MARK, not raw markdown text: the serializer
            // escapes `[` in plain text (`\[title\]`), which would break the link
            // in canonical Markdown and stop backlinks from being detected.
            run: (e: Editor, r: Range) =>
              e
                .chain()
                .focus()
                .deleteRange(r)
                .insertContent([
                  {
                    type: 'text',
                    text: d.title,
                    marks: [{ type: 'link', attrs: { href: `#/knowledge/doc/${d.id}-${d.slug}` } }],
                  },
                  { type: 'text', text: ' ' },
                ])
                .run(),
          }));
        },
        render: createMenuRenderer,
      }),
    ];
  },
});

// ─── `@` mentions (node lives in the shared schema) ─────

export const mentionSuggestion = {
  pluginKey: new PluginKey('knowledgeMentionSuggestion'),
  char: '@',
  startOfLine: false,
  items: async ({ query }: { query: string }) => {
    const users = await fetchShareableUsers().catch(() => []);
    const q = query.toLowerCase();
    return users
      .filter((u) => u.nickname.toLowerCase().includes(q) || u.email?.toLowerCase().includes(q))
      .slice(0, 8)
      .map((u) => ({
        label: u.nickname,
        hint: u.email,
        run: (e: Editor, r: Range) =>
          e
            .chain()
            .focus()
            .deleteRange(r)
            .insertContent([
              { type: 'mention', attrs: { id: u.id, label: u.nickname } },
              { type: 'text', text: ' ' },
            ])
            .run(),
      }));
  },
  render: createMenuRenderer,
};

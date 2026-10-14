/**
 * The knowledge editor in a browser (KNOW-03, KNOW-04): the shared schema plus what writing needs —
 * `/` blocks, `[[` links to docs, `@` mentions, pictures pasted, dropped or chosen, a placeholder —
 * with Markdown in and out. Markdown stays the source of truth: the editor loads it through
 * md-html and saves it through serialize, so a doc reads the same before and after an edit.
 *
 * The suggestion menus are the app's to draw. Each trigger reports what to show through
 * `onSuggest` (the kind, the query, the items, the active one and where the caret is); arrows,
 * Enter, Tab and Escape work inside the editor, and the app calls `choose` for a click.
 */

import { Editor, Extension, type Range } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  Suggestion,
  type SuggestionKeyDownProps,
  type SuggestionOptions,
  type SuggestionProps,
} from '@tiptap/suggestion';
import { knowledgeEditorExtensions } from './extensions.js';
import { markdownToEditorHtml } from './md-html.js';
import { tiptapJsonToMarkdown, type TiptapNode } from './serialize.js';

export type { Editor } from '@tiptap/core';

/** The blocks `/` offers, in this order. */
export const BLOCKS = [
  'paragraph',
  'heading1',
  'heading2',
  'heading3',
  'bulletList',
  'orderedList',
  'blockquote',
  'codeBlock',
  'table',
  'horizontalRule',
  'image',
] as const;
export type BlockId = (typeof BLOCKS)[number];

/** A block as the menu shows it; `keywords` are other words that find it (English names, say). */
export interface BlockChoice {
  id: BlockId;
  label: string;
  keywords?: string;
}
export interface DocChoice {
  id: string;
  title: string;
  /** Where it lives, for the menu. */
  hint?: string;
}
export interface MemberChoice {
  id: string;
  name: string;
  hint?: string;
}

export type SuggestionKind = 'block' | 'doc' | 'mention';
export type SuggestionChoice = BlockChoice | DocChoice | MemberChoice;

/** What the open menu shows. */
export interface SuggestionView {
  kind: SuggestionKind;
  query: string;
  items: SuggestionChoice[];
  active: number;
  loading: boolean;
  /** The caret, in viewport coordinates. */
  rect: DOMRect | null;
}

export interface DocEditorOptions {
  element: HTMLElement;
  markdown: string;
  /** Shown while the doc is empty. */
  placeholder?: string;
  /** Shown where a picture is uploading. */
  uploadingLabel?: string;
  blocks: readonly BlockChoice[];
  findDocs(query: string, signal: AbortSignal): Promise<DocChoice[]>;
  findMembers(query: string, signal: AbortSignal): Promise<MemberChoice[]>;
  /** Uploads a picture; resolves to the address to show it at, or null when it failed. */
  uploadImage(file: File): Promise<string | null>;
  /** The `/` picture block: the app asks for files, then calls `insertImages`. */
  requestImage(): void;
  onSuggest(view: SuggestionView | null): void;
  /** Every change to the content. */
  onChange?(): void;
  /** Selection or marks moved: toolbars refresh. */
  onSelection?(): void;
}

export interface DocEditor {
  editor: Editor;
  /** The content as canonical Markdown. */
  markdown(): string;
  /** Picks an item of the open menu. */
  choose(index: number): void;
  /** Moves the menu's highlight (pointer hover). */
  highlight(index: number): void;
  /** Uploads pictures and puts them at the caret (or `at`). */
  insertImages(files: readonly File[], at?: number): void;
  destroy(): void;
}

const IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;
const MAX_ITEMS = 8;

/** The blocks whose label, id or keywords contain the query. */
export function filterBlocks(blocks: readonly BlockChoice[], query: string): BlockChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...blocks];
  return blocks.filter((block) =>
    [block.label, block.id, block.keywords ?? ''].some((text) => text.toLowerCase().includes(q)),
  );
}

/** Turns the range the trigger covers into a block. */
export function applyBlock(editor: Editor, range: Range, id: BlockId): boolean {
  const chain = editor.chain().focus().deleteRange(range);
  switch (id) {
    case 'paragraph':
      return chain.setParagraph().run();
    case 'heading1':
      return chain.setHeading({ level: 1 }).run();
    case 'heading2':
      return chain.setHeading({ level: 2 }).run();
    case 'heading3':
      return chain.setHeading({ level: 3 }).run();
    case 'bulletList':
      return chain.toggleBulletList().run();
    case 'orderedList':
      return chain.toggleOrderedList().run();
    case 'blockquote':
      return chain.toggleBlockquote().run();
    case 'codeBlock':
      return chain.toggleCodeBlock().run();
    case 'table':
      return chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    case 'horizontalRule':
      return chain.setHorizontalRule().run();
    case 'image':
      return chain.run();
  }
}

/** `[Title](#/knowledge/<id>)`: the link the server records as a backlink. */
export function insertDocLink(editor: Editor, range: Range, doc: { id: string; title: string }) {
  return editor
    .chain()
    .focus()
    .insertContentAt(range, [
      { type: 'text', text: doc.title, marks: [{ type: 'link', attrs: { href: `#/knowledge/${doc.id}` } }] },
      { type: 'text', text: ' ' },
    ])
    .run();
}

// ── Placeholder and uploads ─────────────────────────────────

const placeholderKey = new PluginKey('ghPlaceholder');

function placeholderPlugin(text: string) {
  return new Plugin({
    key: placeholderKey,
    props: {
      decorations(state: EditorState) {
        const { doc } = state;
        const first = doc.firstChild;
        if (!text || doc.childCount !== 1 || !first?.isTextblock || first.content.size) return null;
        return DecorationSet.create(doc, [
          Decoration.node(0, first.nodeSize, { class: 'is-editor-empty', 'data-placeholder': text }),
        ]);
      },
    },
  });
}

const uploadKey = new PluginKey<DecorationSet>('ghUploads');

/** Marks where pictures are uploading, so they land there even if the text moved meanwhile. */
function uploadPlugin(label: string) {
  return new Plugin<DecorationSet>({
    key: uploadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        let next = set.map(tr.mapping, tr.doc);
        const meta = tr.getMeta(uploadKey) as { add?: { id: string; pos: number }; remove?: string } | undefined;
        if (meta?.add) {
          const widget = document.createElement('span');
          widget.className = 'kb-uploading';
          widget.textContent = label;
          next = next.add(tr.doc, [Decoration.widget(meta.add.pos, widget, { id: meta.add.id })]);
        }
        if (meta?.remove) next = next.remove(next.find(undefined, undefined, (spec) => spec.id === meta.remove));
        return next;
      },
    },
    props: {
      decorations(state) {
        return uploadKey.getState(state);
      },
    },
  });
}

function uploadPosition(state: EditorState, id: string): number | null {
  const found = uploadKey.getState(state)?.find(undefined, undefined, (spec) => spec.id === id);
  return found?.length ? found[0]!.from : null;
}

// ── Suggestions ─────────────────────────────────────────────

interface Menu {
  props: SuggestionProps<SuggestionChoice, SuggestionChoice> | null;
  active: number;
}

export function createDocEditor(options: DocEditorOptions): DocEditor {
  let open: { kind: SuggestionKind; menu: Menu } | null = null;
  let uploads = 0;

  const caret = (props: SuggestionProps<SuggestionChoice, SuggestionChoice>): DOMRect | null => {
    try {
      return props.clientRect?.() ?? null;
    } catch {
      return null;
    }
  };

  const report = () => {
    if (!open?.menu.props) return options.onSuggest(null);
    const { props, active } = open.menu;
    options.onSuggest({
      kind: open.kind,
      query: props.query,
      items: props.items,
      active,
      loading: props.loading,
      rect: caret(props),
    });
  };

  /** One trigger's menu: it remembers the highlight, and the keys move and pick. */
  function renderer(kind: SuggestionKind): SuggestionOptions<SuggestionChoice, SuggestionChoice>['render'] {
    return () => {
      const menu: Menu = { props: null, active: 0 };
      const show = (props: SuggestionProps<SuggestionChoice, SuggestionChoice>) => {
        menu.props = props;
        if (menu.active >= props.items.length) menu.active = 0;
        open = { kind, menu };
        report();
      };
      return {
        onStart: (props) => {
          menu.active = 0;
          show(props);
        },
        onUpdate: show,
        onExit: () => {
          menu.props = null;
          if (open?.menu === menu) open = null;
          report();
        },
        onKeyDown: ({ event }: SuggestionKeyDownProps) => {
          const items = menu.props?.items ?? [];
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            if (!items.length) return true;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            menu.active = (menu.active + step + items.length) % items.length;
            report();
            return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') {
            const item = items[menu.active];
            if (!item || !menu.props) return false;
            menu.props.command(item);
            return true;
          }
          return false;
        },
      };
    };
  }

  const blockMenu = Extension.create({
    name: 'ghBlocks',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionChoice, SuggestionChoice>({
          editor: this.editor,
          pluginKey: new PluginKey('ghBlockMenu'),
          char: '/',
          items: ({ query }) => filterBlocks(options.blocks, query),
          command: ({ editor, range, props }) => {
            const id = (props as BlockChoice).id;
            applyBlock(editor, range, id);
            if (id === 'image') options.requestImage();
          },
          render: renderer('block'),
        }),
      ];
    },
  });

  const docMenu = Extension.create({
    name: 'ghDocLinks',
    addProseMirrorPlugins() {
      return [
        Suggestion<SuggestionChoice, SuggestionChoice>({
          editor: this.editor,
          pluginKey: new PluginKey('ghDocMenu'),
          char: '[[',
          allowSpaces: true,
          allowedPrefixes: null,
          debounce: 150,
          items: async ({ query, signal }) => (await options.findDocs(query, signal)).slice(0, MAX_ITEMS),
          command: ({ editor, range, props }) => {
            insertDocLink(editor, range, props as DocChoice);
          },
          render: renderer('doc'),
        }),
      ];
    },
  });

  const placeholder = Extension.create({
    name: 'ghPlaceholder',
    addProseMirrorPlugins() {
      return [placeholderPlugin(options.placeholder ?? ''), uploadPlugin(options.uploadingLabel ?? '')];
    },
  });

  function insertImages(files: readonly File[], at?: number) {
    const pictures = files.filter((file) => IMAGE.test(file.type));
    for (const file of pictures) {
      const id = `upload-${(uploads += 1)}`;
      const view = editor.view;
      const pos = at ?? view.state.selection.from;
      view.dispatch(view.state.tr.setMeta(uploadKey, { add: { id, pos } }));
      void options
        .uploadImage(file)
        .catch(() => null)
        .then((src) => {
          if (editor.isDestroyed) return;
          const where = uploadPosition(editor.state, id);
          editor.view.dispatch(editor.state.tr.setMeta(uploadKey, { remove: id }));
          if (src && where !== null) {
            editor
              .chain()
              .insertContentAt(where, { type: 'image', attrs: { src, alt: file.name.replace(/\.[^.]+$/, '') } })
              .run();
          }
        });
    }
    return pictures.length > 0;
  }

  const filesOf = (list: FileList | null | undefined) => Array.from(list ?? []);

  const editor = new Editor({
    element: options.element,
    content: markdownToEditorHtml(options.markdown),
    extensions: [
      ...knowledgeEditorExtensions({
        mentionSuggestion: {
          char: '@',
          debounce: 150,
          items: async ({ query, signal }) =>
            (await options.findMembers(query, signal)).slice(0, MAX_ITEMS).map((member) => ({ ...member })),
          render: renderer('mention'),
          command: ({ editor: target, range, props }) => {
            const member = props as unknown as MemberChoice;
            target
              .chain()
              .focus()
              .insertContentAt(range, [
                { type: 'mention', attrs: { id: member.id, label: member.name } },
                { type: 'text', text: ' ' },
              ])
              .run();
          },
        },
      }),
      blockMenu,
      docMenu,
      placeholder,
    ],
    editorProps: {
      handlePaste: (_view: EditorView, event: ClipboardEvent) => insertImages(filesOf(event.clipboardData?.files)),
      handleDrop: (view: EditorView, event: DragEvent, _slice, moved: boolean) => {
        if (moved) return false;
        const files = filesOf(event.dataTransfer?.files);
        if (!files.some((file) => IMAGE.test(file.type))) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
        return insertImages(files, at);
      },
    },
    onUpdate: () => options.onChange?.(),
    onSelectionUpdate: () => options.onSelection?.(),
    onTransaction: () => options.onSelection?.(),
  });

  return {
    editor,
    markdown: () => tiptapJsonToMarkdown(editor.getJSON() as TiptapNode),
    choose(index) {
      const props = open?.menu.props;
      const item = props?.items[index];
      if (props && item) props.command(item);
    },
    highlight(index) {
      if (!open?.menu.props) return;
      open.menu.active = index;
      report();
    },
    insertImages: (files, at) => void insertImages(files, at),
    destroy() {
      open = null;
      editor.destroy();
    },
  };
}

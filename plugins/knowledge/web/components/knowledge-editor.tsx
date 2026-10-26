/**
 * KnowledgeEditor — Tiptap editor with Markdown canonical output.
 */

import React, { useEffect, useRef } from 'react';
import { EditorContent, useEditor, type Editor, type JSONContent } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { knowledgeEditorExtensions } from '@greenhouse/web/extension-kit';
import { markdownToEditorHtml } from '@greenhouse/web/extension-kit';
import { tiptapJsonToMarkdown } from '@greenhouse/web/extension-kit';
import { Button, toast } from '@greenhouse/web/extension-kit';
import { uploadImage } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';
import { SlashCommands, DocReference, mentionSuggestion } from './editor-suggestions';
import {
  Bold,
  Italic,
  List,
  ListOrdered,
  MessageSquareQuote as Quote,
  Code,
  Link,
  Image as ImageIcon,
  Undo,
  Redo,
} from '@greenhouse/web/extension-kit';

export interface KnowledgeEditorValue {
  markdown: string;
  json: string;
}

interface KnowledgeEditorProps {
  value: KnowledgeEditorValue;
  onChange: (value: KnowledgeEditorValue) => void;
}

/** Upload image files (COS-or-local via /api/upload) and insert them as nodes. */
async function uploadImagesToEditor(editor: Editor, files: File[], onError: (name: string) => void): Promise<void> {
  const images = files.filter((f) => f.type.startsWith('image/'));
  for (const file of images) {
    try {
      const result = await uploadImage(file);
      editor.chain().focus().setImage({ src: result.url, alt: file.name }).run();
    } catch {
      onError(file.name);
    }
  }
}

/**
 * Editor content for a doc: its Tiptap JSON when it has usable JSON, otherwise
 * the canonical Markdown parsed to HTML for ProseMirror.
 *
 * The Markdown branch is not an edge case — docs written by the agent tools, the
 * CLI importer or any other Markdown-only writer legitimately reach the editor
 * with `content_json` still `'{}'`. It has to be a real Markdown parse: whatever
 * this returns is what `onUpdate` serializes straight back over the canonical
 * `content_markdown`, so anything it fails to recognise as structure is
 * flattened to escaped literal text on the first save.
 */
function safeJsonContent(json: string, markdown: string): JSONContent | string {
  try {
    const parsed = JSON.parse(json || '{}');
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) return parsed as JSONContent;
  } catch {
    /* fallback to Markdown */
  }
  return markdownToEditorHtml(markdown);
}

export function KnowledgeEditor({ value, onChange }: KnowledgeEditorProps) {
  const t = useT();
  const editorPlaceholder = t('ext.knowledge.editorPlaceholder');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const editor = useEditor({
    // Schema extensions are shared with the server-side Markdown→JSON converter
    // (@greenhouse/knowledge-editor) so editor state and generated content_json never
    // drift. Placeholder is UI-only and stays here.
    extensions: [
      // Mention's dropdown is injected here (UI-only); its NODE stays in the shared schema.
      ...knowledgeEditorExtensions({ mentionSuggestion }),
      Placeholder.configure({ placeholder: editorPlaceholder }),
      SlashCommands,
      DocReference,
    ],
    content: safeJsonContent(value.json, value.markdown),
    editorProps: {
      // Paste/drop an image → upload → insert (COS-or-local via /api/upload).
      handlePaste: (_view, event) => {
        const files = Array.from(event.clipboardData?.files ?? []);
        if (editor && files.some((f) => f.type.startsWith('image/'))) {
          void uploadImagesToEditor(editor, files, (name) =>
            toast(t('ext.knowledge.imageUploadFailed', { name }), 'error'),
          );
          return true;
        }
        return false;
      },
      handleDrop: (_view, event) => {
        const files = Array.from((event as DragEvent).dataTransfer?.files ?? []);
        if (editor && files.some((f) => f.type.startsWith('image/'))) {
          event.preventDefault();
          void uploadImagesToEditor(editor, files, (name) =>
            toast(t('ext.knowledge.imageUploadFailed', { name }), 'error'),
          );
          return true;
        }
        return false;
      },
      attributes: {
        class:
          `prose-base min-h-[360px] px-4 py-3 max-w-none text-sm text-fg focus:outline-none [&_p.is-editor-empty:first-child::before]:text-fg-faint [&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_p.is-editor-empty:first-child::before]:float-left [&_p.is-editor-empty:first-child::before]:h-0 [&_p.is-editor-empty:first-child::before]:pointer-events-none ` +
          // Tables/images are schema nodes now — give them visible structure.
          '[&_table]:border-collapse [&_table]:my-2 [&_th]:border [&_td]:border [&_th]:border-edge [&_td]:border-edge [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:bg-surface-sunken [&_img]:max-w-full [&_img]:rounded-sm',
      },
    },
    onUpdate: ({ editor: current }) => {
      const json = current.getJSON();
      onChange({ json: JSON.stringify(json), markdown: tiptapJsonToMarkdown(json) });
    },
  });

  useEffect(() => {
    // isDestroyed guard: under React StrictMode the first editor is torn down and
    // remounted, and reading `.commands` on a destroyed editor throws.
    if (!editor || editor.isDestroyed) return;
    const currentJson = JSON.stringify(editor.getJSON());
    if (currentJson === value.json) return;
    editor.commands.setContent(safeJsonContent(value.json, value.markdown), { emitUpdate: false });
  }, [editor, value.json, value.markdown]);

  const setLink = () => {
    if (!editor) return;
    const previousUrl = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL', previousUrl || 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  const toolbarButton = (active: boolean) => (active ? 'bg-primary-subtle text-primary-fg-strong' : '');
  const inTable = !!editor?.isActive('table');

  return (
    // No `overflow-hidden` on this shell: it makes the box a scroll container,
    // which is exactly what stops the toolbar below from sticking to the page's
    // scrollport. The corners are rounded on the children instead.
    <div className="border border-edge rounded-md bg-surface-raised">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (editor && files.length)
            void uploadImagesToEditor(editor, files, (name) =>
              toast(t('ext.knowledge.imageUploadFailed', { name }), 'error'),
            );
          e.target.value = '';
        }}
      />
      {/* Sticky so the formatting controls stay reachable while writing a long
          doc. `top-0` is relative to the editor page's scroll container. */}
      <div className="sticky top-0 z-10 flex items-center gap-1 flex-wrap px-2 py-2 border-b border-edge bg-surface-sunken rounded-t-md">
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('bold'))}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title={t('ext.knowledge.bold')}
        >
          <Bold size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('italic'))}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title={t('ext.knowledge.italic')}
        >
          <Italic size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('bulletList'))}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          title={t('ext.knowledge.bulletList')}
        >
          <List size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('orderedList'))}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          title={t('ext.knowledge.orderedList')}
        >
          <ListOrdered size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('blockquote'))}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          title={t('ext.knowledge.quote')}
        >
          <Quote size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('codeBlock'))}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          title={t('ext.knowledge.codeBlock')}
        >
          <Code size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('link'))}
          onClick={setLink}
          title={t('ext.knowledge.link')}
        >
          <Link size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => fileInputRef.current?.click()}
          title={t('ext.knowledge.image')}
        >
          <ImageIcon size={14} />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => editor?.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}
          title={t('ext.knowledge.insertTable')}
        >
          ⊞
        </Button>
        {inTable && (
          <>
            <div className="w-px h-5 bg-edge mx-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => editor?.chain().focus().addRowAfter().run()}
              title={t('ext.knowledge.addRow')}
            >
              +{t('ext.knowledge.rowShort')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => editor?.chain().focus().addColumnAfter().run()}
              title={t('ext.knowledge.addColumn')}
            >
              +{t('ext.knowledge.columnShort')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => editor?.chain().focus().deleteRow().run()}
              title={t('ext.knowledge.deleteRow')}
            >
              −{t('ext.knowledge.rowShort')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => editor?.chain().focus().deleteColumn().run()}
              title={t('ext.knowledge.deleteColumn')}
            >
              −{t('ext.knowledge.columnShort')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => editor?.chain().focus().deleteTable().run()}
              title={t('ext.knowledge.deleteTable')}
            >
              ✕{t('ext.knowledge.tableShort')}
            </Button>
          </>
        )}
        <div className="w-px h-5 bg-edge mx-1" />
        <Button
          size="sm"
          variant="ghost"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 1 }).run()}
          className={toolbarButton(!!editor?.isActive('heading', { level: 1 }))}
        >
          H1
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 2 }).run()}
          className={toolbarButton(!!editor?.isActive('heading', { level: 2 }))}
        >
          H2
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => editor?.chain().focus().toggleHeading({ level: 3 }).run()}
          className={toolbarButton(!!editor?.isActive('heading', { level: 3 }))}
        >
          H3
        </Button>
        <div className="flex-1" />
        <Button
          size="icon"
          variant="ghost"
          onClick={() => editor?.chain().focus().undo().run()}
          title={t('ext.knowledge.undo')}
        >
          <Undo size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => editor?.chain().focus().redo().run()}
          title={t('ext.knowledge.redo')}
        >
          <Redo size={14} />
        </Button>
      </div>
      {/* The shell no longer clips, so wide content (tables, code) scrolls here
          instead of spilling past the border — and this box is a sibling of the
          toolbar, so it doesn't capture its sticky positioning. */}
      <div className="overflow-x-auto rounded-b-md">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}

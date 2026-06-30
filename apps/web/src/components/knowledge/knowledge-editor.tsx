/**
 * KnowledgeEditor — Tiptap editor with Markdown canonical output.
 */

import React, { useEffect } from 'react';
import { EditorContent, useEditor, type JSONContent } from '@tiptap/react';
import Placeholder from '@tiptap/extension-placeholder';
import { knowledgeEditorExtensions } from '@greenhouse/knowledge-editor/extensions';
import { tiptapJsonToMarkdown } from '@greenhouse/knowledge-editor/serialize';
import { Button } from '../ui';
import { Bold, Italic, List, ListOrdered, MessageSquareQuote as Quote, Code, Link, Undo, Redo } from '../../lib/icons';

export interface KnowledgeEditorValue {
  markdown: string;
  json: string;
}

interface KnowledgeEditorProps {
  value: KnowledgeEditorValue;
  onChange: (value: KnowledgeEditorValue) => void;
  placeholder?: string;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function markdownToBasicHtml(markdown: string): string {
  if (!markdown.trim()) return '';
  const lines = markdown.split('\n');
  const html: string[] = [];
  let listType: 'ul' | 'ol' | null = null;

  const closeList = () => {
    if (listType) {
      html.push(`</${listType}>`);
      listType = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      html.push(`<h${level}>${escapeHtml(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      if (listType !== 'ul') {
        closeList();
        html.push('<ul>');
        listType = 'ul';
      }
      html.push(`<li>${escapeHtml(bullet[1])}</li>`);
      continue;
    }
    const ordered = /^\d+\.\s+(.+)$/.exec(line);
    if (ordered) {
      if (listType !== 'ol') {
        closeList();
        html.push('<ol>');
        listType = 'ol';
      }
      html.push(`<li>${escapeHtml(ordered[1])}</li>`);
      continue;
    }
    const quote = /^>\s+(.+)$/.exec(line);
    if (quote) {
      closeList();
      html.push(`<blockquote><p>${escapeHtml(quote[1])}</p></blockquote>`);
      continue;
    }
    closeList();
    html.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeList();
  return html.join('\n');
}

function safeJsonContent(json: string, markdown: string): JSONContent | string {
  try {
    const parsed = JSON.parse(json || '{}');
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) return parsed as JSONContent;
  } catch {
    /* fallback to Markdown */
  }
  return markdownToBasicHtml(markdown);
}

export function KnowledgeEditor({ value, onChange, placeholder = 'Write team knowledge…' }: KnowledgeEditorProps) {
  const editor = useEditor({
    // Schema extensions are shared with the server-side Markdown→JSON converter
    // (@greenhouse/knowledge-editor) so editor state and generated content_json never
    // drift. Placeholder is UI-only and stays here.
    extensions: [...knowledgeEditorExtensions(), Placeholder.configure({ placeholder })],
    content: safeJsonContent(value.json, value.markdown),
    editorProps: {
      attributes: {
        class:
          'prose-base min-h-[360px] max-w-none px-4 py-3 text-sm text-fg focus:outline-none [&_p.is-editor-empty:first-child::before]:text-fg-faint [&_p.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_p.is-editor-empty:first-child::before]:float-left [&_p.is-editor-empty:first-child::before]:h-0 [&_p.is-editor-empty:first-child::before]:pointer-events-none ' +
          // Tables/images are schema nodes now — give them visible structure.
          '[&_table]:border-collapse [&_table]:my-2 [&_th]:border [&_td]:border [&_th]:border-edge [&_td]:border-edge [&_th]:px-2 [&_td]:px-2 [&_th]:py-1 [&_td]:py-1 [&_th]:bg-surface-sunken [&_img]:max-w-full [&_img]:rounded-md',
      },
    },
    onUpdate: ({ editor: current }) => {
      const json = current.getJSON();
      onChange({ json: JSON.stringify(json), markdown: tiptapJsonToMarkdown(json) });
    },
  });

  useEffect(() => {
    if (!editor) return;
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

  return (
    <div className="border border-edge rounded-lg bg-surface-raised overflow-hidden">
      <div className="flex items-center gap-1 flex-wrap px-2 py-2 border-b border-edge bg-surface-sunken">
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('bold'))}
          onClick={() => editor?.chain().focus().toggleBold().run()}
          title="Bold"
        >
          <Bold size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('italic'))}
          onClick={() => editor?.chain().focus().toggleItalic().run()}
          title="Italic"
        >
          <Italic size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('bulletList'))}
          onClick={() => editor?.chain().focus().toggleBulletList().run()}
          title="Bullet list"
        >
          <List size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('orderedList'))}
          onClick={() => editor?.chain().focus().toggleOrderedList().run()}
          title="Ordered list"
        >
          <ListOrdered size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('blockquote'))}
          onClick={() => editor?.chain().focus().toggleBlockquote().run()}
          title="Quote"
        >
          <Quote size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('codeBlock'))}
          onClick={() => editor?.chain().focus().toggleCodeBlock().run()}
          title="Code block"
        >
          <Code size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className={toolbarButton(!!editor?.isActive('link'))}
          onClick={setLink}
          title="Link"
        >
          <Link size={14} />
        </Button>
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
        <Button size="icon" variant="ghost" onClick={() => editor?.chain().focus().undo().run()} title="Undo">
          <Undo size={14} />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => editor?.chain().focus().redo().run()} title="Redo">
          <Redo size={14} />
        </Button>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

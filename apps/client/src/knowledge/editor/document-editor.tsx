'use dom';
import { createEditorSuggestions } from './suggestions';
/** Classic editor schema/Markdown behavior, isolated from the native graph. */
import React, { useRef, useEffect, useState } from 'react';
import { Editor } from '@tiptap/core';
import { knowledgeEditorExtensions } from './extensions';
import { markdownToEditorHtml } from './md-html';
import { tiptapJsonToMarkdown } from './serialize';
export default function DocumentEditor({
  markdown,
  json,
  onChange,
  onImage,
  onSearchDocs,
  onUsers,
  onLink,
  labels,
}: {
  markdown: string;
  json: string;
  onChange: (markdown: string, json: string) => void;
  onImage: (file: File) => Promise<string | null>;
  onSearchDocs: (query: string) => Promise<{ id: string; title: string; slug: string }[]>;
  onUsers: () => Promise<{ id: string; nickname: string; email?: string }[]>;
  onLink: (previous: string) => Promise<string | null>;
  labels: string[];
  dom?: import('expo/dom').DOMProps;
}) {
  const pick = useRef<HTMLInputElement>(null);
  const instanceRef = useRef<Editor | null>(null);
  const upload = async (files: File[]) => {
    for (const file of files.filter((f) => f.type.startsWith('image/'))) {
      const url = await onImage(file);
      if (url) instanceRef.current?.chain().focus().setImage({ src: url, alt: file.name }).run();
    }
  };
  let content: object | string = markdownToEditorHtml(markdown);
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed?.content)) content = parsed;
  } catch {
    /* canonical Markdown fallback */
  }
  const mount = useRef<HTMLDivElement>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  useEffect(() => {
    const suggestions = createEditorSuggestions((params) => onSearchDocs(params.search ?? ''), onUsers);
    const instance = new Editor({
      element: mount.current!,
      extensions: [
        ...knowledgeEditorExtensions({ mentionSuggestion: suggestions.mentionSuggestion }),
        suggestions.SlashCommands,
        suggestions.DocReference,
      ],
      content,
      editorProps: {
        attributes: { 'aria-label': labels[0], role: 'textbox', 'aria-multiline': 'true' },
        handlePaste: (_view, e) => {
          const files = Array.from(e.clipboardData?.files ?? []);
          if (!files.some((f) => f.type.startsWith('image/'))) return false;
          void upload(files);
          return true;
        },
        handleDrop: (_view, e) => {
          const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
          if (!files.some((f) => f.type.startsWith('image/'))) return false;
          e.preventDefault();
          void upload(files);
          return true;
        },
      },
      onUpdate: ({ editor: current }) => {
        const value = current.getJSON();
        onChange(tiptapJsonToMarkdown(value), JSON.stringify(value));
      },
    });
    instanceRef.current = instance;
    setEditor(instance);
    return () => {
      instanceRef.current = null;
      instance.destroy();
    };
    // A new document mounts a new editor; draft changes must not reset selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="gh-editor">
      {editor ? (
        <div className="gh-editor-toolbar">
          {(['bold', 'italic', 'bulletList', 'orderedList', 'blockquote', 'codeBlock'] as const).map((kind, i) => (
            <button
              key={kind}
              type="button"
              aria-label={labels[i + 1]}
              aria-pressed={editor.isActive(kind)}
              onClick={() => {
                const chain = editor.chain().focus();
                if (kind === 'bold') chain.toggleBold().run();
                if (kind === 'italic') chain.toggleItalic().run();
                if (kind === 'bulletList') chain.toggleBulletList().run();
                if (kind === 'orderedList') chain.toggleOrderedList().run();
                if (kind === 'blockquote') chain.toggleBlockquote().run();
                if (kind === 'codeBlock') chain.toggleCodeBlock().run();
              }}
            >
              <span aria-hidden="true">{['B', 'I', '•', '1.', '❝', '⌘'][i]}</span>
            </button>
          ))}
          <button onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
          <button onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}>
            {labels[7]}
          </button>
          <button
            aria-label={labels[11]}
            onClick={() =>
              void (async () => {
                const url = await onLink(String(editor.getAttributes('link').href ?? ''));
                if (url === null) return;
                if (!url) editor.chain().focus().extendMarkRange('link').unsetLink().run();
                else editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
              })()
            }
          >
            <span aria-hidden="true">↗</span>
          </button>
          <button onClick={() => pick.current?.click()}>{labels[8]}</button>
          <button aria-label={labels[9]} onClick={() => editor.chain().focus().undo().run()}>
            <span aria-hidden="true">↶</span>
          </button>
          <button aria-label={labels[10]} onClick={() => editor.chain().focus().redo().run()}>
            <span aria-hidden="true">↷</span>
          </button>
          <input
            ref={pick}
            hidden
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => void upload(Array.from(e.target.files ?? []))}
          />
        </div>
      ) : null}
      <div ref={mount} />
    </div>
  );
}

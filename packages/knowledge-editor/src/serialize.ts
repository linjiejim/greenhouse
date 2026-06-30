/**
 * Tiptap (ProseMirror) JSON → canonical Markdown serialization.
 *
 * The inverse of markdown.ts — lives in this package so both directions of the
 * Markdown ⇄ content_json round-trip share one schema and one home (it was
 * previously handwritten inside the web editor component, where it dropped
 * tables/images and escaped text so aggressively that "GH-Max" became
 * "GH\-Max"; audit 2026-06-10 defect #5).
 *
 * Escaping philosophy: escape the few characters that are markdown triggers
 * anywhere inline (\ ` * _ [), plus block-syntax triggers only where they
 * actually matter — at the start of a line. Plain prose like "GH-Max",
 * "v1.0" or "(2026)" must pass through untouched.
 */

/** Minimal shape of a Tiptap/ProseMirror JSON node (kept dependency-free). */
export interface TiptapNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  content?: TiptapNode[];
}

// ─── Escaping ────────────────────────────────────────────

/** Characters that can trigger markdown syntax anywhere inside a line. */
function escapeInline(text: string): string {
  return text.replace(/[\\`*_[]/g, '\\$&');
}

/**
 * Escape block-syntax triggers at the start of a line: headings (#),
 * blockquotes (>), list bullets (- + followed by space) and ordered-list
 * numbers ("1. " / "1) ").
 */
function escapeLineStart(line: string): string {
  // Ordered lists: the escapable character is the punctuation, not the digit
  // ("1\. text" — "\1" would render as a literal backslash).
  const ordered = /^(\s{0,3})(\d+)([.)])(\s)/.exec(line);
  if (ordered) return `${ordered[1]}${ordered[2]}\\${ordered[3]}${ordered[4]}${line.slice(ordered[0].length)}`;
  return line.replace(/^(\s{0,3})(#{1,6}\s|>\s?|[-+]\s)/, (_m, indent: string, trigger: string) => {
    return `${indent}\\${trigger}`;
  });
}

function escapeParagraphLines(text: string): string {
  return text.split('\n').map(escapeLineStart).join('\n');
}

// ─── Inline rendering ────────────────────────────────────

function renderTextMarks(text: string, marks?: TiptapNode['marks']): string {
  // Inline code is emitted raw (backticks delimit it; inner escapes would show).
  const isCode = (marks ?? []).some((m) => m.type === 'code');
  let out = isCode ? text : escapeInline(text);
  for (const mark of marks ?? []) {
    if (mark.type === 'bold') out = `**${out}**`;
    if (mark.type === 'italic') out = `*${out}*`;
    if (mark.type === 'code') out = `\`${out}\``;
    if (mark.type === 'link') out = `[${out}](${String(mark.attrs?.href || '')})`;
  }
  return out;
}

/** Raw text content of a subtree (for code blocks — no escaping at all). */
function rawText(node: TiptapNode): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(rawText).join('');
}

// ─── Tables ──────────────────────────────────────────────

/** A table cell rendered as single-line GFM cell content. */
function cellToMarkdown(cell: TiptapNode): string {
  const inner = (cell.content ?? [])
    .map((child) => nodeToMarkdown(child, 0))
    .join(' ')
    .replace(/\n+/g, ' ') // GFM cells are single-line
    .trim();
  return inner.replace(/\|/g, '\\|');
}

function tableToMarkdown(table: TiptapNode): string {
  const rows = (table.content ?? []).filter((r) => r.type === 'tableRow');
  if (rows.length === 0) return '';

  const renderRow = (row: TiptapNode) => {
    const cells = (row.content ?? []).map(cellToMarkdown);
    return `| ${cells.join(' | ')} |`;
  };

  // GFM requires a header row — use the first row (Tiptap marks it with
  // tableHeader cells when it came from markdown/HTML with <th>).
  const [head, ...body] = rows;
  const columnCount = (head.content ?? []).length || 1;
  const lines = [renderRow(head), `| ${Array.from({ length: columnCount }, () => '---').join(' | ')} |`];
  for (const row of body) lines.push(renderRow(row));
  return `${lines.join('\n')}\n`;
}

// ─── Block rendering ─────────────────────────────────────

function nodeToMarkdown(node: TiptapNode, depth = 0): string {
  const children = node.content ?? [];
  const inner = children.map((child) => nodeToMarkdown(child, depth)).join('');

  switch (node.type) {
    case 'doc':
      return children
        .map((child) => nodeToMarkdown(child, depth))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    case 'text':
      return renderTextMarks(node.text || '', node.marks);
    case 'paragraph':
      return `${escapeParagraphLines(inner)}\n`;
    case 'heading':
      return `${'#'.repeat(Number(node.attrs?.level || 2))} ${inner}\n`;
    case 'bulletList':
      return `${children.map((child) => nodeToMarkdown(child, depth + 1)).join('')}\n`;
    case 'orderedList':
      return `${children
        .map((child, index) =>
          nodeToMarkdown({ ...child, attrs: { ...(child.attrs || {}), orderIndex: index + 1 } }, depth + 1),
        )
        .join('')}\n`;
    case 'listItem': {
      const prefix = typeof node.attrs?.orderIndex === 'number' ? `${node.attrs.orderIndex}. ` : '- ';
      const content = children
        .map((child) => nodeToMarkdown(child, depth))
        .join('')
        .trim();
      return `${'  '.repeat(Math.max(0, depth - 1))}${prefix}${content}\n`;
    }
    case 'blockquote':
      return `${inner
        .trim()
        .split('\n')
        .map((line) => `> ${line}`)
        .join('\n')}\n`;
    case 'codeBlock': {
      const language = typeof node.attrs?.language === 'string' ? node.attrs.language : '';
      return `\`\`\`${language}\n${rawText(node)}\n\`\`\`\n`;
    }
    case 'table':
      return `${tableToMarkdown(node)}`;
    case 'image': {
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '');
      const title = node.attrs?.title ? ` "${String(node.attrs.title)}"` : '';
      return src ? `![${alt}](${src}${title})\n` : '';
    }
    case 'hardBreak':
      return '\n';
    case 'horizontalRule':
      return '\n---\n';
    default:
      return inner;
  }
}

/** Serialize a Tiptap JSON document to canonical Markdown. */
export function tiptapJsonToMarkdown(json: TiptapNode): string {
  return nodeToMarkdown(json);
}

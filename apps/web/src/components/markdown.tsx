/**
 * Markdown rendering component using marked.
 *
 * Features:
 * - Two prose variants: `prose-base` (wiki/docs) and `prose-compact` (chat/agent)
 * - Lightweight syntax highlighting for code blocks (JS/TS/Python/CSS/SQL/HTML)
 * - Responsive table wrappers that preserve native table layout
 * - Image lightbox: click any image to open the shared, dismissible media preview
 */

import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { marked } from 'marked';
import { parseEntityUrl } from '@greenhouse/types/entity-links';
import { apiUrl } from '../lib/api-base';
import { isDesktop } from '../lib/desktop/bridge';
import { sanitizeHtml } from '../lib/utils';
import { downloadCsv, markdownTableToCsv, markdownTableToTsv, safeCsvFilename } from '../lib/csv-export';
import { openEntityPeek } from '../stores/entity-peek-store';
import { isSidePaneAvailable, openSidePane } from '../stores/side-pane-store';
import { useT } from '../lib/i18n';
import { MediaPreviewDialog } from './media-preview-dialog';
import { Dialog, toast } from './ui';

// Configure marked
marked.setOptions({
  breaks: true,
  gfm: true,
});

/**
 * Pre-process markdown to fix rendering issues.
 * Handles:
 * - Broken image URLs with template variables (${...}/api/upload/... → /api/upload/...)
 * - Double colons in separator rows (::---: → :---:)
 * - Missing/extra pipes
 * - Inconsistent column counts in table rows
 * - Single-tilde ranges getting parsed as strikethrough (10~15 → 10\~15)
 */
export function fixMarkdownTables(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Fix separator rows: |:---:|::---:|:----:| → |:---:|:---:|:---:|
    if (/^\s*\|([:\-\s|]+)\|\s*$/.test(line)) {
      // Fix double colons: ::--- → :---
      line = line.replace(/::/g, ':');
      // Fix separators with too few dashes: |:| → |:---:|
      line = line.replace(/\|\s*:?\s*:?\s*\|/g, (match) => {
        if (!/---/.test(match)) {
          return '| --- |';
        }
        return match;
      });
    }

    // Fix table rows with ～ vs ~ inconsistency (CJK tilde)
    // and ensure table cells with strikethrough don't break parsing
    if (/^\s*\|/.test(line) && /\|\s*$/.test(line)) {
      // Normalize full-width characters in table cells
      line = line.replace(/～/g, '~');
    }

    result.push(line);
  }

  let text = result.join('\n');

  // Fix broken image URLs: strip template variable prefixes like ${convenienceBaseUrl}
  // Pattern: ![alt](${...}/api/upload/...) → ![alt](/api/upload/...)
  text = text.replace(/(!\[[^\]]*\])\(\$\{[^}]*\}(\/api\/upload\/[^)]+)\)/g, '$1($2)');

  // Fix single-tilde ranges being parsed as GFM strikethrough.
  // When text contains two or more single `~` (e.g., "10~15cm（4~6英寸）"),
  // marked treats the content between them as <del>. Escape non-paired tildes
  // that appear in numeric/range contexts: digit~digit or CJK~CJK.
  // Don't touch double-tilde `~~` (legitimate strikethrough).
  text = text.replace(/(?<!~)~(?!~)/g, (match, offset) => {
    // Look at surrounding characters to decide if this is a range tilde
    const before = text[offset - 1] || '';
    const after = text[offset + 1] || '';
    // Tilde between digits, CJK characters, or letters = range, escape it
    const isRange = /[\d\w\u4e00-\u9fff\u00b0)）]/.test(before) && /[\d\w\u4e00-\u9fff(（]/.test(after);
    return isRange ? '\\~' : match;
  });

  return text;
}

// ─── Lightweight Syntax Highlighting ─────────────────────

const JS_KEYWORDS =
  /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|this|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|yield|void|delete|null|undefined|true|false|NaN|Infinity)\b/g;

const PY_KEYWORDS =
  /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|finally|raise|with|yield|lambda|pass|break|continue|and|or|not|in|is|None|True|False|self|print|range|len|int|str|float|list|dict|set|tuple)\b/g;

const SQL_KEYWORDS =
  /\b(SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TABLE|INTO|VALUES|SET|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|AS|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|DISTINCT|COUNT|SUM|AVG|MAX|MIN|LIKE|IN|BETWEEN|EXISTS|UNION|INDEX|PRIMARY|KEY|FOREIGN|REFERENCES|CASCADE)\b/gi;

const CSS_KEYWORDS =
  /\b(display|flex|grid|position|margin|padding|border|background|color|font|width|height|top|left|right|bottom|z-index|overflow|opacity|transition|transform|animation|none|auto|inherit|initial|absolute|relative|fixed|sticky)\b/g;

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function highlightCode(code: string, lang: string): string {
  const escaped = escapeHtml(code);
  const l = lang.toLowerCase().replace(/^language-/, '');

  // Determine which keyword set to use
  let keywords: RegExp | null = null;
  if (/^(js|javascript|jsx|ts|typescript|tsx)$/.test(l)) keywords = JS_KEYWORDS;
  else if (/^(py|python)$/.test(l)) keywords = PY_KEYWORDS;
  else if (/^(sql)$/.test(l)) keywords = SQL_KEYWORDS;
  else if (/^(css|scss|less)$/.test(l)) keywords = CSS_KEYWORDS;

  // Tokenize to avoid highlighting inside strings/comments
  // Strategy: split by strings and comments first, then highlight keywords in remaining parts
  const tokens: string[] = [];
  // Match: single-line comments, multi-line comments, strings (double, single, backtick)
  const tokenRegex = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tokenRegex.exec(escaped)) !== null) {
    // Process code before this token
    if (match.index > lastIndex) {
      tokens.push(highlightPlain(escaped.slice(lastIndex, match.index), keywords));
    }
    const tok = match[1];
    if (
      tok.startsWith('//') ||
      tok.startsWith('/*') ||
      (tok.startsWith('#') && /^(py|python|sh|bash|yaml|yml|toml|ruby|rb)$/.test(l))
    ) {
      tokens.push(`<span class="hl-comment">${tok}</span>`);
    } else if (tok.startsWith('"') || tok.startsWith("'") || tok.startsWith('`')) {
      tokens.push(`<span class="hl-string">${tok}</span>`);
    } else {
      tokens.push(tok);
    }
    lastIndex = match.index + match[0].length;
  }
  // Remaining code after last token
  if (lastIndex < escaped.length) {
    tokens.push(highlightPlain(escaped.slice(lastIndex), keywords));
  }

  return tokens.join('');
}

function highlightPlain(code: string, keywords: RegExp | null): string {
  // Highlight keywords before numbers. Doing this in the opposite order lets
  // JS's `class` keyword match the class attribute of an inserted number span.
  let result = code;
  if (keywords) {
    result = result.replace(keywords, '<span class="hl-keyword">$1</span>');
  }
  result = result.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-number">$1</span>');
  return result;
}

/**
 * Post-process marked HTML to add syntax highlighting to code blocks.
 */
function addSyntaxHighlighting(html: string): string {
  // Match <code class="language-xxx">...</code> inside <pre>
  return html.replace(/<pre><code(?: class="language-(\w+)")?>([\s\S]*?)<\/code><\/pre>/g, (_match, lang, code) => {
    const language = lang || '';
    // Unescape HTML entities that marked already escaped, then re-process
    const unescaped = code
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");
    const highlighted = highlightCode(unescaped, language);
    const langLabel = language ? `<span class="hl-lang">${language}</span>` : '';
    return `<pre class="hl-pre">${langLabel}<code>${highlighted}</code></pre>`;
  });
}

// ─── Markdown HTML Sanitizer ─────────────────────────────

/**
 * Tags safe in markdown context — broader than the generic sanitizeHtml
 * because markdown legitimately produces block elements, tables, lists, etc.
 * Strips: script, iframe, object, embed, form, input, textarea, select, style.
 */
const MD_SAFE_TAGS = new Set([
  // Inline
  'b',
  'i',
  'u',
  'em',
  'strong',
  'a',
  'br',
  'span',
  'sub',
  'sup',
  'mark',
  'code',
  's',
  'del',
  'ins',
  'small',
  'abbr',
  'kbd',
  // Block (from markdown)
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'ul',
  'ol',
  'li',
  'hr',
  'div',
  // Table
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
  // Media
  'img',
]);
const MD_SAFE_ATTRS = new Set([
  'href',
  'target',
  'rel',
  'class',
  'style',
  'title',
  'id',
  'src',
  'alt',
  'width',
  'height',
  'loading',
  'colspan',
  'rowspan',
]);

/**
 * Where a plain navigating link should land.
 *
 * `new-window` is for chat: a transcript is a place you are, and following a
 * link out of it costs you the conversation you were reading. Entity links are
 * unaffected either way — they never navigate at all.
 */
export type MarkdownLinkTarget = 'in-place' | 'new-window';

/**
 * Recognise a record reference, accepting the `/projects/42` shape the
 * model sometimes writes as well as the canonical `#/projects/42`.
 *
 * Without that leniency a dropped `#` turned an in-app link into an "external"
 * one, so it opened a new tab at a path the hash router does not serve.
 */
function matchEntityHref(href: string): { ref: NonNullable<ReturnType<typeof parseEntityUrl>>; url: string } | null {
  const direct = parseEntityUrl(href);
  if (direct) return { ref: direct, url: href.trim() };
  if (href.trim().startsWith('/')) {
    const normalized = `#${href.trim()}`;
    const ref = parseEntityUrl(normalized);
    if (ref) return { ref, url: normalized };
  }
  return null;
}

function sanitizeMarkdownNode(node: Node, linkTarget: MarkdownLinkTarget): void {
  const children = Array.from(node.childNodes);
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();

      if (!MD_SAFE_TAGS.has(tag)) {
        while (el.firstChild) node.insertBefore(el.firstChild, el);
        node.removeChild(el);
        continue;
      }

      // Remove dangerous attributes (event handlers, data URIs)
      const attrs = Array.from(el.attributes);
      for (const attr of attrs) {
        if (!MD_SAFE_ATTRS.has(attr.name) && !attr.name.startsWith('data-')) {
          el.removeAttribute(attr.name);
        }
      }

      // Three kinds of link, in priority order: a record reference (opens a
      // peek), an @-mention (inert chip), or an ordinary navigating link. Only
      // the last one is ever passed through apiUrl.
      const hrefVal = (el.getAttribute('href') || '').trim();
      const entity = tag === 'a' ? matchEntityHref(hrefVal) : null;
      const isHashRoute = hrefVal.startsWith('#/');
      const isMention = hrefVal.toLowerCase().startsWith('user:');

      // Block javascript: in href/src; wrap normal URLs with apiUrl.
      for (const attrName of ['href', 'src']) {
        if (el.hasAttribute(attrName)) {
          const val = el.getAttribute(attrName) || '';
          if (val.trim().toLowerCase().startsWith('javascript:')) {
            el.setAttribute(attrName, '#');
          } else if (attrName === 'href' && entity) {
            // Kept navigable so cmd-click and "copy link" still work, even
            // though a plain click is intercepted into a peek.
            el.setAttribute('href', entity.url);
          } else if (attrName === 'href' && (isHashRoute || isMention)) {
            el.setAttribute('href', isMention ? '#' : val);
          } else {
            el.setAttribute(attrName, apiUrl(val));
          }
        }
      }

      if (tag === 'a') {
        if (entity) {
          // `href` stays the single source of truth for *which* record this is;
          // the data attributes only mark the link and carry its display label.
          el.setAttribute('class', `${el.getAttribute('class') || ''} entity-link`.trim());
          el.setAttribute('data-entity-kind', entity.ref.kind);
          el.setAttribute('data-entity-label', (el.textContent || '').trim().slice(0, 120));
        } else if (isMention) {
          el.setAttribute('class', `${el.getAttribute('class') || ''} kb-mention`.trim());
        } else if (!isHashRoute) {
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        } else if (linkTarget === 'new-window' && !isDesktop()) {
          // In-app routes open a second tab from chat so the conversation
          // survives — but only in a browser. The desktop shell has no
          // `opener:open-url` permission and blocks `target=_blank` new-window
          // requests outright, so there the same attribute is a dead click;
          // it navigates in place instead (a known, deliberate degradation).
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer');
        }
      }

      sanitizeMarkdownNode(el, linkTarget);
    }
  }
}

/**
 * Sanitize HTML output from marked parser.
 * Allows markdown block elements but strips scripts, iframes, event handlers.
 */
function sanitizeMarkdownHtml(
  html: string,
  anchors = false,
  imageRows = false,
  linkTarget: MarkdownLinkTarget = 'in-place',
  tableExportAriaLabel = 'Export table as CSV',
  tableFullscreenLabel = 'View table fullscreen',
  tableCopyLabel = 'Copy table',
  codeFullscreenLabel = 'View code fullscreen',
): string {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    sanitizeMarkdownNode(doc.body, linkTarget);
    wrapMarkdownTables(doc.body, tableExportAriaLabel, tableFullscreenLabel, tableCopyLabel);
    wrapMarkdownCodeBlocks(doc.body, codeFullscreenLabel);
    if (anchors) addHeadingAnchors(doc.body);
    if (imageRows) groupImageRuns(doc.body);
    return doc.body.innerHTML;
  } catch {
    return sanitizeHtml(html);
  }
}

// ─── Scrollable code blocks ─────────────────────────────

function createCodeFullscreenButton(document: Document, label: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute('class', 'md-code-icon-action');
  button.setAttribute('data-md-code-fullscreen', '');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);

  // Lucide Maximize2. Markdown is rendered as one sanitized HTML island, so the
  // icon is constructed here just like the table toolbar icons below.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({
    viewBox: '0 0 24 24',
    width: '14',
    height: '14',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  })) {
    svg.setAttribute(name, value);
  }
  for (const d of ['M15 3h6v6', 'm21 3-7 7', 'm3 21 7-7', 'M9 21H3v-6']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  button.appendChild(svg);
  return button;
}

function wrapMarkdownCodeBlocks(root: HTMLElement, fullscreenLabel: string): void {
  for (const pre of Array.from(root.querySelectorAll('pre.hl-pre'))) {
    if (pre.parentElement?.classList.contains('md-code-shell')) continue;
    const shell = root.ownerDocument.createElement('div');
    shell.setAttribute('class', 'md-code-shell');
    pre.parentNode?.insertBefore(shell, pre);
    shell.appendChild(pre);
    shell.appendChild(createCodeFullscreenButton(root.ownerDocument, fullscreenLabel));
  }
}

// ─── Responsive tables ──────────────────────────────────

/**
 * Keep `<table>` as a real table so columns fill the available reading width.
 * Horizontal overflow belongs to a wrapper; applying `display:block` directly
 * to the table collapses its internal table formatting context and leaves a
 * narrow, content-sized grid on wide document pages.
 */
function createTableActionButton(
  document: Document,
  action: 'export' | 'fullscreen' | 'copy',
  label: string,
): HTMLButtonElement {
  const button = document.createElement('button');
  button.setAttribute('type', 'button');
  button.setAttribute('class', 'md-table-icon-action');
  button.setAttribute(`data-md-table-${action}`, '');
  button.setAttribute('aria-label', label);
  button.setAttribute('title', label);

  // These are the Lucide Download / Maximize2 / Copy paths. The markdown body is one
  // sanitized HTML island, so React icon components cannot be mounted inside
  // each generated table toolbar without a portal per table.
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const shapes: Array<[string, Record<string, string>]> =
    action === 'copy'
      ? [
          ['rect', { x: '9', y: '9', width: '13', height: '13', rx: '2' }],
          ['path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' }],
        ]
      : action === 'export'
        ? [
            ['path', { d: 'M12 3v12' }],
            ['path', { d: 'm7 10 5 5 5-5' }],
            ['path', { d: 'M5 21h14' }],
          ]
        : [
            ['path', { d: 'M15 3h6v6' }],
            ['path', { d: 'm21 3-7 7' }],
            ['path', { d: 'm3 21 7-7' }],
            ['path', { d: 'M9 21H3v-6' }],
          ];
  for (const [tag, attributes] of shapes) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) shape.setAttribute(name, value);
    svg.appendChild(shape);
  }
  button.appendChild(svg);
  return button;
}

function wrapMarkdownTables(
  root: HTMLElement,
  exportAriaLabel: string,
  fullscreenLabel: string,
  copyLabel: string,
): void {
  for (const table of Array.from(root.querySelectorAll('table'))) {
    if (table.parentElement?.classList.contains('md-table-scroll')) continue;
    const shell = root.ownerDocument.createElement('div');
    shell.setAttribute('class', 'md-table-shell');
    const toolbar = root.ownerDocument.createElement('div');
    toolbar.setAttribute('class', 'md-table-toolbar');
    toolbar.appendChild(createTableActionButton(root.ownerDocument, 'export', exportAriaLabel));
    toolbar.appendChild(createTableActionButton(root.ownerDocument, 'fullscreen', fullscreenLabel));
    toolbar.appendChild(createTableActionButton(root.ownerDocument, 'copy', copyLabel));
    const scroll = root.ownerDocument.createElement('div');
    scroll.setAttribute('class', 'md-table-scroll');
    table.parentNode?.insertBefore(shell, table);
    shell.appendChild(toolbar);
    shell.appendChild(scroll);
    scroll.appendChild(table);
  }
}

// ─── Image rows ──────────────────────────────────────────

/** A paragraph that holds nothing but images (optionally wrapped in links). */
function isImageOnlyParagraph(el: Element): boolean {
  if (el.tagName !== 'P') return false;
  if ((el.textContent || '').trim() !== '') return false;
  const imgs = el.querySelectorAll('img');
  if (imgs.length === 0) return false;
  // Only <img>, its <a> wrapper, and the <br>s marked's `breaks` option inserts.
  return Array.from(el.children).every((child) => {
    const tag = child.tagName;
    if (tag === 'IMG' || tag === 'BR') return true;
    return tag === 'A' && child.children.length === 1 && child.children[0].tagName === 'IMG';
  });
}

/**
 * Lay consecutive images out side by side instead of stacked.
 *
 * Images arrive either as several image-only paragraphs (blank line between them) or
 * as one paragraph with `<br>`s (single newline, because marked runs with
 * `breaks: true`) — both collapse into a single flex row here, so the DOM shape no
 * longer depends on how the author spaced the Markdown.
 *
 * Applied to chat only (see the `compact` variant): document pages want images at
 * full reading width, whereas a chat transcript wants thumbnails you click to zoom.
 */
function groupImageRuns(root: HTMLElement): void {
  const blocks = Array.from(root.children);
  let i = 0;
  while (i < blocks.length) {
    if (!isImageOnlyParagraph(blocks[i])) {
      i++;
      continue;
    }
    let end = i;
    while (end + 1 < blocks.length && isImageOnlyParagraph(blocks[end + 1])) end++;

    const row = root.ownerDocument.createElement('div');
    row.setAttribute('class', 'md-image-row');
    for (let j = i; j <= end; j++) {
      // Move the <img> (keeping any <a> wrapper); the emptied <p> and its <br>s go away.
      for (const img of Array.from(blocks[j].querySelectorAll('img'))) {
        const parent = img.parentElement;
        row.appendChild(parent?.tagName === 'A' ? parent : img);
      }
    }
    root.replaceChild(row, blocks[i]);
    for (let j = i + 1; j <= end; j++) root.removeChild(blocks[j]);
    i = end + 1;
  }
}

// ─── Heading anchors ─────────────────────────────────────

/** Anchor slug for a heading. CJK is kept; everything else collapses to dashes. */
function headingSlug(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, '-')
    .replace(/(^-|-$)/g, '');
  return slug || 'section';
}

/**
 * Give every h1–h4 a unique `id`, in document order.
 *
 * Anchors live in the rendered DOM rather than being re-derived from the
 * Markdown source: a TOC that recomputes slugs from the source has to guess how
 * marked rendered each heading (`[link](url)`, `**bold**`, entities), and any
 * disagreement silently breaks the jump. Repeated heading text gets a `-2`,
 * `-3`… suffix so ids stay unique within one document.
 */
function addHeadingAnchors(root: HTMLElement): void {
  const seen = new Map<string, number>();
  for (const heading of root.querySelectorAll('h1, h2, h3, h4')) {
    const base = headingSlug(heading.textContent || '');
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    heading.setAttribute('id', count === 1 ? base : `${base}-${count}`);
  }
}

// ─── Component ───────────────────────────────────────────

interface MarkdownProps {
  content: string;
  className?: string;
  /** Use compact (tight) variant for chat/agent messages. Default is base (spacious) for wiki/docs. */
  compact?: boolean;
  /**
   * Give headings unique `id`s so a table of contents can link to and track them.
   * Off by default — ids are document-scoped, and a chat transcript renders many
   * Markdown blocks into one page where they would collide.
   */
  anchors?: boolean;
  /**
   * Where ordinary navigating links go. Chat passes `new-window` so following a
   * link never costs the reader their conversation. Record references ignore
   * this — they open a peek instead of navigating.
   */
  linkTarget?: MarkdownLinkTarget;
}

export const Markdown = React.memo(function Markdown({
  content,
  className = '',
  compact,
  anchors,
  linkTarget = 'in-place',
}: MarkdownProps) {
  const t = useT();
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const [fullscreenTableHtml, setFullscreenTableHtml] = useState<string | null>(null);
  const [fullscreenCodeHtml, setFullscreenCodeHtml] = useState<string | null>(null);

  const html = useMemo(() => {
    if (!content) return '';
    try {
      const fixed = fixMarkdownTables(content);
      const result = marked.parse(fixed);
      const parsed = typeof result === 'string' ? result : '';
      const highlighted = addSyntaxHighlighting(parsed);
      return sanitizeMarkdownHtml(
        highlighted,
        anchors,
        compact,
        linkTarget,
        t('common.exportTableCsv'),
        t('common.fullscreenTable'),
        t('common.copyTable'),
        t('common.fullscreenCode'),
      );
    } catch (_err) {
      return `<p>${sanitizeHtml(content)}</p>`;
    }
  }, [content, anchors, compact, linkTarget, t]);

  // Delegated clicks: table actions, record reference, image lightbox.
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      const codeFullscreenButton = target.closest<HTMLElement>('[data-md-code-fullscreen]');
      if (codeFullscreenButton) {
        e.preventDefault();
        const pre = codeFullscreenButton.closest('.md-code-shell')?.querySelector('pre.hl-pre');
        if (pre instanceof HTMLPreElement) setFullscreenCodeHtml(pre.outerHTML);
        return;
      }
      const exportButton = target.closest<HTMLElement>('[data-md-table-export]');
      if (exportButton) {
        e.preventDefault();
        const table = exportButton.closest('.md-table-shell')?.querySelector('table');
        if (table instanceof HTMLTableElement) {
          downloadCsv(safeCsvFilename(undefined), markdownTableToCsv(table));
        }
        return;
      }
      const fullscreenButton = target.closest<HTMLElement>('[data-md-table-fullscreen]');
      if (fullscreenButton) {
        e.preventDefault();
        const table = fullscreenButton.closest('.md-table-shell')?.querySelector('table');
        if (table instanceof HTMLTableElement) setFullscreenTableHtml(table.outerHTML);
        return;
      }
      const copyButton = target.closest<HTMLElement>('[data-md-table-copy]');
      if (copyButton) {
        e.preventDefault();
        const table = copyButton.closest('.md-table-shell')?.querySelector('table');
        if (table instanceof HTMLTableElement) {
          void navigator.clipboard.writeText(markdownTableToTsv(table)).then(
            () => toast(t('common.copied'), 'success'),
            () => toast(t('common.copyFailed'), 'error'),
          );
        }
        return;
      }
      const entityLink = target.closest<HTMLElement>('a[data-entity-kind]');
      // Modified clicks keep their native meaning (new tab / download / save-as);
      // only a plain left click becomes a peek.
      if (entityLink && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
        const ref = parseEntityUrl(entityLink.getAttribute('href') || '');
        if (ref) {
          e.preventDefault();
          const label = entityLink.getAttribute('data-entity-label') || undefined;
          // On a screen with a split (Chat), the record opens beside the
          // conversation so the composer stays usable; everywhere else it is the
          // modal peek Drawer. Asking the store rather than the route keeps the
          // one delegate working for both without knowing about either.
          if (isSidePaneAvailable()) openSidePane({ kind: 'entity', ref, label });
          else openEntityPeek({ ref, label });
          return;
        }
      }
      if (target.tagName === 'IMG') {
        e.preventDefault();
        setLightboxSrc((target as HTMLImageElement).src);
      }
    },
    [t],
  );

  const proseClass = compact ? 'prose-compact' : 'prose-base';
  return (
    <>
      <div className={`${proseClass} ${className}`} dangerouslySetInnerHTML={{ __html: html }} onClick={handleClick} />
      <MediaPreviewDialog
        open={lightboxSrc !== null}
        files={lightboxSrc ? [{ src: lightboxSrc, type: 'image' }] : []}
        onClose={() => setLightboxSrc(null)}
      />
      <Dialog
        open={fullscreenTableHtml !== null}
        onClose={() => setFullscreenTableHtml(null)}
        title={t('common.fullscreenTable')}
        size="workspace"
        noPadding
      >
        <div className="prose-base min-h-0 overflow-auto p-4 sm:p-6">
          <div className="md-table-scroll" dangerouslySetInnerHTML={{ __html: fullscreenTableHtml ?? '' }} />
        </div>
      </Dialog>
      <Dialog
        open={fullscreenCodeHtml !== null}
        onClose={() => setFullscreenCodeHtml(null)}
        title={t('common.fullscreenCode')}
        size="workspace"
        noPadding
      >
        <div
          className="md-code-fullscreen-view prose-base min-h-0 flex-1 overflow-auto p-4 sm:p-6"
          dangerouslySetInnerHTML={{ __html: fullscreenCodeHtml ?? '' }}
        />
      </Dialog>
    </>
  );
});

// \u2500\u2500\u2500 Table of contents \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export interface DocHeading {
  id: string;
  text: string;
  level: number;
}

/**
 * The headings of a rendered `<Markdown anchors />` document, read back from the
 * DOM so the TOC and the anchors it links to can never disagree.
 *
 * `contentKey` is whatever identifies the current document (usually its Markdown)
 * \u2014 it re-reads the DOM whenever that changes.
 */
export function useDocumentHeadings(ref: React.RefObject<HTMLElement | null>, contentKey: string): DocHeading[] {
  const [headings, setHeadings] = useState<DocHeading[]>([]);
  useEffect(() => {
    const root = ref.current;
    if (!root) {
      setHeadings([]);
      return;
    }
    setHeadings(
      Array.from(root.querySelectorAll<HTMLElement>('h1[id], h2[id], h3[id], h4[id]')).map((heading) => ({
        id: heading.id,
        text: heading.textContent?.trim() || '',
        level: Number(heading.tagName[1]),
      })),
    );
  }, [ref, contentKey]);
  return headings;
}

/**
 * Id of the heading the reader is currently under: the last one whose top has
 * passed the reading line near the top of the viewport.
 *
 * Deliberately not an IntersectionObserver \u2014 "which section am I in" is a
 * question about the heading *above* the fold, and a long section with its
 * heading scrolled off has no intersecting heading to report at all.
 */
export function useActiveHeading(
  scrollRef: React.RefObject<HTMLElement | null>,
  headings: DocHeading[],
): string | null {
  const [activeId, setActiveId] = useState<string | null>(null);

  useEffect(() => {
    const root = scrollRef.current;
    if (!root || headings.length === 0) {
      setActiveId(null);
      return;
    }

    let frame = 0;
    const update = () => {
      frame = 0;
      const readingLine = root.getBoundingClientRect().top + 80;
      let current = headings[0].id;
      for (const heading of headings) {
        const el = root.querySelector<HTMLElement>(`#${CSS.escape(heading.id)}`);
        if (!el) continue;
        if (el.getBoundingClientRect().top > readingLine) break;
        current = heading.id;
      }
      // Bottomed out: the last heading is the one being read, however short its
      // section is \u2014 otherwise the final entries can never light up.
      if (root.scrollTop + root.clientHeight >= root.scrollHeight - 4) {
        current = headings[headings.length - 1].id;
      }
      setActiveId(current);
    };

    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    root.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      root.removeEventListener('scroll', onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [scrollRef, headings]);

  return activeId;
}

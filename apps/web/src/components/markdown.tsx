/**
 * Markdown rendering component using marked.
 *
 * Features:
 * - Two prose variants: `prose-base` (wiki/docs) and `prose-compact` (chat/agent)
 * - Lightweight syntax highlighting for code blocks (JS/TS/Python/CSS/SQL/HTML)
 * - Image lightbox: click any image to view fullscreen
 */

import React, { useMemo, useState, useCallback } from 'react';
import { marked } from 'marked';
import { apiUrl } from '../lib/api-base';
import { sanitizeHtml } from '../lib/utils';

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
  // Highlight numbers
  let result = code.replace(/\b(\d+\.?\d*)\b/g, '<span class="hl-number">$1</span>');
  // Highlight keywords
  if (keywords) {
    result = result.replace(keywords, '<span class="hl-keyword">$1</span>');
  }
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

function sanitizeMarkdownNode(node: Node): void {
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

      // Block javascript: in href/src
      for (const attrName of ['href', 'src']) {
        if (el.hasAttribute(attrName)) {
          const val = el.getAttribute(attrName) || '';
          if (val.trim().toLowerCase().startsWith('javascript:')) {
            el.setAttribute(attrName, '#');
          } else {
            el.setAttribute(attrName, apiUrl(val));
          }
        }
      }

      // Force safe link attributes
      if (tag === 'a') {
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener noreferrer');
      }

      sanitizeMarkdownNode(el);
    }
  }
}

/**
 * Sanitize HTML output from marked parser.
 * Allows markdown block elements but strips scripts, iframes, event handlers.
 */
function sanitizeMarkdownHtml(html: string): string {
  if (!html) return '';
  try {
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
    sanitizeMarkdownNode(doc.body);
    return doc.body.innerHTML;
  } catch {
    return sanitizeHtml(html);
  }
}

// ─── Component ───────────────────────────────────────────

interface MarkdownProps {
  content: string;
  className?: string;
  /** Use compact (tight) variant for chat/agent messages. Default is base (spacious) for wiki/docs. */
  compact?: boolean;
}

export const Markdown = React.memo(function Markdown({ content, className = '', compact }: MarkdownProps) {
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const html = useMemo(() => {
    if (!content) return '';
    try {
      const fixed = fixMarkdownTables(content);
      const result = marked.parse(fixed);
      const parsed = typeof result === 'string' ? result : '';
      const highlighted = addSyntaxHighlighting(parsed);
      return sanitizeMarkdownHtml(highlighted);
    } catch (_err) {
      return `<p>${sanitizeHtml(content)}</p>`;
    }
  }, [content]);

  // Image lightbox: delegate clicks on <img> inside the markdown container
  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'IMG') {
      e.preventDefault();
      setLightboxSrc((target as HTMLImageElement).src);
    }
  }, []);

  const proseClass = compact ? 'prose-compact' : 'prose-base';
  return (
    <>
      <div className={`${proseClass} ${className}`} dangerouslySetInnerHTML={{ __html: html }} onClick={handleClick} />
      {lightboxSrc && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in cursor-zoom-out"
          onClick={() => setLightboxSrc(null)}
        >
          <img src={lightboxSrc} alt="" className="max-w-[90vw] max-h-[90vh] object-contain rounded-lg shadow-2xl" />
        </div>
      )}
    </>
  );
});

/**
 * Extract headings from markdown for TOC generation.
 */
export function extractHeadings(markdown: string): Array<{ level: number; text: string; id: string }> {
  const headings: Array<{ level: number; text: string; id: string }> = [];
  const lines = markdown.split('\n');
  for (const line of lines) {
    const match = line.match(/^(#{1,4})\s+(.+)$/);
    if (match) {
      const text = match[2].replace(/[*_`[\]]/g, '').trim();
      const id = text
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
        .replace(/(^-|-$)/g, '');
      headings.push({ level: match[1].length, text, id });
    }
  }
  return headings;
}

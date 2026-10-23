/**
 * Markdown → a small block model the three renderers share.
 *
 * Agents write sections in Markdown; PDF, Word and PowerPoint each need it as
 * their own structures, so it is parsed once (marked's lexer, no HTML) into
 * headings, paragraphs, lists, tables, code, quotes and rules with inline
 * runs (bold / italic / code / strike / link). Raw HTML is kept as plain
 * text — nothing in a report is ever interpreted as markup or fetched.
 */

import { Lexer, type Token, type Tokens } from 'marked';

export interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  strike?: boolean;
  /** Only http(s) and mailto links survive. */
  link?: string;
}

export type MdBlock =
  | { type: 'heading'; level: number; runs: InlineRun[] }
  | { type: 'paragraph'; runs: InlineRun[] }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] }
  | { type: 'table'; header: InlineRun[][]; rows: InlineRun[][][] }
  | { type: 'code'; text: string }
  | { type: 'quote'; runs: InlineRun[] }
  | { type: 'rule' };

export interface MdListItem {
  runs: InlineRun[];
  /** Nesting depth, 0 = top level (nested lists are flattened with a depth). */
  depth: number;
  ordered: boolean;
  /** 1-based number for ordered items. */
  number: number;
}

type Style = Omit<InlineRun, 'text'>;

function safeLink(href: string | undefined): string | undefined {
  if (!href) return undefined;
  return /^(https?:|mailto:)/i.test(href.trim()) ? href.trim() : undefined;
}

function inline(tokens: Token[] | undefined, style: Style = {}): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case 'strong':
        runs.push(...inline((token as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...inline((token as Tokens.Em).tokens, { ...style, italic: true }));
        break;
      case 'del':
        runs.push(...inline((token as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push({ ...style, code: true, text: decodeEntities((token as Tokens.Codespan).text) });
        break;
      case 'link': {
        const link = token as Tokens.Link;
        runs.push(...inline(link.tokens, { ...style, link: safeLink(link.href) ?? style.link }));
        break;
      }
      case 'image': {
        // Images are never fetched; keep the alt text.
        const image = token as Tokens.Image;
        if (image.text) runs.push({ ...style, text: image.text });
        break;
      }
      case 'br':
        runs.push({ ...style, text: '\n' });
        break;
      case 'text': {
        const text = token as Tokens.Text;
        if (text.tokens?.length) runs.push(...inline(text.tokens, style));
        else runs.push({ ...style, text: decodeEntities(text.text) });
        break;
      }
      case 'escape':
        runs.push({ ...style, text: (token as Tokens.Escape).text });
        break;
      default:
        if ('text' in token && typeof token.text === 'string')
          runs.push({ ...style, text: decodeEntities(token.text) });
        else if ('raw' in token && typeof token.raw === 'string') runs.push({ ...style, text: token.raw });
    }
  }
  return mergeRuns(runs);
}

function sameStyle(a: InlineRun, b: InlineRun): boolean {
  return (
    !!a.bold === !!b.bold &&
    !!a.italic === !!b.italic &&
    !!a.code === !!b.code &&
    !!a.strike === !!b.strike &&
    a.link === b.link
  );
}

function mergeRuns(runs: InlineRun[]): InlineRun[] {
  const out: InlineRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = out.at(-1);
    if (last && sameStyle(last, run)) last.text += run.text;
    else out.push({ ...run });
  }
  return out;
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity] ?? entity);
}

function listItems(list: Tokens.List, depth: number): MdListItem[] {
  const items: MdListItem[] = [];
  const start = typeof list.start === 'number' ? list.start : 1;
  list.items.forEach((item, index) => {
    const own: Token[] = [];
    const nested: Tokens.List[] = [];
    for (const child of item.tokens) {
      if (child.type === 'list') nested.push(child as Tokens.List);
      else own.push(child);
    }
    const runs: InlineRun[] = [];
    for (const child of own) {
      const childTokens = 'tokens' in child && Array.isArray(child.tokens) ? (child.tokens as Token[]) : [child];
      if (runs.length) runs.push({ text: ' ' });
      runs.push(...inline(childTokens));
    }
    if (item.task) runs.unshift({ text: item.checked ? '☑ ' : '☐ ' });
    items.push({ runs: mergeRuns(runs), depth, ordered: list.ordered, number: start + index });
    for (const sub of nested) items.push(...listItems(sub, depth + 1));
  });
  return items;
}

function blocksOf(tokens: Token[]): MdBlock[] {
  const blocks: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const heading = token as Tokens.Heading;
        blocks.push({ type: 'heading', level: heading.depth, runs: inline(heading.tokens) });
        break;
      }
      case 'paragraph':
        blocks.push({ type: 'paragraph', runs: inline((token as Tokens.Paragraph).tokens) });
        break;
      case 'text': {
        const text = token as Tokens.Text;
        blocks.push({ type: 'paragraph', runs: text.tokens ? inline(text.tokens) : [{ text: text.text }] });
        break;
      }
      case 'list': {
        const list = token as Tokens.List;
        blocks.push({
          type: 'list',
          ordered: list.ordered,
          start: typeof list.start === 'number' ? list.start : 1,
          items: listItems(list, 0),
        });
        break;
      }
      case 'table': {
        const table = token as Tokens.Table;
        blocks.push({
          type: 'table',
          header: table.header.map((cell) => inline(cell.tokens)),
          rows: table.rows.map((row) => row.map((cell) => inline(cell.tokens))),
        });
        break;
      }
      case 'code':
        blocks.push({ type: 'code', text: (token as Tokens.Code).text });
        break;
      case 'blockquote': {
        const inner = blocksOf((token as Tokens.Blockquote).tokens);
        const runs: InlineRun[] = [];
        for (const block of inner) {
          if (runs.length) runs.push({ text: '\n' });
          runs.push(...blockRuns(block));
        }
        blocks.push({ type: 'quote', runs: mergeRuns(runs) });
        break;
      }
      case 'hr':
        blocks.push({ type: 'rule' });
        break;
      case 'html':
        blocks.push({ type: 'paragraph', runs: [{ text: (token as Tokens.HTML).text.trim() }] });
        break;
      case 'space':
      case 'def':
        break;
      default:
        if ('raw' in token && typeof token.raw === 'string' && token.raw.trim()) {
          blocks.push({ type: 'paragraph', runs: [{ text: token.raw.trim() }] });
        }
    }
  }
  return blocks.filter((block) => !('runs' in block) || block.runs.length > 0);
}

/** Flatten any block to inline runs (used for quotes and slide text). */
export function blockRuns(block: MdBlock): InlineRun[] {
  switch (block.type) {
    case 'heading':
      return block.runs.map((run) => ({ ...run, bold: true }));
    case 'paragraph':
    case 'quote':
      return block.runs;
    case 'list':
      return block.items.flatMap((item, index) => [
        ...(index ? [{ text: '\n' }] : []),
        { text: `${'  '.repeat(item.depth)}${item.ordered ? `${item.number}.` : '•'} ` },
        ...item.runs,
      ]);
    case 'table':
      return [block.header, ...block.rows].flatMap((row, index) => [
        ...(index ? [{ text: '\n' }] : []),
        { text: row.map((cell) => runsText(cell)).join(' | ') },
      ]);
    case 'code':
      return [{ text: block.text, code: true }];
    case 'rule':
      return [];
  }
}

export function runsText(runs: InlineRun[]): string {
  return runs.map((run) => run.text).join('');
}

export function parseMarkdown(markdown: string): MdBlock[] {
  return blocksOf(new Lexer({ gfm: true }).lex(markdown));
}

/** Inline Markdown only (bold, italic, code, links) — bullets and table cells. */
export function inlineMarkdown(text: string): InlineRun[] {
  return text ? inline(Lexer.lexInline(text)) : [];
}

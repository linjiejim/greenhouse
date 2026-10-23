/**
 * Block parser for the markdown renderer. Pure data — no JSX — so it stays easy
 * to test and never needs editing to add a new *rendered* block: an unknown
 * ``` <lang> fence just falls through as a `code` block, and the render-side
 * registry (./registry) decides whether that lang is a custom block (chart,
 * mermaid, …) or a plain code block. Not full CommonMark; covers what agent
 * replies actually use.
 */

export type Align = 'left' | 'center' | 'right';

/** A parsed pipe table (also the `/table` full-screen viewer's handoff payload). */
export interface TableData {
  head: string[];
  rows: string[][];
  align?: Align[];
  /** Cells are literal text, not inline markdown (a ```datatable's values). */
  plain?: boolean;
}

/** An image in an image-only paragraph (`![alt](src)`, optionally wrapped in a link). */
export interface MdImage {
  alt: string;
  src: string;
  href?: string;
}

export type Block =
  /** `open`: the closing fence hasn't arrived (a reply still streaming, or a truncated one). */
  | { kind: 'code'; lang: string; text: string; open?: boolean }
  | { kind: 'heading'; level: number; text: string }
  /** A paragraph of nothing but images — laid out as a row of thumbnails. */
  | { kind: 'images'; images: MdImage[] }
  | { kind: 'ul'; items: string[] }
  /** `start` = the first item's own number (a list split by prose keeps counting). */
  | { kind: 'ol'; items: string[]; start: number }
  | { kind: 'table'; data: TableData }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'p'; text: string };

const PIPE_ROW = /^\s*\|.*\|\s*$/;
const UL_ITEM = /^\s*[-*+]\s+(.*)$/;
const OL_ITEM = /^\s*(\d+)[.)]\s+(.*)$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const splitRow = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
// Lenient like the web's fixMarkdownTables: `::---:` / `:-` still delimit.
const isSep = (l: string) =>
  splitRow(l).every((c) => /^:?-+:?$/.test(c.replace(/\s/g, '').replace(/^:+/, ':').replace(/:+$/, ':')));
// `![alt](src)` or `[![alt](src)](href)`; a `${…}` template prefix the model
// sometimes leaves on an upload URL is dropped (web parity).
const IMAGE = /^\s*(?:\[!\[([^\]]*)\]\(([^)\s]+)\)\]\(([^)\s]+)\)|!\[([^\]]*)\]\(([^)\s]+)\))/;
const cleanSrc = (src: string) => src.replace(/^\$\{[^}]*\}(?=\/api\/upload\/)/, '');

/** The images of an image-only paragraph (null when it holds any text). */
function imagesOnly(text: string): MdImage[] | null {
  const out: MdImage[] = [];
  let rest = text;
  for (;;) {
    const m = IMAGE.exec(rest);
    if (!m) break;
    out.push(m[2] ? { alt: m[1], src: cleanSrc(m[2]), href: m[3] } : { alt: m[4], src: cleanSrc(m[5]) });
    rest = rest.slice(m[0].length);
  }
  return out.length && !rest.trim() ? out : null;
}

const cellAlign = (s: string): Align => {
  const t = s.trim();
  const l = t.startsWith(':');
  const r = t.endsWith(':');
  return l && r ? 'center' : r ? 'right' : 'left';
};

export function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      const text = para.join('\n').trim();
      const images = imagesOnly(text);
      blocks.push(images ? { kind: 'images', images } : { kind: 'p', text });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = line.match(/^```(.*)$/);
    if (fence) {
      flush();
      const lang = (fence[1] || 'code').trim() || 'code';
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      const open = i >= lines.length;
      i++;
      // Every fence is a code block; ./registry maps known langs (chart, …) to a
      // custom renderer at draw time, so this parser never grows a special case.
      blocks.push(open ? { kind: 'code', lang, text: buf.join('\n'), open } : { kind: 'code', lang, text: buf.join('\n') });
      continue;
    }

    if (HR.test(line)) {
      flush();
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    if (PIPE_ROW.test(line) && i + 1 < lines.length && isSep(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(cellAlign);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && PIPE_ROW.test(lines[i])) rows.push(splitRow(lines[i++]));
      blocks.push({ kind: 'table', data: { head, rows, align } });
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flush();
      const buf = [quote[1]];
      i++;
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push({ kind: 'quote', text: buf.join('\n').trim() });
      continue;
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      blocks.push({ kind: 'heading', level: h[1].length, text: h[2] });
      i++;
      continue;
    }

    const ul = line.match(UL_ITEM);
    const ol = line.match(OL_ITEM);
    if (ul || ol) {
      flush();
      const ordered = !!ol;
      const same = ordered ? OL_ITEM : UL_ITEM;
      const other = ordered ? UL_ITEM : OL_ITEM;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = l.match(same);
        if (m) {
          items.push(ordered ? m[2] : m[1]);
          i++;
          continue;
        }
        // Blank lines between items ("loose" lists, common in LLM output)
        // don't end the list when another item of it follows.
        if (l.trim() === '') {
          let j = i;
          while (j < lines.length && lines[j].trim() === '') j++;
          if (j < lines.length && same.test(lines[j])) {
            i = j;
            continue;
          }
          break;
        }
        // An indented continuation line belongs to the item above it.
        if (items.length && /^\s{2,}\S/.test(l) && !other.test(l)) {
          items[items.length - 1] += `\n${l.trim()}`;
          i++;
          continue;
        }
        break;
      }
      blocks.push(ordered ? { kind: 'ol', items, start: Number(ol![1]) || 1 } : { kind: 'ul', items });
      continue;
    }

    if (line.trim() === '') {
      flush();
      i++;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return blocks;
}

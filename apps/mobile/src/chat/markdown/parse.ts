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
}

export type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
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
const isSep = (l: string) => splitRow(l).every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
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
      blocks.push({ kind: 'p', text: para.join('\n').trim() });
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
      i++;
      // Every fence is a code block; ./registry maps known langs (chart, …) to a
      // custom renderer at draw time, so this parser never grows a special case.
      blocks.push({ kind: 'code', lang, text: buf.join('\n') });
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

    const h = line.match(/^(#{1,4})\s+(.*)$/);
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

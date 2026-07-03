/**
 * Block parser for the markdown renderer. Pure data — no JSX — so it stays easy
 * to test and never needs editing to add a new *rendered* block: an unknown
 * ``` <lang> fence just falls through as a `code` block, and the render-side
 * registry (./registry) decides whether that lang is a custom block (chart,
 * mermaid, …) or a plain code block. Not full CommonMark; covers what agent
 * replies actually use.
 */
import type { Align, TableData } from '../table-store';

export type Block =
  | { kind: 'code'; lang: string; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'table'; data: TableData }
  | { kind: 'quote'; text: string }
  | { kind: 'hr' }
  | { kind: 'p'; text: string };

const PIPE_ROW = /^\s*\|.*\|\s*$/;
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

    const ul = line.match(/^\s*[-*]\s+(.*)$/);
    const ol = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ul || ol) {
      flush();
      const ordered = !!ol;
      const items: string[] = [];
      while (i < lines.length) {
        const mu = lines[i].match(/^\s*[-*]\s+(.*)$/);
        const mo = lines[i].match(/^\s*\d+\.\s+(.*)$/);
        if (ordered && mo) items.push(mo[1]);
        else if (!ordered && mu) items.push(mu[1]);
        else break;
        i++;
      }
      blocks.push(ordered ? { kind: 'ol', items } : { kind: 'ul', items });
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

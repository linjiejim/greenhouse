/**
 * A presentation as slides — shared by the PowerPoint and the PDF deck
 * renderers so both cut the same content into the same slides.
 *
 * The plan is measured, not counted: text is wrapped with the embedded
 * font's real advance widths and line height (font.ts) at the deck's sizes
 * (DECK, which the PDF renderer lays out with), so a slide holds what fits
 * on its page. Prose and lists fill slides block by block; a paragraph
 * taller than a slide is cut at line boundaries and continues on the next.
 * Tables are cut by row
 * height — column width × wrapped lines — with the header repeated, and a
 * row taller than a slide is itself cut into pieces. Figures go four to a
 * slide. Continuation slides number themselves ("Risks (2/3)").
 *
 * The PDF deck is the tighter of the two layouts (PowerPoint has a wider
 * body box and a smaller line height at the same sizes), so a plan that fits
 * the PDF page fits the slide; `render.test.ts` holds the PDF page count to
 * the plan.
 */

import type { ReportDocument, ReportFigure } from './content.js';
import { reportFontMetrics } from './font.js';
import { inlineMarkdown, parseMarkdown, runsText, type InlineRun, type MdBlock, type MdListItem } from './markdown.js';

export type SlideBody =
  | { type: 'text'; blocks: MdBlock[] }
  | { type: 'table'; header: InlineRun[][]; rows: InlineRun[][][] }
  | { type: 'figures'; figures: ReportFigure[] };

export interface Slide {
  title: string;
  body: SlideBody;
}

/** Deck geometry and type sizes (points). render-pdf.ts lays decks out with exactly these. */
export const DECK = {
  width: 960,
  height: 540,
  marginX: 56,
  marginTop: 56,
  marginBottom: 48,
  titleSize: 26,
  titleGap: 18,
  bodySize: 16,
  lineHeight: 1.3,
  h2Size: 18,
  h3Size: 16,
  tableSize: 13,
  cellPadX: 6,
  cellPadY: 4,
  codeSize: 8.5,
  figuresPerSlide: 4,
} as const;

const CONTENT_WIDTH = DECK.width - 2 * DECK.marginX;
/** Fill at most this share of a line and of a page: rounding and word breaks never push past it. */
const SLACK = 0.92;

// ─── Measuring ───────────────────────────────────────────

function lineHeight(size: number): number {
  return size * reportFontMetrics().bold.lineHeightEm * DECK.lineHeight;
}

/** Characters that may end a line anywhere (CJK and full-width forms). */
function breaksAnywhere(cp: number): boolean {
  return cp >= 0x2e80;
}

/**
 * Greedy line wrapping as a layout engine does it: CJK characters break
 * anywhere, other text at spaces, a word wider than the line by character.
 * Measured with the bold cut, which is never narrower than the regular one.
 * Returns the character offset each line starts at (into `[...text]`).
 */
function wrap(text: string, width: number, size: number): number[] {
  const metrics = reportFontMetrics().bold;
  const advance = (char: string) => metrics.advanceEm(char.codePointAt(0)!) * size;
  const chars = [...text];
  const max = width * SLACK;
  const starts = [0];
  let lineWidth = 0;
  let i = 0;
  while (i < chars.length) {
    if (chars[i] === '\n') {
      starts.push(i + 1);
      lineWidth = 0;
      i++;
      continue;
    }
    // The next unbreakable unit: one CJK character, one space, or a word.
    let j = i + 1;
    if (!breaksAnywhere(chars[i]!.codePointAt(0)!) && chars[i] !== ' ') {
      while (j < chars.length) {
        const next = chars[j]!;
        if (next === ' ' || next === '\n' || breaksAnywhere(next.codePointAt(0)!)) break;
        j++;
      }
    }
    let unit = 0;
    for (let k = i; k < j; k++) unit += advance(chars[k]!);
    if (lineWidth > 0 && lineWidth + unit > max) {
      if (chars[i] === ' ') {
        // A space at a break is swallowed; the next line starts after it.
        starts.push(i + 1);
        lineWidth = 0;
        i++;
        continue;
      }
      starts.push(i);
      lineWidth = 0;
    }
    if (unit > max) {
      // A word wider than the line breaks by character.
      for (let k = i; k < j; k++) {
        const width = advance(chars[k]!);
        if (lineWidth > 0 && lineWidth + width > max) {
          starts.push(k);
          lineWidth = 0;
        }
        lineWidth += width;
      }
    } else lineWidth += unit;
    i = j;
  }
  return starts;
}

function lineCount(text: string, width: number, size: number): number {
  return wrap(text, width, size).length;
}

/** Runs cut to the character range [start, end) of their joined text, styles kept. */
function sliceRuns(runs: InlineRun[], start: number, end: number): InlineRun[] {
  const out: InlineRun[] = [];
  let at = 0;
  for (const run of runs) {
    const chars = [...run.text];
    const from = Math.max(start - at, 0);
    const to = Math.min(end - at, chars.length);
    if (to > from) out.push({ ...run, text: chars.slice(from, to).join('') });
    at += chars.length;
  }
  return out;
}

function trimRuns(runs: InlineRun[]): InlineRun[] {
  const out = runs.map((run) => ({ ...run }));
  if (out[0]) out[0].text = out[0].text.replace(/^\s+/, '');
  const last = out.at(-1);
  if (last) last.text = last.text.replace(/\s+$/, '');
  return out.filter((run) => run.text);
}

/** Runs cut into pieces of at most `maxLines` wrapped lines each. */
function splitRunsByLines(runs: InlineRun[], width: number, size: number, maxLines: number): InlineRun[][] {
  const text = runsText(runs);
  const starts = wrap(text, width, size);
  if (starts.length <= maxLines) return [runs];
  const length = [...text].length;
  const pieces: InlineRun[][] = [];
  for (let line = 0; line < starts.length; line += maxLines) {
    const end = line + maxLines < starts.length ? starts[line + maxLines]! : length;
    const piece = trimRuns(sliceRuns(runs, starts[line]!, end));
    if (piece.length) pieces.push(piece);
  }
  return pieces;
}

// ─── Text slides ─────────────────────────────────────────

const bodyLine = () => lineHeight(DECK.bodySize);
const PARAGRAPH_GAP = 6;
const ITEM_GAP = 3;
const LIST_GAP = 6;
const QUOTE_INSET = 20;
const QUOTE_EXTRA = 4 + 8;
const CODE_INSET = 16;
const CODE_EXTRA = 12 + 8;
const HEADING_EXTRA = 10;

function markerWidth(depth: number): number {
  return 14 + depth * 14 + 6;
}

function headingSize(level: number): number {
  return level <= 2 ? DECK.h2Size : DECK.h3Size;
}

function itemHeight(item: MdListItem): number {
  return lineCount(runsText(item.runs), CONTENT_WIDTH - markerWidth(item.depth), DECK.bodySize) * bodyLine() + ITEM_GAP;
}

/** Height (pt) of one block as the PDF deck draws it. */
function blockHeight(block: MdBlock): number {
  switch (block.type) {
    case 'heading': {
      const size = headingSize(block.level);
      return lineCount(runsText(block.runs), CONTENT_WIDTH, size) * lineHeight(size) + HEADING_EXTRA;
    }
    case 'paragraph':
      return lineCount(runsText(block.runs), CONTENT_WIDTH, DECK.bodySize) * bodyLine() + PARAGRAPH_GAP;
    case 'quote':
      return lineCount(runsText(block.runs), CONTENT_WIDTH - QUOTE_INSET, DECK.bodySize) * bodyLine() + QUOTE_EXTRA;
    case 'code':
      return lineCount(block.text, CONTENT_WIDTH - CODE_INSET, DECK.codeSize) * lineHeight(DECK.codeSize) + CODE_EXTRA;
    case 'list':
      return block.items.reduce((sum, item) => sum + itemHeight(item), 0) + LIST_GAP;
    case 'rule':
      return 14;
    case 'table':
      return tableHeight(block.header, block.rows);
  }
}

/** Points available for the body under a slide title. */
function bodyBudget(title: string): number {
  // The title may gain a "(n/m)" suffix; measure the longest it can get.
  const titleHeight = lineCount(`${title} (99/99)`, CONTENT_WIDTH, DECK.titleSize) * lineHeight(DECK.titleSize);
  return (DECK.height - DECK.marginTop - DECK.marginBottom - titleHeight - DECK.titleGap) * SLACK;
}

/** Cut one block that is taller than a whole slide into pieces that each fit. */
function splitTallBlock(block: MdBlock, budget: number): MdBlock[] {
  if (block.type === 'paragraph' || block.type === 'quote') {
    const width = block.type === 'quote' ? CONTENT_WIDTH - QUOTE_INSET : CONTENT_WIDTH;
    const extra = block.type === 'quote' ? QUOTE_EXTRA : PARAGRAPH_GAP;
    const maxLines = Math.max(1, Math.floor((budget - extra) / bodyLine()));
    return splitRunsByLines(block.runs, width, DECK.bodySize, maxLines).map((runs) => ({ type: block.type, runs }));
  }
  if (block.type === 'code') {
    const maxLines = Math.max(1, Math.floor((budget - CODE_EXTRA) / lineHeight(DECK.codeSize)));
    return splitRunsByLines([{ text: block.text }], CONTENT_WIDTH - CODE_INSET, DECK.codeSize, maxLines).map(
      (runs) => ({ type: 'code', text: runsText(runs) }),
    );
  }
  return [block];
}

/** Text blocks packed into slide-sized pages; lists split between items. */
function packText(blocks: MdBlock[], budget: number): MdBlock[][] {
  const pages: MdBlock[][] = [];
  let page: MdBlock[] = [];
  let used = 0;
  const flush = () => {
    if (page.length) pages.push(page);
    page = [];
    used = 0;
  };
  const add = (block: MdBlock) => {
    const height = blockHeight(block);
    if (used > 0 && used + height > budget) flush();
    page.push(block);
    used += height;
  };
  for (const block of blocks) {
    if (block.type === 'list') {
      let chunk: MdListItem[] = [];
      let chunkHeight = LIST_GAP;
      for (const item of block.items) {
        const height = itemHeight(item);
        if (used + chunkHeight + height > budget) {
          if (chunk.length) add({ ...block, items: chunk });
          flush();
          chunk = [];
          chunkHeight = LIST_GAP;
        }
        chunk.push(item);
        chunkHeight += height;
      }
      if (chunk.length) add({ ...block, items: chunk });
    } else if (blockHeight(block) > budget) {
      for (const part of splitTallBlock(block, budget)) add(part);
    } else add(block);
  }
  flush();
  return pages;
}

// ─── Table slides ────────────────────────────────────────

const tableLine = () => lineHeight(DECK.tableSize);
/** Space above and below a table (render-pdf tableNode). */
const TABLE_MARGIN = 2 + 10;

function cellWidth(columns: number): number {
  // '*' columns share what is left after each cell's horizontal padding and the rules.
  return (CONTENT_WIDTH - columns * 2 * DECK.cellPadX - (columns + 1)) / columns;
}

function rowHeight(row: InlineRun[][], columns: number): number {
  const width = cellWidth(columns);
  const lines = Math.max(1, ...row.map((cell) => lineCount(runsText(cell), width, DECK.tableSize)));
  return lines * tableLine() + 2 * DECK.cellPadY + 1;
}

function tableHeight(header: InlineRun[][], rows: InlineRun[][][]): number {
  return [header, ...rows].reduce((sum, row) => sum + rowHeight(row, header.length), TABLE_MARGIN);
}

/** A row taller than the room under the header, cut into rows that each fit; its cells continue in step. */
function splitTallRow(row: InlineRun[][], columns: number, room: number): InlineRun[][][] {
  if (rowHeight(row, columns) <= room) return [row];
  const maxLines = Math.max(1, Math.floor((room - 2 * DECK.cellPadY - 1) / tableLine()));
  const pieces = row.map((cell) => splitRunsByLines(cell, cellWidth(columns), DECK.tableSize, maxLines));
  const count = Math.max(...pieces.map((cell) => cell.length));
  return Array.from({ length: count }, (_, index) => pieces.map((cell) => cell[index] ?? []));
}

/** Rows packed into slides by height, the header repeated on each. */
function packTable(header: InlineRun[][], rows: InlineRun[][][], budget: number): SlideBody[] {
  const columns = header.length;
  const room = budget - TABLE_MARGIN - rowHeight(header, columns);
  const bodies: SlideBody[] = [];
  let page: InlineRun[][][] = [];
  let used = 0;
  for (const piece of rows.flatMap((row) => splitTallRow(row, columns, room))) {
    const height = rowHeight(piece, columns);
    if (page.length && used + height > room) {
      bodies.push({ type: 'table', header, rows: page });
      page = [];
      used = 0;
    }
    page.push(piece);
    used += height;
  }
  if (page.length || bodies.length === 0) bodies.push({ type: 'table', header, rows: page });
  return bodies;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ─── Plan ────────────────────────────────────────────────

/** The body slides of a presentation (the cover is drawn by each renderer). */
export function buildSlides(document: ReportDocument): Slide[] {
  const slides: Slide[] = [];
  for (const section of document.sections) {
    const budget = bodyBudget(section.title);
    const bodies: SlideBody[] = [];
    const body = section.body;
    if (body.kind === 'markdown') {
      let text: MdBlock[] = [];
      const flushText = () => {
        for (const page of packText(text, budget)) bodies.push({ type: 'text', blocks: page });
        text = [];
      };
      for (const block of parseMarkdown(body.markdown)) {
        if (block.type === 'table') {
          flushText();
          bodies.push(...packTable(block.header, block.rows, budget));
        } else text.push(block);
      }
      flushText();
    } else if (body.kind === 'bullets') {
      const list: MdBlock = {
        type: 'list',
        ordered: false,
        start: 1,
        items: body.items.map((item, index) => ({
          runs: inlineMarkdown(item),
          depth: 0,
          ordered: false,
          number: index + 1,
        })),
      };
      for (const page of packText([list], budget)) bodies.push({ type: 'text', blocks: page });
    } else if (body.kind === 'table') {
      bodies.push(
        ...packTable(
          body.columns.map((column) => inlineMarkdown(column)),
          body.rows.map((row) => row.map((cell) => inlineMarkdown(cell))),
          budget,
        ),
      );
    } else {
      for (const figures of chunks(body.figures, DECK.figuresPerSlide)) bodies.push({ type: 'figures', figures });
    }
    bodies.forEach((slideBody, index) => {
      slides.push({
        title: bodies.length > 1 ? `${section.title} (${index + 1}/${bodies.length})` : section.title,
        body: slideBody,
      });
    });
  }
  return slides;
}

/** Cover lines under the title, in a fixed order: subtitle, then "author · date · period". */
export function coverMeta(document: ReportDocument): { subtitle: string | null; meta: string | null } {
  const { subtitle, author, date, period } = document.cover;
  const meta = [author, date, period].filter(Boolean).join('  ·  ');
  return { subtitle: subtitle ?? null, meta: meta || null };
}

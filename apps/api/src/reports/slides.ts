/**
 * A presentation as slides — shared by the PowerPoint and the PDF deck
 * renderers so both cut the same content into the same slides.
 *
 * One section becomes one slide, or several when it does not fit: lists and
 * prose are split by an estimated line budget, tables every few rows (the
 * header repeats), figures four to a slide. Continuation slides number
 * themselves ("Risks (2/3)"). Estimates, not measurements — the PowerPoint
 * text boxes also shrink-on-overflow as a last resort.
 */

import type { ReportDocument, ReportFigure } from './content.js';
import { inlineMarkdown, parseMarkdown, runsText, type InlineRun, type MdBlock } from './markdown.js';

export type SlideBody =
  | { type: 'text'; blocks: MdBlock[] }
  | { type: 'table'; header: InlineRun[][]; rows: InlineRun[][][] }
  | { type: 'figures'; figures: ReportFigure[] };

export interface Slide {
  title: string;
  body: SlideBody;
}

/** Lines of body text a slide holds at the deck's body size. */
const LINES_PER_SLIDE = 11;
/** Characters per line at that size (CJK characters count double). */
const CHARS_PER_LINE = 80;
const TABLE_ROWS_PER_SLIDE = 8;
const FIGURES_PER_SLIDE = 4;

function visualLength(text: string): number {
  let n = 0;
  for (const char of text) n += char.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return n;
}

function lines(text: string): number {
  return text
    .split('\n')
    .reduce((total, line) => total + Math.max(1, Math.ceil(visualLength(line) / CHARS_PER_LINE)), 0);
}

function blockLines(block: MdBlock): number {
  switch (block.type) {
    case 'heading':
      return 2;
    case 'paragraph':
    case 'quote':
      return lines(runsText(block.runs)) + 1;
    case 'code':
      return block.text.split('\n').length + 1;
    case 'list':
      return block.items.reduce((n, item) => n + lines(runsText(item.runs)), 0) + 1;
    case 'rule':
      return 1;
    case 'table':
      return block.rows.length + 2;
  }
}

/** Break a paragraph that alone exceeds a slide at sentence ends. */
function splitParagraph(block: Extract<MdBlock, { type: 'paragraph' | 'quote' }>): MdBlock[] {
  const text = runsText(block.runs);
  if (lines(text) <= LINES_PER_SLIDE - 1) return [block];
  const sentences = text.match(/[^。！？.!?]+[。！？.!?]*\s*/g) ?? [text];
  const out: MdBlock[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && lines(current + sentence) > LINES_PER_SLIDE - 1) {
      out.push({ type: block.type, runs: [{ text: current.trim() }] });
      current = '';
    }
    current += sentence;
  }
  if (current.trim()) out.push({ type: block.type, runs: [{ text: current.trim() }] });
  return out;
}

/** Text blocks packed into slide-sized pages; lists split between items. */
function packText(blocks: MdBlock[]): MdBlock[][] {
  const pages: MdBlock[][] = [];
  let page: MdBlock[] = [];
  let used = 0;
  const flush = () => {
    if (page.length) pages.push(page);
    page = [];
    used = 0;
  };
  const add = (block: MdBlock) => {
    const cost = blockLines(block);
    if (used && used + cost > LINES_PER_SLIDE) flush();
    page.push(block);
    used += cost;
  };
  for (const block of blocks) {
    if (block.type === 'list') {
      let chunk: typeof block.items = [];
      let chunkLines = 1;
      for (const item of block.items) {
        const cost = lines(runsText(item.runs));
        if (chunk.length && used + chunkLines + cost > LINES_PER_SLIDE) {
          add({ ...block, items: chunk });
          flush();
          chunk = [];
          chunkLines = 1;
        }
        chunk.push(item);
        chunkLines += cost;
      }
      if (chunk.length) add({ ...block, items: chunk });
    } else if (block.type === 'paragraph' || block.type === 'quote') {
      for (const part of splitParagraph(block)) add(part);
    } else add(block);
  }
  flush();
  return pages;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The body slides of a presentation (the cover is drawn by each renderer). */
export function buildSlides(document: ReportDocument): Slide[] {
  const slides: Slide[] = [];
  for (const section of document.sections) {
    const bodies: SlideBody[] = [];
    const body = section.body;
    if (body.kind === 'markdown') {
      let text: MdBlock[] = [];
      const flushText = () => {
        for (const page of packText(text)) bodies.push({ type: 'text', blocks: page });
        text = [];
      };
      for (const block of parseMarkdown(body.markdown)) {
        if (block.type === 'table') {
          flushText();
          for (const rows of chunks(block.rows, TABLE_ROWS_PER_SLIDE)) {
            bodies.push({ type: 'table', header: block.header, rows });
          }
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
      for (const page of packText([list])) bodies.push({ type: 'text', blocks: page });
    } else if (body.kind === 'table') {
      const header = body.columns.map((column) => inlineMarkdown(column));
      for (const rows of chunks(body.rows, TABLE_ROWS_PER_SLIDE)) {
        bodies.push({ type: 'table', header, rows: rows.map((row) => row.map((cell) => inlineMarkdown(cell))) });
      }
    } else {
      for (const figures of chunks(body.figures, FIGURES_PER_SLIDE)) bodies.push({ type: 'figures', figures });
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

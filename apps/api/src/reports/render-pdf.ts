/**
 * PDF rendering (pdfmake, pure JS — no headless browser).
 *
 * Reports are A4 portrait: a title block on the first page, then the sections
 * in template order, with the brand in the header and page numbers in the
 * footer. Presentations are 16:9 pages, one slide per page, cut by
 * slides.ts exactly as the PowerPoint is.
 *
 * pdfmake on a server can read local files and fetch URLs for images and
 * fonts. Both are shut: the fonts come from its in-memory file system, the
 * logo is passed as bytes, and every URL / disk path is refused by policy.
 * Nothing in the content is ever interpreted as a resource.
 */

import pdfmake from 'pdfmake';
import type { ReportDocument, ReportFigure } from './content.js';
import { fitLogo, tint, type ReportBrand } from './brand.js';
import { PDF_FONT_FAMILY, reportFontBytes } from './font.js';
import { inlineMarkdown, parseMarkdown, type InlineRun, type MdBlock } from './markdown.js';
import { buildSlides, coverMeta, type Slide } from './slides.js';

type Node = Record<string, unknown> | string | Node[];

const TEXT = '#1F2933';
const MUTED = '#6B7280';
const RULE = '#E5E7EB';
const CODE_BG = '#F3F4F6';

let configured = false;

function configure(): void {
  if (configured) return;
  const fonts = reportFontBytes();
  pdfmake.virtualfs.writeFileSync('report-regular.ttf', fonts.normal);
  pdfmake.virtualfs.writeFileSync('report-bold.ttf', fonts.bold);
  pdfmake.setFonts({
    [PDF_FONT_FAMILY]: {
      normal: 'report-regular.ttf',
      bold: 'report-bold.ttf',
      // No italic cut ships for CJK; italic text renders upright.
      italics: 'report-regular.ttf',
      bolditalics: 'report-bold.ttf',
    },
  });
  pdfmake.setUrlAccessPolicy(() => false);
  pdfmake.setLocalAccessPolicy(() => false);
  configured = true;
}

// ─── Shared pieces ───────────────────────────────────────

function runs(list: InlineRun[], brand: ReportBrand): Node[] {
  return list.map((run) => {
    const node: Record<string, unknown> = { text: run.text };
    if (run.bold) node.bold = true;
    if (run.italic) node.italics = true;
    if (run.strike) node.decoration = 'lineThrough';
    if (run.code) node.background = CODE_BG;
    if (run.link) {
      node.link = run.link;
      node.color = brand.color;
      node.decoration = 'underline';
    }
    return node;
  });
}

function logoNode(brand: ReportBrand, maxWidth: number, maxHeight: number): Node | null {
  const logo = brand.logo;
  if (!logo || logo.kind === 'webp') return null;
  const size = fitLogo(logo, maxWidth, maxHeight);
  if (logo.kind === 'svg') return { svg: logo.bytes.toString('utf8'), ...size };
  return { image: `data:image/${logo.kind};base64,${logo.bytes.toString('base64')}`, ...size };
}

function tableLayout(brand: ReportBrand) {
  return {
    fillColor: (row: number) => (row === 0 ? tint(brand.color, 0.86) : null),
    hLineWidth: (i: number, node: { table: { body: unknown[] } }) =>
      i === 0 || i === node.table.body.length ? 0.8 : 0.5,
    vLineWidth: () => 0,
    hLineColor: () => RULE,
    paddingLeft: () => 6,
    paddingRight: () => 6,
    paddingTop: () => 4,
    paddingBottom: () => 4,
  };
}

function tableNode(header: InlineRun[][], rows: InlineRun[][][], brand: ReportBrand, fontSize?: number): Node {
  return {
    table: {
      headerRows: 1,
      widths: header.map(() => '*'),
      body: [
        header.map((cell) => ({ text: runs(cell, brand), bold: true })),
        ...rows.map((row) => row.map((cell) => ({ text: runs(cell, brand) }))),
      ],
    },
    layout: tableLayout(brand),
    ...(fontSize ? { fontSize } : {}),
    margin: [0, 2, 0, 10],
  };
}

function blockNode(block: MdBlock, brand: ReportBrand, sizes: { h2: number; h3: number }): Node {
  switch (block.type) {
    case 'heading':
      return {
        text: runs(block.runs, brand),
        bold: true,
        fontSize: block.level <= 2 ? sizes.h2 : sizes.h3,
        margin: [0, 6, 0, 4],
      };
    case 'paragraph':
      return { text: runs(block.runs, brand), margin: [0, 0, 0, 6] };
    case 'list':
      return {
        stack: block.items.map((item) => ({
          columns: [
            {
              width: 14 + item.depth * 14,
              text: item.ordered ? `${item.number}.` : item.depth ? '◦' : '•',
              alignment: 'right',
              color: item.ordered ? TEXT : brand.color,
            },
            { width: '*', text: runs(item.runs, brand) },
          ],
          columnGap: 6,
          margin: [0, 0, 0, 3],
        })),
        margin: [0, 0, 0, 6],
      };
    case 'table':
      return tableNode(block.header, block.rows, brand);
    case 'code':
      return {
        table: { widths: ['*'], body: [[{ text: block.text, fontSize: 8.5, preserveLeadingSpaces: true }]] },
        layout: {
          fillColor: () => CODE_BG,
          hLineWidth: () => 0,
          vLineWidth: () => 0,
          paddingLeft: () => 8,
          paddingRight: () => 8,
          paddingTop: () => 6,
          paddingBottom: () => 6,
        },
        margin: [0, 0, 0, 8],
      };
    case 'quote':
      return {
        table: { widths: ['*'], body: [[{ text: runs(block.runs, brand), color: MUTED }]] },
        layout: {
          hLineWidth: () => 0,
          vLineWidth: (i: number) => (i === 0 ? 2.5 : 0),
          vLineColor: () => brand.color,
          paddingLeft: () => 10,
          paddingTop: () => 2,
          paddingBottom: () => 2,
        },
        margin: [0, 0, 0, 8],
      };
    case 'rule':
      return {
        canvas: [{ type: 'line', x1: 0, y1: 4, x2: 480, y2: 4, lineWidth: 0.5, lineColor: RULE }],
        margin: [0, 2, 0, 8],
      };
  }
}

function figuresNode(figures: ReportFigure[], brand: ReportBrand, valueSize: number, perRow: number): Node {
  const rows: Node[][] = [];
  for (let i = 0; i < figures.length; i += perRow) {
    const slice = figures.slice(i, i + perRow);
    rows.push(
      slice.map((figure) => ({
        stack: [
          { text: figure.value, fontSize: valueSize, bold: true, color: brand.color },
          { text: figure.label, fontSize: valueSize * 0.42, color: TEXT, margin: [0, 2, 0, 0] },
          ...(figure.note
            ? [{ text: figure.note, fontSize: valueSize * 0.36, color: MUTED, margin: [0, 2, 0, 0] }]
            : []),
        ],
      })),
    );
  }
  const columns = Math.min(perRow, figures.length);
  const body = rows.map((row) => [...row, ...Array.from({ length: columns - row.length }, () => ({ text: '' }))]);
  return {
    table: { widths: Array.from({ length: columns }, () => '*'), body },
    layout: {
      fillColor: (_row: number, node: unknown, col: number) => {
        const cell = (node as { table: { body: Array<Array<{ text?: string }>> } }).table.body[_row]?.[col];
        return cell && cell.text === '' ? null : tint(brand.color, 0.92);
      },
      hLineWidth: () => 6,
      vLineWidth: () => 6,
      hLineColor: () => '#FFFFFF',
      vLineColor: () => '#FFFFFF',
      paddingLeft: () => 10,
      paddingRight: () => 10,
      paddingTop: () => 8,
      paddingBottom: () => 8,
    },
    margin: [-6, -4, -6, 6],
  };
}

function sectionBodyNodes(document: ReportDocument, index: number, brand: ReportBrand): Node[] {
  const body = document.sections[index]!.body;
  switch (body.kind) {
    case 'markdown':
      return parseMarkdown(body.markdown).map((block) => blockNode(block, brand, { h2: 12.5, h3: 11 }));
    case 'bullets':
      return [
        blockNode(
          {
            type: 'list',
            ordered: false,
            start: 1,
            items: body.items.map((item, i) => ({
              runs: inlineMarkdown(item),
              depth: 0,
              ordered: false,
              number: i + 1,
            })),
          },
          brand,
          { h2: 12.5, h3: 11 },
        ),
      ];
    case 'table':
      return [
        tableNode(
          body.columns.map((c) => inlineMarkdown(c)),
          body.rows.map((row) => row.map((cell) => inlineMarkdown(cell))),
          brand,
          9.5,
        ),
      ];
    case 'figures':
      return [figuresNode(body.figures, brand, 20, 4)];
  }
}

// ─── Report (A4) ─────────────────────────────────────────

const A4_WIDTH = 595.28;
const REPORT_MARGIN_X = 56;

function reportDefinition(document: ReportDocument, brand: ReportBrand): Record<string, unknown> {
  const contentWidth = A4_WIDTH - REPORT_MARGIN_X * 2;
  const { subtitle, meta } = coverMeta(document);
  const logo = logoNode(brand, 120, 30);
  const content: Node[] = [
    { canvas: [{ type: 'rect', x: 0, y: 0, w: 48, h: 4, color: brand.color }], margin: [0, 0, 0, 14] },
    {
      columns: [
        ...(logo ? [{ ...(logo as Record<string, unknown>), width: (logo as { width: number }).width }] : []),
        { text: brand.name, color: MUTED, fontSize: 10, margin: [logo ? 8 : 0, logo ? 8 : 0, 0, 0] },
      ],
      columnGap: 0,
      margin: [0, 0, 0, 18],
    },
    { text: document.cover.title, fontSize: 22, bold: true, color: TEXT, margin: [0, 0, 0, 6] },
    ...(subtitle ? [{ text: subtitle, fontSize: 13, color: MUTED, margin: [0, 0, 0, 4] }] : []),
    ...(meta ? [{ text: meta, fontSize: 9.5, color: MUTED, margin: [0, 2, 0, 0] }] : []),
    {
      canvas: [{ type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 0.6, lineColor: RULE }],
      margin: [0, 16, 0, 14],
    },
  ];
  document.sections.forEach((section, index) => {
    content.push(
      {
        text: section.title,
        fontSize: 14,
        bold: true,
        color: brand.color,
        headlineLevel: 1,
        margin: [0, index ? 10 : 0, 0, 0],
      },
      {
        canvas: [
          { type: 'line', x1: 0, y1: 0, x2: contentWidth, y2: 0, lineWidth: 0.5, lineColor: tint(brand.color, 0.7) },
        ],
        margin: [0, 4, 0, 8],
      },
    );
    content.push(...sectionBodyNodes(document, index, brand));
  });

  return {
    pageSize: 'A4',
    pageMargins: [REPORT_MARGIN_X, 64, REPORT_MARGIN_X, 56],
    info: { title: document.cover.title, author: document.cover.author ?? brand.name, creator: brand.name },
    defaultStyle: { font: PDF_FONT_FAMILY, fontSize: 10.5, lineHeight: 1.35, color: TEXT },
    header: (page: number) =>
      page === 1
        ? null
        : {
            columns: [
              { text: brand.name, color: brand.color, bold: true },
              { text: document.cover.title, alignment: 'right', color: MUTED },
            ],
            fontSize: 8.5,
            margin: [REPORT_MARGIN_X, 28, REPORT_MARGIN_X, 0],
          },
    footer: (page: number, pages: number) => ({
      columns: [
        { text: `${document.template.name}`, color: MUTED },
        { text: `${page} / ${pages}`, alignment: 'right', color: MUTED },
      ],
      fontSize: 8.5,
      margin: [REPORT_MARGIN_X, 22, REPORT_MARGIN_X, 0],
    }),
    content,
    // A section title never ends a page: one in the bottom fifth starts the next page instead.
    pageBreakBefore: (node: { headlineLevel?: number; startPosition?: { verticalRatio?: number } }) =>
      node.headlineLevel === 1 && (node.startPosition?.verticalRatio ?? 0) > 0.8,
  };
}

// ─── Presentation (16:9) ─────────────────────────────────

const SLIDE = { width: 960, height: 540 };
const SLIDE_MARGIN_X = 56;

function slideNodes(slide: Slide, brand: ReportBrand): Node[] {
  const title = { text: slide.title, fontSize: 26, bold: true, color: TEXT, margin: [0, 0, 0, 18] };
  const body = slide.body;
  if (body.type === 'text') {
    return [title, ...body.blocks.map((block) => blockNode(block, brand, { h2: 18, h3: 16 }))];
  }
  if (body.type === 'table') return [title, tableNode(body.header, body.rows, brand, 13)];
  return [title, { ...(figuresNode(body.figures, brand, 34, 4) as Record<string, unknown>), margin: [-6, 30, -6, 0] }];
}

function presentationDefinition(document: ReportDocument, brand: ReportBrand): Record<string, unknown> {
  const { subtitle, meta } = coverMeta(document);
  const slides = buildSlides(document);
  const coverLogo = logoNode(brand, 180, 48);
  const smallLogo = logoNode(brand, 90, 22);
  const content: Node[] = [
    {
      stack: [
        coverLogo
          ? { ...(coverLogo as Record<string, unknown>), margin: [0, 0, 0, 28] }
          : { text: brand.name, fontSize: 18, bold: true, color: brand.color, margin: [0, 0, 0, 28] },
        { text: document.cover.title, fontSize: 40, bold: true, color: TEXT },
        ...(subtitle ? [{ text: subtitle, fontSize: 20, color: MUTED, margin: [0, 10, 0, 0] }] : []),
        ...(meta ? [{ text: meta, fontSize: 14, color: MUTED, margin: [0, 24, 0, 0] }] : []),
      ],
      margin: [0, 80, 0, 0],
    },
  ];
  for (const slide of slides) {
    content.push({ stack: slideNodes(slide, brand), pageBreak: 'before' });
  }
  return {
    pageSize: SLIDE,
    pageOrientation: 'landscape',
    pageMargins: [SLIDE_MARGIN_X, 56, SLIDE_MARGIN_X, 48],
    info: { title: document.cover.title, author: document.cover.author ?? brand.name, creator: brand.name },
    defaultStyle: { font: PDF_FONT_FAMILY, fontSize: 16, lineHeight: 1.3, color: TEXT },
    background: (page: number) =>
      page === 1
        ? { canvas: [{ type: 'rect', x: 0, y: 0, w: 18, h: SLIDE.height, color: brand.color }] }
        : { canvas: [{ type: 'rect', x: 0, y: 0, w: SLIDE.width, h: 6, color: brand.color }] },
    footer: (page: number, pages: number) =>
      page === 1
        ? null
        : {
            columns: [
              smallLogo
                ? { ...(smallLogo as Record<string, unknown>) }
                : { text: brand.name, color: brand.color, bold: true },
              { text: `${page} / ${pages}`, alignment: 'right', color: MUTED },
            ],
            fontSize: 10,
            margin: [SLIDE_MARGIN_X, 12, SLIDE_MARGIN_X, 0],
          },
    content,
  };
}

export async function renderPdf(document: ReportDocument, brand: ReportBrand): Promise<Buffer> {
  configure();
  const definition =
    document.kind === 'presentation' ? presentationDefinition(document, brand) : reportDefinition(document, brand);
  return pdfmake.createPdf(definition).getBuffer();
}

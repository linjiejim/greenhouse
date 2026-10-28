/**
 * Word rendering (`docx`) for reports.
 *
 * Same layout as the PDF report: a title block on the first page, section
 * titles in the brand colour, the brand in the header from page two on and
 * "n / N" in the footer. Text uses OFFICE_FONT (Word substitutes a CJK face
 * when it is missing); nothing is embedded but the logo, and only a PNG or
 * JPEG one — an SVG logo needs a raster fallback Word files cannot do without.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  ImageRun,
  LevelFormat,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TabStopType,
  TextRun,
  WidthType,
  type ParagraphChild,
} from 'docx';
import type { ReportDocument, ReportFigure } from './content.js';
import { bareHex, fitLogo, tint, type ReportBrand } from './brand.js';
import { OFFICE_FONT } from './font.js';
import { inlineMarkdown, parseMarkdown, type InlineRun, type MdBlock } from './markdown.js';
import { coverMeta } from './slides.js';

const TEXT = '1F2933';
const MUTED = '6B7280';
const RULE = 'E5E7EB';
const CODE_BG = 'F3F4F6';
/** A4 width minus 2 cm margins on each side, in twips. */
const CONTENT_TWIPS = 11906 - 2 * 1134;

const FONT = { ascii: OFFICE_FONT, hAnsi: OFFICE_FONT, eastAsia: OFFICE_FONT, cs: OFFICE_FONT };

type RunStyle = { size?: number; color?: string; bold?: boolean };

function textRuns(list: InlineRun[], brand: ReportBrand, base: RunStyle = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const run of list) {
    const options = {
      font: FONT,
      ...(base.size ? { size: base.size } : {}),
      color: run.link ? bareHex(brand.color) : (base.color ?? TEXT),
      bold: run.bold || base.bold,
      italics: run.italic,
      strike: run.strike,
      ...(run.code ? { shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: 'auto' } } : {}),
      ...(run.link ? { underline: {} } : {}),
    };
    // Line breaks inside a run become real breaks.
    const pieces = run.text
      .split('\n')
      .map((part, index) => new TextRun({ ...options, text: part, ...(index > 0 ? { break: 1 } : {}) }));
    if (run.link) out.push(new ExternalHyperlink({ link: run.link, children: pieces }));
    else out.push(...pieces);
  }
  return out;
}

function cellBorders(color: string) {
  const line = { style: BorderStyle.SINGLE, size: 4, color };
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  return { top: line, bottom: line, left: none, right: none };
}

function table(header: InlineRun[][], rows: InlineRun[][][], brand: ReportBrand): Table {
  const width = Math.floor(CONTENT_TWIPS / header.length);
  const headerFill = bareHex(tint(brand.color, 0.86));
  const cell = (runs: InlineRun[], isHeader: boolean) =>
    new TableCell({
      width: { size: width, type: WidthType.DXA },
      borders: cellBorders(RULE),
      ...(isHeader ? { shading: { type: ShadingType.CLEAR, fill: headerFill, color: 'auto' } } : {}),
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: textRuns(runs, brand, { size: 19, bold: isHeader }) })],
    });
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: header.map(() => width),
    rows: [
      new TableRow({ tableHeader: true, children: header.map((c) => cell(c, true)) }),
      ...rows.map((row) => new TableRow({ children: row.map((c) => cell(c, false)) })),
    ],
  });
}

function figures(list: ReportFigure[], brand: ReportBrand): Table {
  const perRow = Math.min(4, list.length);
  const width = Math.floor(CONTENT_TWIPS / perRow);
  const fill = bareHex(tint(brand.color, 0.92));
  const white = { style: BorderStyle.SINGLE, size: 48, color: 'FFFFFF' };
  const rows: TableRow[] = [];
  for (let i = 0; i < list.length; i += perRow) {
    const slice = list.slice(i, i + perRow);
    const cells = slice.map(
      (figure) =>
        new TableCell({
          width: { size: width, type: WidthType.DXA },
          shading: { type: ShadingType.CLEAR, fill, color: 'auto' },
          borders: { top: white, bottom: white, left: white, right: white },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: figure.value, font: FONT, size: 40, bold: true, color: bareHex(brand.color) }),
              ],
            }),
            new Paragraph({ children: [new TextRun({ text: figure.label, font: FONT, size: 18, color: TEXT })] }),
            ...(figure.note
              ? [new Paragraph({ children: [new TextRun({ text: figure.note, font: FONT, size: 16, color: MUTED })] })]
              : []),
          ],
        }),
    );
    while (cells.length < perRow) {
      cells.push(
        new TableCell({
          width: { size: width, type: WidthType.DXA },
          borders: { top: white, bottom: white, left: white, right: white },
          children: [new Paragraph('')],
        }),
      );
    }
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    width: { size: CONTENT_TWIPS, type: WidthType.DXA },
    columnWidths: Array(perRow).fill(width),
    rows,
  });
}

/** One numbering instance per ordered list, so each starts again at its own number. */
let listInstance = 0;

function blocks(list: MdBlock[], brand: ReportBrand): Array<Paragraph | Table> {
  const out: Array<Paragraph | Table> = [];
  for (const block of list) {
    switch (block.type) {
      case 'heading':
        out.push(
          new Paragraph({
            spacing: { before: 160, after: 80 },
            children: textRuns(block.runs, brand, { size: block.level <= 2 ? 25 : 22, bold: true }),
          }),
        );
        break;
      case 'paragraph':
        out.push(new Paragraph({ spacing: { after: 120 }, children: textRuns(block.runs, brand) }));
        break;
      case 'list': {
        const instance = ++listInstance;
        for (const item of block.items) {
          out.push(
            new Paragraph({
              numbering: {
                reference: item.ordered ? 'report-numbers' : 'report-bullets',
                level: Math.min(item.depth, 3),
                ...(item.ordered ? { instance } : {}),
              },
              spacing: { after: 60 },
              children: textRuns(item.runs, brand),
            }),
          );
        }
        break;
      }
      case 'table':
        out.push(table(block.header, block.rows, brand), new Paragraph({ spacing: { after: 120 }, children: [] }));
        break;
      case 'code':
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: CODE_BG, color: 'auto' },
            spacing: { after: 120 },
            children: textRuns([{ text: block.text }], brand, { size: 18 }),
          }),
        );
        break;
      case 'quote':
        out.push(
          new Paragraph({
            border: { left: { style: BorderStyle.SINGLE, size: 18, color: bareHex(brand.color), space: 8 } },
            indent: { left: 200 },
            spacing: { after: 120 },
            children: textRuns(block.runs, brand, { color: MUTED }),
          }),
        );
        break;
      case 'rule':
        out.push(
          new Paragraph({
            border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 1 } },
            spacing: { after: 120 },
            children: [],
          }),
        );
        break;
    }
  }
  return out;
}

function logoRun(brand: ReportBrand, maxWidth: number, maxHeight: number): ImageRun | null {
  const logo = brand.logo;
  if (!logo || (logo.kind !== 'png' && logo.kind !== 'jpeg')) return null;
  // docx sizes images in pixels at 96 dpi; points × 4/3.
  const size = fitLogo(logo, maxWidth, maxHeight);
  return new ImageRun({
    type: logo.kind === 'png' ? 'png' : 'jpg',
    data: logo.bytes,
    transformation: { width: Math.round((size.width * 4) / 3), height: Math.round((size.height * 4) / 3) },
  });
}

export async function renderDocx(document: ReportDocument, brand: ReportBrand): Promise<Buffer> {
  listInstance = 0;
  const color = bareHex(brand.color);
  const { subtitle, meta } = coverMeta(document);
  const logo = logoRun(brand, 120, 30);
  const children: Array<Paragraph | Table> = [
    new Paragraph({
      spacing: { after: 240 },
      children: [
        ...(logo ? [logo, new TextRun({ text: '  ', font: FONT })] : []),
        new TextRun({ text: brand.name, font: FONT, size: 20, color: MUTED }),
      ],
    }),
    new Paragraph({
      spacing: { after: 80 },
      children: [new TextRun({ text: document.cover.title, font: FONT, size: 44, bold: true, color: TEXT })],
    }),
    ...(subtitle
      ? [
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: subtitle, font: FONT, size: 26, color: MUTED })],
          }),
        ]
      : []),
    ...(meta
      ? [
          new Paragraph({
            spacing: { after: 60 },
            children: [new TextRun({ text: meta, font: FONT, size: 19, color: MUTED })],
          }),
        ]
      : []),
    new Paragraph({
      border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: RULE, space: 1 } },
      spacing: { after: 240 },
      children: [],
    }),
  ];

  for (const section of document.sections) {
    children.push(
      new Paragraph({
        keepNext: true,
        spacing: { before: 240, after: 120 },
        border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: bareHex(tint(brand.color, 0.7)), space: 4 } },
        children: [new TextRun({ text: section.title, font: FONT, size: 28, bold: true, color })],
      }),
    );
    const body = section.body;
    if (body.kind === 'markdown') children.push(...blocks(parseMarkdown(body.markdown), brand));
    else if (body.kind === 'bullets') {
      children.push(
        ...blocks(
          [
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
          ],
          brand,
        ),
      );
    } else if (body.kind === 'table') {
      children.push(
        table(
          body.columns.map((c) => inlineMarkdown(c)),
          body.rows.map((row) => row.map((cell) => inlineMarkdown(cell))),
          brand,
        ),
      );
    } else children.push(figures(body.figures, brand));
  }

  const small = { font: FONT, size: 17 };
  const footer = () =>
    new Footer({
      children: [
        new Paragraph({
          tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIPS }],
          children: [
            new TextRun({ ...small, text: document.template.name, color: MUTED }),
            new TextRun({
              ...small,
              color: MUTED,
              children: ['\t', PageNumber.CURRENT, ' / ', PageNumber.TOTAL_PAGES],
            }),
          ],
        }),
      ],
    });
  const doc = new Document({
    creator: brand.name,
    title: document.cover.title,
    description: `${document.template.name} (template v${document.template.version})`,
    styles: { default: { document: { run: { font: FONT, size: 21, color: TEXT } } } },
    numbering: {
      config: [
        {
          reference: 'report-bullets',
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: level % 2 === 0 ? '•' : '◦',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 + level * 360, hanging: 260 } }, run: { color } },
          })),
        },
        {
          reference: 'report-numbers',
          levels: [0, 1, 2, 3].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 360 + level * 360, hanging: 300 } } },
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          titlePage: true,
          page: { margin: { top: 1300, bottom: 1134, left: 1134, right: 1134 } },
        },
        headers: {
          first: new Header({ children: [] }),
          default: new Header({
            children: [
              new Paragraph({
                tabStops: [{ type: TabStopType.RIGHT, position: CONTENT_TWIPS }],
                children: [
                  new TextRun({ ...small, text: brand.name, bold: true, color }),
                  new TextRun({ ...small, text: `\t${document.cover.title}`, color: MUTED }),
                ],
              }),
            ],
          }),
        },
        footers: { first: footer(), default: footer() },
        children,
      },
    ],
  });
  return Packer.toBuffer(doc);
}

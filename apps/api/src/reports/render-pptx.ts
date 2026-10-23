/**
 * PowerPoint rendering (`pptxgenjs`) for presentations.
 *
 * 16:9 (13.33" × 7.5"). A cover slide with the brand bar, logo, title and the
 * cover fields, then the body slides slides.ts cut from the sections — the
 * same slides the PDF deck has. Body slides carry the brand bar, the logo (or
 * the brand name) and the slide number. Text uses OFFICE_FONT; nothing but a
 * PNG/JPEG logo is embedded (pptxgenjs cannot rasterize an SVG preview on a
 * server, so an SVG logo is left out with a warning).
 */

import PptxGenJSImport from 'pptxgenjs';
import type { ReportDocument, ReportFigure } from './content.js';
import { bareHex, fitLogo, tint, type ReportBrand } from './brand.js';
import { OFFICE_FONT } from './font.js';
import type { InlineRun, MdBlock } from './markdown.js';
import { buildSlides, coverMeta, DECK, type Slide } from './slides.js';

// The ESM build default-exports the class; some loaders (tsx) hand over the
// CommonJS build's namespace instead, with the class under `default`.
const PptxGenJS = (PptxGenJSImport as unknown as { default?: typeof PptxGenJSImport }).default ?? PptxGenJSImport;
type PptxGenJS = InstanceType<typeof PptxGenJSImport>;

const TEXT = '1F2933';
const MUTED = '6B7280';
const RULE = 'E5E7EB';
const CODE_BG = 'F3F4F6';
const W = 13.333;
const H = 7.5;
const X = 0.6;
const BODY_Y = 1.35;
const BODY_W = W - 2 * X;
const BODY_H = H - BODY_Y - 0.75;

type TextProp = { text: string; options?: Record<string, unknown> };

function runProps(runs: InlineRun[], brand: ReportBrand, base: Record<string, unknown> = {}): TextProp[] {
  return runs.map((run) => ({
    text: run.text,
    options: {
      ...base,
      ...(run.bold ? { bold: true } : {}),
      ...(run.italic ? { italic: true } : {}),
      ...(run.strike ? { strike: 'sngStrike' } : {}),
      ...(run.code ? { highlight: CODE_BG } : {}),
      ...(run.link ? { hyperlink: { url: run.link }, color: bareHex(brand.color) } : {}),
    },
  }));
}

/** One paragraph: paragraph options go on its first run, the line break on its last. */
function paragraph(runs: TextProp[], options: Record<string, unknown>): TextProp[] {
  if (runs.length === 0) runs = [{ text: ' ' }];
  return runs.map((run, index) => ({
    text: run.text,
    options: {
      ...(index === 0 ? options : {}),
      ...run.options,
      ...(index === runs.length - 1 ? { breakLine: true } : {}),
    },
  }));
}

function textBlocks(blocks: MdBlock[], brand: ReportBrand): TextProp[] {
  const out: TextProp[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        out.push(...paragraph(runProps(block.runs, brand, { bold: true, fontSize: 18 }), { paraSpaceAfter: 6 }));
        break;
      case 'paragraph':
        out.push(...paragraph(runProps(block.runs, brand), { paraSpaceAfter: 8 }));
        break;
      case 'quote':
        out.push(...paragraph(runProps(block.runs, brand, { color: MUTED }), { paraSpaceAfter: 8, indentLevel: 1 }));
        break;
      case 'code':
        for (const line of block.text.split('\n')) {
          out.push(...paragraph([{ text: line || ' ', options: { fontSize: DECK.codeSize, highlight: CODE_BG } }], {}));
        }
        break;
      case 'list':
        for (const item of block.items) {
          const runs = item.ordered ? [{ text: `${item.number}. ` }, ...item.runs] : item.runs;
          out.push(
            ...paragraph(runProps(runs, brand), {
              ...(item.ordered ? { indentLevel: item.depth } : { bullet: { indent: 18 }, indentLevel: item.depth }),
              paraSpaceAfter: 6,
            }),
          );
        }
        break;
      case 'rule':
        out.push(...paragraph([{ text: ' ' }], {}));
        break;
      case 'table':
        // Tables in prose get their own slide (slides.ts); never reached.
        break;
    }
  }
  return out;
}

function addTable(slide: PptxGenJSImport.Slide, header: InlineRun[][], rows: InlineRun[][][], brand: ReportBrand) {
  const fill = bareHex(tint(brand.color, 0.86));
  slide.addTable(
    [
      header.map((cell) => ({ text: runProps(cell, brand, { bold: true }), options: { fill: { color: fill } } })),
      ...rows.map((row) => row.map((cell) => ({ text: runProps(cell, brand) }))),
    ],
    {
      x: X,
      y: BODY_Y,
      w: BODY_W,
      fontFace: OFFICE_FONT,
      fontSize: DECK.tableSize,
      color: TEXT,
      border: { type: 'solid', pt: 0.75, color: RULE },
      margin: 0.08,
      valign: 'middle',
    },
  );
}

function addFigures(pptx: PptxGenJS, slide: PptxGenJSImport.Slide, figures: ReportFigure[], brand: ReportBrand) {
  const gap = 0.3;
  const w = (BODY_W - gap * (figures.length - 1)) / figures.length;
  figures.forEach((figure, index) => {
    slide.addText(
      [
        { text: figure.value, options: { fontSize: 40, bold: true, color: bareHex(brand.color), breakLine: true } },
        { text: figure.label, options: { fontSize: 16, color: TEXT, breakLine: Boolean(figure.note) } },
        ...(figure.note ? [{ text: figure.note, options: { fontSize: 12, color: MUTED } }] : []),
      ],
      {
        shape: pptx.ShapeType.rect,
        x: X + index * (w + gap),
        y: BODY_Y + 0.6,
        w,
        h: 2.4,
        fill: { color: bareHex(tint(brand.color, 0.92)) },
        fontFace: OFFICE_FONT,
        valign: 'middle',
        margin: 12,
        fit: 'shrink',
      },
    );
  });
}

function logoImage(brand: ReportBrand, maxW: number, maxH: number) {
  const logo = brand.logo;
  if (!logo || (logo.kind !== 'png' && logo.kind !== 'jpeg')) return null;
  // fitLogo works in points; slides in inches.
  const size = fitLogo(logo, maxW * 72, maxH * 72);
  return {
    data: `image/${logo.kind};base64,${logo.bytes.toString('base64')}`,
    w: size.width / 72,
    h: size.height / 72,
  };
}

export async function renderPptx(document: ReportDocument, brand: ReportBrand): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = document.cover.author ?? brand.name;
  pptx.company = brand.name;
  pptx.title = document.cover.title;
  pptx.subject = `${document.template.name} (template v${document.template.version})`;
  const color = bareHex(brand.color);
  const small = logoImage(brand, 1.4, 0.35);

  pptx.defineSlideMaster({
    title: 'REPORT_BODY',
    background: { color: 'FFFFFF' },
    objects: [
      { rect: { x: 0, y: 0, w: W, h: 0.09, fill: { color } } },
      small
        ? { image: { x: X, y: H - 0.55, ...small } }
        : {
            text: {
              text: brand.name,
              options: { x: X, y: H - 0.6, w: 5, h: 0.35, fontFace: OFFICE_FONT, fontSize: 11, bold: true, color },
            },
          },
    ],
    slideNumber: {
      x: W - X - 1,
      y: H - 0.6,
      w: 1,
      h: 0.35,
      fontFace: OFFICE_FONT,
      fontSize: 11,
      color: MUTED,
      align: 'right',
    },
  });

  // Cover.
  const cover = pptx.addSlide();
  cover.background = { color: 'FFFFFF' };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.28, h: H, fill: { color } });
  const big = logoImage(brand, 2.6, 0.75);
  if (big) cover.addImage({ x: 0.9, y: 1.1, ...big });
  else {
    cover.addText(brand.name, { x: 0.9, y: 1.1, w: 8, h: 0.5, fontFace: OFFICE_FONT, fontSize: 18, bold: true, color });
  }
  const { subtitle, meta } = coverMeta(document);
  cover.addText(
    [
      { text: document.cover.title, options: { fontSize: 40, bold: true, color: TEXT, breakLine: true } },
      ...(subtitle
        ? [{ text: subtitle, options: { fontSize: 22, color: MUTED, breakLine: true, paraSpaceBefore: 8 } }]
        : []),
      ...(meta ? [{ text: meta, options: { fontSize: 15, color: MUTED, paraSpaceBefore: 22 } }] : []),
    ],
    { x: 0.9, y: 2.3, w: W - 1.8, h: 3.6, fontFace: OFFICE_FONT, valign: 'top', fit: 'shrink' },
  );

  for (const slide of buildSlides(document)) addBodySlide(pptx, slide, brand);

  // 'STREAM' is pptxgenjs's Node buffer output that honours `compression`;
  // 'nodebuffer' silently stores every part uncompressed (a long deck ran ~10x larger).
  const out = await pptx.write({ outputType: 'STREAM', compression: true });
  return Buffer.isBuffer(out) ? out : Buffer.from(out as ArrayBuffer);
}

function addBodySlide(pptx: PptxGenJS, slide: Slide, brand: ReportBrand) {
  const page = pptx.addSlide({ masterName: 'REPORT_BODY' });
  page.addText(slide.title, {
    x: X,
    y: 0.4,
    w: BODY_W,
    h: 0.75,
    fontFace: OFFICE_FONT,
    fontSize: DECK.titleSize,
    bold: true,
    color: TEXT,
    valign: 'middle',
    fit: 'shrink',
  });
  const body = slide.body;
  if (body.type === 'text') {
    page.addText(textBlocks(body.blocks, brand), {
      x: X,
      y: BODY_Y,
      w: BODY_W,
      h: BODY_H,
      fontFace: OFFICE_FONT,
      fontSize: DECK.bodySize,
      color: TEXT,
      valign: 'top',
      fit: 'shrink',
    });
  } else if (body.type === 'table') addTable(page, body.header, body.rows, brand);
  else addFigures(pptx, page, body.figures, brand);
}

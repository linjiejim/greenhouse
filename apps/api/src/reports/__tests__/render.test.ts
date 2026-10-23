/**
 * Every renderer produces a real file of its format, with the Chinese text in
 * it: the PDF parses (pdf.js via unpdf) with the expected pages and text — and
 * Files' own reader gets the text back, as an agent would with files.read;
 * the Word and PowerPoint files are zips with the expected parts and the text
 * in their XML. Also pinned: the brand colour and logo reach the files, an
 * SVG logo is left out of Word with a warning, characters the embedded font
 * lacks are reported, and decks cut long content into numbered slides.
 */

import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import { extractText } from '../../files/extract-text.js';
import type { ReportDocument } from '../content.js';
import type { ReportBrand } from '../brand.js';
import { parseLogoDataUrl } from '../brand.js';
import { missingGlyphs } from '../font.js';
import { renderReport } from '../render.js';
import { buildSlides } from '../slides.js';
import { parseMarkdown } from '../markdown.js';

// A 1x1 PNG: real magic bytes and IHDR.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const brand: ReportBrand = { name: '绿房子 Greenhouse', color: '#1D4ED8', logo: null };

function document(kind: ReportDocument['kind'], format: ReportDocument['format']): ReportDocument {
  return {
    template: { id: 'rtpl_t', name: '周报', version: 2 },
    kind,
    format,
    cover: { title: '研发周报第四十三周', subtitle: '季度冲刺', author: '林杰', period: '2026-10-19 — 10-25' },
    sections: [
      {
        key: 'summary',
        title: '本周摘要',
        body: {
          kind: 'markdown',
          markdown:
            '本周完成了**报告模板**的设计。\n\n- 模板存储\n- 渲染服务\n\n| 项目 | 状态 |\n|---|---|\n| 字体 | 完成 |',
        },
      },
      {
        key: 'metrics',
        title: '关键数据',
        body: {
          kind: 'figures',
          figures: [
            { label: '活跃成员', value: '42', note: '环比增长' },
            { label: '写入', value: '1204' },
          ],
        },
      },
      {
        key: 'risks',
        title: '风险',
        body: { kind: 'table', columns: ['风险', '负责人'], rows: [['字体体积', '张伟']] },
      },
      { key: 'next', title: '下周计划', body: { kind: 'bullets', items: ['上线发布', '收集反馈'] } },
    ],
  };
}

const CJK = ['研发周报第四十三周', '本周摘要', '报告模板', '活跃成员', '字体体积', '下周计划', '收集反馈'];

function zipEntries(bytes: Buffer): Record<string, string> {
  const files = unzipSync(new Uint8Array(bytes));
  return Object.fromEntries(
    Object.entries(files).map(([name, data]) => [
      name,
      name.endsWith('.xml') || name.endsWith('.rels') ? strFromU8(data) : '',
    ]),
  );
}

async function pdfText(bytes: Buffer): Promise<{ pages: number; text: string }> {
  const { getDocumentProxy, extractText: pdfjsText } = await import('unpdf');
  const proxy = await getDocumentProxy(new Uint8Array(bytes));
  const { text, totalPages } = await pdfjsText(proxy, { mergePages: true });
  return { pages: totalPages, text: text.replace(/\s+/g, '') };
}

describe('PDF', () => {
  it('renders a report: a parseable PDF with every section and the Chinese text', async () => {
    const out = await renderReport(document('report', 'pdf'), brand);
    expect(out.extension).toBe('pdf');
    expect(out.contentType).toBe('application/pdf');
    expect(out.bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(out.warnings).toEqual([]);
    const { pages, text } = await pdfText(out.bytes);
    expect(pages).toBeGreaterThanOrEqual(1);
    for (const phrase of CJK) expect(text).toContain(phrase);
    // The brand name rides the header/title block; the template name the footer.
    expect(text).toContain('绿房子');
    // Files' own reader (files.read for agents) gets the text back too.
    const read = await extractText(out.bytes, 'report.pdf', 'application/pdf');
    expect(read.ok && read.text.replace(/\s+/g, '')).toContain('本周摘要');
  });

  it('renders a deck as one page per slide plus the cover', async () => {
    const doc = document('presentation', 'pdf');
    const out = await renderReport(doc, brand);
    const { pages, text } = await pdfText(out.bytes);
    expect(pages).toBe(buildSlides(doc).length + 1);
    for (const phrase of CJK) expect(text).toContain(phrase);
  });

  it('embeds only a subset of the CJK font', async () => {
    const out = await renderReport(document('report', 'pdf'), brand);
    // The full subset on disk is ~2.4 MB per weight; a PDF carries only the glyphs it uses.
    expect(out.bytes.length).toBeLessThan(300_000);
  });

  it('reports characters the embedded font does not have', async () => {
    const doc = document('report', 'pdf');
    doc.sections[0]!.body = { kind: 'markdown', markdown: '上线了 🌱 龘' };
    const out = await renderReport(doc, brand);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toContain('🌱');
    expect(out.warnings[0]).toContain('龘');
    expect(missingGlyphs('报告 Report — 第①项 ✓')).toEqual([]);
  });

  it('embeds a PNG and an SVG logo', async () => {
    const png = parseLogoDataUrl(`data:image/png;base64,${PNG.toString('base64')}`)!;
    expect(png).toMatchObject({ kind: 'png', width: 1, height: 1 });
    const withPng = await renderReport(document('report', 'pdf'), { ...brand, logo: png });
    expect(withPng.bytes.toString('latin1')).toContain('/Subtype /Image');
    const svg = parseLogoDataUrl(
      `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><rect width="40" height="20" fill="#0a0"/></svg>')}`,
    )!;
    expect(svg).toMatchObject({ kind: 'svg', width: 40, height: 20 });
    const withSvg = await renderReport(document('report', 'pdf'), { ...brand, logo: svg });
    expect(withSvg.warnings).toEqual([]);
  });
});

describe('Word', () => {
  it('renders a .docx with the document parts, the text and the brand colour', async () => {
    const out = await renderReport(document('report', 'docx'), brand);
    expect(out.extension).toBe('docx');
    expect(out.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    const entries = zipEntries(out.bytes);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'word/document.xml', 'word/styles.xml', 'word/numbering.xml']),
    );
    const body = entries['word/document.xml']!;
    for (const phrase of CJK) expect(body).toContain(phrase);
    expect(body).toContain('1D4ED8');
    // Header (brand) and footer (page numbers) parts exist.
    expect(Object.keys(entries).some((name) => /^word\/header\d*\.xml$/.test(name))).toBe(true);
    expect(Object.values(entries).some((xml) => xml.includes('NUMPAGES'))).toBe(true);
    // Files' own reader gets the text back.
    const read = await extractText(out.bytes, 'report.docx', '');
    expect(read.ok && read.text).toContain('本周摘要');
  });

  it('embeds a PNG logo, and leaves an SVG one out with a warning', async () => {
    const png = parseLogoDataUrl(`data:image/png;base64,${PNG.toString('base64')}`)!;
    const withPng = await renderReport(document('report', 'docx'), { ...brand, logo: png });
    expect(Object.keys(zipEntries(withPng.bytes)).some((name) => name.startsWith('word/media/'))).toBe(true);
    const svg = parseLogoDataUrl('data:image/svg+xml;utf8,%3Csvg%20width%3D%2210%22%20height%3D%2210%22%2F%3E')!;
    const withSvg = await renderReport(document('report', 'docx'), { ...brand, logo: svg });
    expect(withSvg.warnings[0]).toContain('SVG');
    expect(Object.keys(zipEntries(withSvg.bytes)).some((name) => name.startsWith('word/media/'))).toBe(false);
  });
});

describe('PowerPoint', () => {
  it('renders a .pptx: a cover and one slide per slides.ts slide, with the text', async () => {
    const doc = document('presentation', 'pptx');
    const out = await renderReport(doc, brand);
    expect(out.extension).toBe('pptx');
    expect(out.bytes.subarray(0, 2).toString('latin1')).toBe('PK');
    // Compressed: stored uncompressed, this deck's parts weigh well over 100 KB.
    expect(out.bytes.length).toBeLessThan(80_000);
    const entries = zipEntries(out.bytes);
    expect(Object.keys(entries)).toEqual(
      expect.arrayContaining(['[Content_Types].xml', 'ppt/presentation.xml', 'ppt/slides/slide1.xml']),
    );
    const slides = Object.keys(entries).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name));
    expect(slides).toHaveLength(buildSlides(doc).length + 1);
    const all = slides.map((name) => entries[name]).join('');
    for (const phrase of CJK) expect(all).toContain(phrase);
    expect(Object.values(entries).join('')).toContain('1D4ED8');
  });

  it('embeds a PNG logo', async () => {
    const png = parseLogoDataUrl(`data:image/png;base64,${PNG.toString('base64')}`)!;
    const out = await renderReport(document('presentation', 'pptx'), { ...brand, logo: png });
    expect(out.warnings).toEqual([]);
    expect(Object.keys(zipEntries(out.bytes)).some((name) => name.startsWith('ppt/media/'))).toBe(true);
  });
});

describe('slides', () => {
  it('splits long bullets, tables and figures into numbered continuation slides', () => {
    const doc = document('presentation', 'pptx');
    doc.sections = [
      {
        key: 'b',
        title: '要点',
        body: { kind: 'bullets', items: Array.from({ length: 30 }, (_, i) => `第 ${i + 1} 条`) },
      },
      {
        key: 't',
        title: '表格',
        body: { kind: 'table', columns: ['A'], rows: Array.from({ length: 20 }, (_, i) => [`${i}`]) },
      },
      {
        key: 'f',
        title: '数据',
        body: { kind: 'figures', figures: Array.from({ length: 6 }, (_, i) => ({ label: `L${i}`, value: `${i}` })) },
      },
    ];
    const titles = buildSlides(doc).map((slide) => slide.title);
    expect(titles.filter((t) => t.startsWith('要点'))).toEqual(['要点 (1/3)', '要点 (2/3)', '要点 (3/3)']);
    expect(titles.filter((t) => t.startsWith('表格'))).toEqual(['表格 (1/3)', '表格 (2/3)', '表格 (3/3)']);
    expect(titles.filter((t) => t.startsWith('数据'))).toEqual(['数据 (1/2)', '数据 (2/2)']);
  });

  it('puts a Markdown table on its own slide', () => {
    const slides = buildSlides(document('presentation', 'pptx'));
    expect(slides.slice(0, 2).map((slide) => slide.body.type)).toEqual(['text', 'table']);
  });
});

describe('markdown', () => {
  it('parses blocks and inline runs, and never keeps unsafe links', () => {
    const blocks = parseMarkdown(
      '## 标题\n\n**粗** _斜_ `代码` [链接](https://example.com) [坏](javascript:alert(1))\n\n1. 一\n2. 二\n   - 嵌套\n\n> 引用\n\n---\n\n```\ncode\n```',
    );
    expect(blocks.map((b) => b.type)).toEqual(['heading', 'paragraph', 'list', 'quote', 'rule', 'code']);
    const paragraph = blocks[1] as Extract<(typeof blocks)[number], { type: 'paragraph' }>;
    expect(paragraph.runs).toEqual(
      expect.arrayContaining([
        { text: '粗', bold: true },
        { text: '斜', italic: true },
        { text: '代码', code: true },
        { text: '链接', link: 'https://example.com' },
        { text: ' 坏' }, // the javascript: link is dropped, its text kept
      ]),
    );
    const list = blocks[2] as Extract<(typeof blocks)[number], { type: 'list' }>;
    expect(list.items.map((item) => [item.depth, item.ordered, item.number])).toEqual([
      [0, true, 1],
      [0, true, 2],
      [1, false, 1],
    ]);
  });
});

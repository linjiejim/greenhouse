/**
 * The font reports are rendered in.
 *
 * PDFs embed Noto Sans SC (SIL OFL 1.1), subset to GB2312 + Latin + common
 * symbols by scripts/build-report-fonts.sh — ~2.4 MB per weight on disk;
 * pdfkit subsets again per document, so a PDF only carries the glyphs it
 * uses. Word and PowerPoint files do not embed fonts: they name
 * `OFFICE_FONT`, which every Office install has, and viewers without it
 * substitute their own CJK face.
 *
 * `missingGlyphs` reads the subset's own cmap, so the renderer can tell the
 * caller exactly which characters will show as blanks instead of failing
 * silently.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPORT_FONTS_DIR } from '../paths.js';

export const PDF_FONT_FAMILY = 'NotoSansSC';
export const OFFICE_FONT = 'Microsoft YaHei';

const FILES = {
  normal: 'NotoSansSC-Regular.subset.ttf',
  bold: 'NotoSansSC-Bold.subset.ttf',
} as const;

let cached: { normal: Buffer; bold: Buffer; coverage: Set<number> } | null = null;

function load() {
  if (!cached) {
    const normal = readFileSync(resolve(REPORT_FONTS_DIR, FILES.normal));
    const bold = readFileSync(resolve(REPORT_FONTS_DIR, FILES.bold));
    cached = { normal, bold, coverage: readCmapCodePoints(normal) };
  }
  return cached;
}

/** The two weights as bytes (read once per process). */
export function reportFontBytes(): { normal: Buffer; bold: Buffer } {
  const { normal, bold } = load();
  return { normal, bold };
}

/** Characters in `text` the embedded font has no glyph for (unique, in order, whitespace ignored). */
export function missingGlyphs(text: string): string[] {
  const { coverage } = load();
  const missing = new Set<string>();
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp < 0x20 || char.trim() === '' || coverage.has(cp)) continue;
    missing.add(char);
  }
  return [...missing];
}

/** Byte offset of a table in a TrueType font, or -1. */
function tableOffset(font: Buffer, tag: string): number {
  const numTables = font.readUInt16BE(4);
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (font.toString('latin1', rec, rec + 4) === tag) return font.readUInt32BE(rec + 8);
  }
  return -1;
}

/**
 * Every code point a TrueType font maps, with its glyph id, from its cmap
 * (format 4 or 12, the Unicode subtables). Throws on a font with neither.
 */
export function readCmap(font: Buffer): Map<number, number> {
  const cmap = tableOffset(font, 'cmap');
  if (cmap < 0) throw new Error('font has no cmap table');
  const subtables = font.readUInt16BE(cmap + 2);
  let best: { format: number; offset: number } | null = null;
  for (let i = 0; i < subtables; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = font.readUInt16BE(rec);
    const encoding = font.readUInt16BE(rec + 2);
    const offset = cmap + font.readUInt32BE(rec + 4);
    const format = font.readUInt16BE(offset);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    if (!unicode || (format !== 4 && format !== 12)) continue;
    if (!best || (format === 12 && best.format === 4)) best = { format, offset };
  }
  if (!best) throw new Error('font has no Unicode cmap subtable');
  const glyphs = new Map<number, number>();
  const at = best.offset;
  if (best.format === 12) {
    const groups = font.readUInt32BE(at + 12);
    for (let g = 0; g < groups; g++) {
      const rec = at + 16 + g * 12;
      const start = font.readUInt32BE(rec);
      const end = font.readUInt32BE(rec + 4);
      const first = font.readUInt32BE(rec + 8);
      for (let cp = start; cp <= end; cp++) glyphs.set(cp, first + (cp - start));
    }
    return glyphs;
  }
  const segX2 = font.readUInt16BE(at + 6);
  const ends = at + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const rangeOffsets = deltas + segX2;
  for (let s = 0; s < segX2 / 2; s++) {
    const end = font.readUInt16BE(ends + s * 2);
    const start = font.readUInt16BE(starts + s * 2);
    const delta = font.readUInt16BE(deltas + s * 2);
    const rangeOffset = font.readUInt16BE(rangeOffsets + s * 2);
    for (let cp = start; cp <= end && cp !== 0xffff; cp++) {
      let glyph: number;
      if (rangeOffset === 0) glyph = (cp + delta) & 0xffff;
      else {
        const glyphAt = rangeOffsets + s * 2 + rangeOffset + (cp - start) * 2;
        glyph = font.readUInt16BE(glyphAt);
        if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
      }
      if (glyph !== 0) glyphs.set(cp, glyph);
    }
  }
  return glyphs;
}

/** Every code point a font maps. */
export function readCmapCodePoints(font: Buffer): Set<number> {
  return new Set(readCmap(font).keys());
}

export interface FontMetrics {
  /** One line of text at size 1 with lineHeight 1 — (ascender − descender + lineGap) / unitsPerEm, from hhea. */
  lineHeightEm: number;
  /** Advance width of a code point at size 1; a character the font lacks counts as a full em. */
  advanceEm(codePoint: number): number;
}

/** Line height and advance widths of a TrueType font, read from head / hhea / hmtx / cmap. */
export function readFontMetrics(font: Buffer): FontMetrics {
  const head = tableOffset(font, 'head');
  const hhea = tableOffset(font, 'hhea');
  const hmtx = tableOffset(font, 'hmtx');
  if (head < 0 || hhea < 0 || hmtx < 0) throw new Error('font lacks head / hhea / hmtx');
  const upm = font.readUInt16BE(head + 18);
  const ascender = font.readInt16BE(hhea + 4);
  const descender = font.readInt16BE(hhea + 6);
  const lineGap = font.readInt16BE(hhea + 8);
  const longMetrics = font.readUInt16BE(hhea + 34);
  const glyphs = readCmap(font);
  const advance = (glyph: number) => font.readUInt16BE(hmtx + Math.min(glyph, longMetrics - 1) * 4);
  return {
    lineHeightEm: (ascender - descender + lineGap) / upm,
    advanceEm: (codePoint) => {
      const glyph = glyphs.get(codePoint);
      return glyph === undefined ? 1 : advance(glyph) / upm;
    },
  };
}

let metrics: { normal: FontMetrics; bold: FontMetrics } | null = null;

/** Metrics of the embedded PDF font (read once per process) — what slide planning measures with. */
export function reportFontMetrics(): { normal: FontMetrics; bold: FontMetrics } {
  if (!metrics) {
    const { normal, bold } = load();
    metrics = { normal: readFontMetrics(normal), bold: readFontMetrics(bold) };
  }
  return metrics;
}

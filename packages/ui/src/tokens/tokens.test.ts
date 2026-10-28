import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, lightness } from './contrast';
import { MOBILE_TS_PATH, EMBED_TS_PATH, renderEmbedTs, renderMobileTs } from './render';
import { categorical, chartSeries, color, primaryRamp, type ColorToken, type ThemeMode } from './tokens';

const ROOT = resolve(__dirname, '../../../..');
const MODES: ThemeMode[] = ['light', 'dark'];

describe('generated token files', () => {
  it('the embed package is generated from the shared tokens', () => {
    expect(readFileSync(resolve(ROOT, EMBED_TS_PATH), 'utf8')).toBe(renderEmbedTs());
  });
  it('the mobile copy is generated from tokens.ts (run `pnpm tokens:build`)', () => {
    expect(readFileSync(resolve(ROOT, MOBILE_TS_PATH), 'utf8')).toBe(renderMobileTs());
  });
});

describe('token contrast', () => {
  // [foreground, background, minimum]: text 4.5:1; icons, focus and control boundaries 3:1.
  const pairs: Array<[ColorToken, ColorToken, number]> = [
    ['text', 'canvas', 7],
    ['text', 'chrome', 7],
    ['text', 'raised', 7],
    ['text', 'fill', 7],
    ['secondary', 'canvas', 4.5],
    ['secondary', 'chrome', 4.5],
    ['secondary', 'card', 4.5],
    ['secondary', 'raised', 4.5],
    ['secondary', 'fill', 4.5],
    ['tertiary', 'canvas', 4.5],
    ['tertiary', 'chrome', 4.5],
    ['tertiary', 'card', 4.5],
    ['tertiary', 'raised', 4.5],
    ['tertiary', 'deep', 4.5],
    ['faint', 'canvas', 4.5],
    ['faint', 'raised', 4.5],
    ['onAccent', 'accent', 4.5],
    ['onAccent', 'accentHover', 4.5],
    ['onDanger', 'dangerSolid', 4.5],
    ['onDanger', 'dangerSolidHover', 4.5],
    ['accentText', 'canvas', 4.5],
    ['accentText', 'chrome', 4.5],
    ['accentText', 'raised', 4.5],
    ['accentTextStrong', 'accentFill', 4.5],
    ['accentTextStrong', 'accentFillHover', 4.5],
    ['accentText', 'accentFill', 4.5],
    ['focus', 'canvas', 3],
    ['focus', 'chrome', 3],
    ['focus', 'raised', 3],
    ['success', 'successFill', 4.5],
    ['warning', 'warningFill', 4.5],
    ['danger', 'dangerFill', 4.5],
    ['info', 'infoFill', 4.5],
    ['success', 'canvas', 4.5],
    ['warning', 'canvas', 4.5],
    ['danger', 'canvas', 4.5],
    ['info', 'canvas', 4.5],
    ['danger', 'raised', 4.5],
  ];

  for (const mode of MODES) {
    // Translucent fills sit on the surface they are drawn over: the canvas.
    const base = color.canvas[mode];
    for (const [fg, bg, min] of pairs) {
      it(`${mode}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        expect(contrastRatio(color[fg][mode], color[bg][mode], base)).toBeGreaterThanOrEqual(min);
      });
    }

    for (const [name, pair] of Object.entries(categorical)) {
      it(`${mode}: categorical ${name} text on its fill ≥ 4.5:1`, () => {
        expect(contrastRatio(pair.fg[mode], pair.fill[mode])).toBeGreaterThanOrEqual(4.5);
      });
    }

    for (const series of chartSeries) {
      it(`${mode}: chart series ${series} on the canvas ≥ 3:1`, () => {
        const value = series === 'accent' ? color.accent[mode] : categorical[series].fg[mode];
        expect(contrastRatio(value, color.canvas[mode])).toBeGreaterThanOrEqual(3);
      });
    }

    for (const surface of ['canvas', 'chrome', 'deep'] as const) {
      it(`${mode}: the brand mark on ${surface} ≥ 3:1`, () => {
        expect(contrastRatio(color.brandMark[mode], color[surface][mode])).toBeGreaterThanOrEqual(3);
      });
    }

    it(`${mode}: the bounded selected edge reads against its fill and the page (≥ 3:1 light)`, () => {
      const min = mode === 'light' ? 3 : 1.8;
      for (const against of ['accentFill', 'canvas', 'sunken'] as const) {
        expect(contrastRatio(color.accentEdge[mode], color[against][mode], base)).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it('light: the selected fill is perceptibly off every neutral surface (≥ 3 L*)', () => {
    const selected = lightness(color.accentFill.light);
    for (const surface of ['canvas', 'sunken', 'chrome', 'surface', 'card', 'fill'] as const) {
      expect(Math.abs(selected - lightness(color[surface].light)), surface).toBeGreaterThanOrEqual(3);
    }
  });

  it('light: the prose wash is lighter than the selection fill', () => {
    expect(lightness(color.accentWash.light)).toBeGreaterThan(lightness(color.accentFill.light));
  });

  it('dark: selection is a translucent overlay that lifts off the track', () => {
    expect(color.accentFill.dark.startsWith('rgba(')).toBe(true);
    const selectedOnRaised = contrastRatio(color.accentFill.dark, color.sunken.dark, color.raised.dark);
    expect(selectedOnRaised).toBeGreaterThanOrEqual(1.25);
  });

  it('dark: surfaces are deep ink-green layers, back to front', () => {
    const order = ['canvas', 'chrome', 'raised', 'fill'] as const;
    for (const name of order) {
      const [r, g, b] = [1, 3, 5].map((i) => parseInt(color[name].dark.slice(i, i + 2), 16));
      // green leads, quietly: a tint, never a coloured panel
      expect(g!, `${name} leans green`).toBeGreaterThan(Math.max(r!, b!));
      expect(g! - Math.min(r!, b!), `${name} stays a tint`).toBeLessThanOrEqual(14);
    }
    for (let i = 1; i < order.length; i++) {
      expect(lightness(color[order[i]!].dark)).toBeGreaterThan(lightness(color[order[i - 1]!].dark));
    }
  });

  it('the green ramp runs light to dark and carries the accents', () => {
    const shades = Object.values(primaryRamp).map((hex) => lightness(hex));
    for (let i = 1; i < shades.length; i++) expect(shades[i]).toBeLessThan(shades[i - 1]!);
    expect(color.accent.light).toBe('#235D4D');
    expect(color.accent.dark).toBe('#B1D2BF');
  });

  it('the seed lime is never a text colour', () => {
    const textRoles: ColorToken[] = ['text', 'secondary', 'tertiary', 'faint', 'accentText', 'accentTextStrong'];
    for (const mode of MODES) for (const r of textRoles) expect(color[r][mode]).not.toBe(color.brandSeed[mode]);
  });
});

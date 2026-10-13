import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { categorical, chartSeries, color, type ThemeMode } from './haven';
import { contrastRatio } from './contrast';
import { renderHavenCss } from './render-css';

const MODES: ThemeMode[] = ['light', 'dark'];

describe('Native Haven tokens', () => {
  it('haven.css is generated from haven.ts (run `pnpm tokens:build`)', () => {
    const committed = readFileSync(fileURLToPath(new URL('./haven.css', import.meta.url)), 'utf8');
    expect(committed).toBe(renderHavenCss());
  });

  // [foreground, background, minimum] — text 4.5:1, icons / control boundaries / large text 3:1.
  const pairs: Array<[keyof typeof color, keyof typeof color, number]> = [
    ['text', 'canvas', 4.5],
    ['text', 'chrome', 4.5],
    ['text', 'raised', 4.5],
    ['text', 'hover', 4.5],
    ['text', 'selection', 4.5],
    ['secondary', 'canvas', 4.5],
    ['secondary', 'chrome', 4.5],
    ['secondary', 'surface', 4.5],
    ['secondary', 'raised', 4.5],
    ['tertiary', 'canvas', 3],
    ['tertiary', 'chrome', 3],
    ['tertiary', 'surface', 3],
    ['controlLine', 'canvas', 3],
    ['controlLine', 'chrome', 3],
    ['controlLine', 'surface', 3],
    ['onAccent', 'accent', 4.5],
    ['onAccent', 'accentHover', 4.5],
    ['accentText', 'canvas', 4.5],
    ['accentText', 'selection', 4.5],
    ['focus', 'canvas', 3],
    ['focus', 'chrome', 3],
    ['success', 'successFill', 4.5],
    ['warning', 'warningFill', 4.5],
    ['danger', 'dangerFill', 4.5],
    ['dangerHover', 'dangerFillHover', 4.5],
    ['onDanger', 'danger', 4.5],
    ['onDanger', 'dangerHover', 4.5],
    ['info', 'infoFill', 4.5],
    ['danger', 'canvas', 4.5],
  ];

  for (const mode of MODES) {
    for (const [fg, bg, min] of pairs) {
      it(`${mode}: ${fg} on ${bg} ≥ ${min}:1`, () => {
        expect(contrastRatio(color[fg][mode], color[bg][mode])).toBeGreaterThanOrEqual(min);
      });
    }

    for (const [name, pair] of Object.entries(categorical)) {
      it(`${mode}: categorical ${name} text on its fill ≥ 4.5:1`, () => {
        expect(contrastRatio(pair.fg[mode], pair.fill[mode])).toBeGreaterThanOrEqual(4.5);
      });
    }

    // The mark is a graphic (3:1). Its seed keeps the asset's olive, a decorative accent that reaches 3:1 on dark only.
    for (const surface of ['canvas', 'chrome', 'rail'] as const) {
      it(`${mode}: brand mark on ${surface} ≥ 3:1`, () => {
        expect(contrastRatio(color.brandMark[mode], color[surface][mode])).toBeGreaterThanOrEqual(3);
      });
      if (mode === 'dark')
        it(`dark: brand seed on ${surface} ≥ 3:1`, () => {
          expect(contrastRatio(color.brandSeed.dark, color[surface].dark)).toBeGreaterThanOrEqual(3);
        });
    }

    for (const series of chartSeries) {
      it(`${mode}: chart series ${series} on canvas ≥ 3:1`, () => {
        const value = series === 'accent' ? color.accent[mode] : categorical[series].fg[mode];
        expect(contrastRatio(value, color.canvas[mode])).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

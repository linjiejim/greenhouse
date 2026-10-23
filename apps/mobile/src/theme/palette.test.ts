import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { darkHex, lightHex } from './palette';

const PALETTES = [
  ['light', lightHex],
  ['dark', darkHex],
] as const;

describe('V1 palette contrast', () => {
  for (const [name, palette] of PALETTES) {
    it(`${name}: main text on content surfaces meets 7:1`, () => {
      for (const background of [palette.background, palette.secondaryGroupedBackground, palette.groupedBackground]) {
        expect(contrastRatio(palette.label, background)).toBeGreaterThanOrEqual(7);
      }
    });

    for (const bg of ['background', 'secondaryBackground', 'secondaryGroupedBackground'] as const) {
      it(`${name}: tertiary text and placeholders on ${bg} are readable`, () => {
        expect(contrastRatio(palette.tertiaryLabel, palette[bg])).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.placeholder, palette[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`${name}: labels on the accent (semibold, large) and accent text on its fill are readable`, () => {
      // the V1 brand green carries white button labels at the large-text level (3:1)
      expect(contrastRatio(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(palette.accentText, palette.accentFill, palette.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.link, palette.secondaryGroupedBackground)).toBeGreaterThanOrEqual(4.5);
    });

    for (const role of ['red', 'orange', 'green', 'blue'] as const) {
      it(`${name}: ${role} is readable on its fill and on content surfaces`, () => {
        for (const background of [palette[`${role}Fill`], palette.background, palette.secondaryGroupedBackground]) {
          expect(contrastRatio(palette[role], background)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it('separates light surfaces and lines from the canvas', () => {
    expect(contrastRatio(lightHex.tertiaryBackground, lightHex.background)).toBeGreaterThan(1.05);
    expect(contrastRatio(lightHex.separator, lightHex.background)).toBeGreaterThanOrEqual(1.45);
  });

  it('keeps the V1 brand green', () => {
    expect(lightHex.accent).toBe('#2E8B3D');
  });
});

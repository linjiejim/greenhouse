import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../../packages/ui/src/tokens/contrast';
import { color } from '../../../../packages/ui/src/tokens/haven';
import { nativeStatus } from './status.generated';
import { lightHex, darkHex } from './palette';
describe('native reading contrast', () => {
  for (const [name, palette] of [
    ['light', lightHex],
    ['dark', darkHex],
  ] as const) {
    for (const bg of ['background', 'secondaryBackground', 'secondaryGroupedBackground'] as const) {
      it(`${name}: tertiary text and placeholders on ${bg} are readable`, () => {
        expect(contrastRatio(palette.tertiaryLabel, palette[bg])).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.placeholder, palette[bg])).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
  it('separates light surfaces and lines from the canvas', () => {
    expect(contrastRatio(lightHex.tertiaryBackground, lightHex.background)).toBeGreaterThan(1.08);
    expect(contrastRatio(lightHex.separator, lightHex.background)).toBeGreaterThanOrEqual(1.45);
  });
});

describe('native status words', () => {
  for (const mode of ['light', 'dark'] as const) {
    const palette = mode === 'light' ? lightHex : darkHex;
    for (const [native, role] of [
      ['red', 'danger'],
      ['orange', 'warning'],
      ['green', 'success'],
      ['blue', 'info'],
    ] as const) {
      it(`${mode}: ${native} follows Haven and remains readable on its fill and content surfaces`, () => {
        expect(nativeStatus[mode][native]).toBe(color[role][mode]);
        const fill = `${native}Fill` as const;
        expect(nativeStatus[mode][fill]).toBe(color[`${role}Fill`][mode]);
        for (const background of [palette[fill], palette.background, palette.secondaryGroupedBackground]) {
          expect(contrastRatio(palette[native], background)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
    it(`${mode}: main text on content surfaces meets 7:1`, () => {
      for (const background of [palette.background, palette.secondaryGroupedBackground]) {
        expect(contrastRatio(palette.label, background)).toBeGreaterThanOrEqual(7);
      }
    });
  }
});

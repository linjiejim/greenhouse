import { describe, expect, it } from 'vitest';
import { contrastRatio } from '../../../../packages/ui/src/tokens/contrast';
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

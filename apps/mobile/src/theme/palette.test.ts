import { describe, expect, it } from 'vitest';
import { contrastRatio } from './contrast';
import { categorical, categoricalFor, darkHex, lightHex } from './palette';

const PALETTES = [
  ['light', lightHex],
  ['dark', darkHex],
] as const;

describe('palette contrast', () => {
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
      expect(contrastRatio(palette.onAccent, palette.accent)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accentText, palette.accentFill, palette.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.link, palette.secondaryGroupedBackground)).toBeGreaterThanOrEqual(4.5);
    });

    for (const role of ['red', 'orange', 'green', 'blue'] as const) {
      it(`${name}: a white glyph on the ${role} status tile is readable`, () => {
        expect(contrastRatio(palette.onTint, palette[`${role}Tile`])).toBeGreaterThanOrEqual(4.5);
      });

      it(`${name}: ${role} is readable on its fill and on content surfaces`, () => {
        for (const background of [palette[`${role}Fill`], palette.background, palette.secondaryGroupedBackground]) {
          expect(contrastRatio(palette[role], background)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  for (const [name, palette] of PALETTES) {
    it(`${name}: the sidebar's labels and its current place are readable`, () => {
      expect(contrastRatio(palette.label, palette.sidebarBackground)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(palette.secondaryLabel, palette.sidebarBackground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accentText, palette.sidebarSelection, palette.sidebarBackground)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('sets the light sidebar a layer under home, its current place visible on it', () => {
    expect(contrastRatio(lightHex.groupedBackground, lightHex.sidebarBackground)).toBeGreaterThan(1.05);
    expect(contrastRatio(lightHex.sidebarSelection, lightHex.sidebarBackground, lightHex.sidebarBackground)).toBeGreaterThan(1.1);
  });

  it('separates light surfaces and lines from the canvas', () => {
    expect(contrastRatio(lightHex.tertiaryBackground, lightHex.background)).toBeGreaterThan(1.05);
    expect(contrastRatio(lightHex.separator, lightHex.background)).toBeGreaterThanOrEqual(1.45);
  });

  it('takes the Haven accents: forest green in light, pale sage in dark', () => {
    expect(lightHex.accent).toBe('#235D4D');
    expect(darkHex.accent).toBe('#B1D2BF');
  });

  it('keeps the seed lime off every text role', () => {
    for (const palette of [lightHex, darkHex]) {
      for (const role of ['label', 'secondaryLabel', 'tertiaryLabel', 'placeholder', 'link', 'accentText'] as const) {
        expect(palette[role]).not.toBe(palette.seed);
      }
    }
  });

  it('sets sign-in on the brand canvas, not the system grey', () => {
    expect(lightHex.brandCanvas).not.toBe('#F2F2F7');
  });
});

describe('categorical colours for user-chosen hexes', () => {
  it('snaps saturated project colours onto the categorical pairs per appearance', () => {
    expect(categoricalFor('#ef4444', false)).toEqual(categorical.light.red);
    expect(categoricalFor('#8b5cf6', true)).toEqual(categorical.dark.purple);
    expect(categoricalFor('#3b82f6', false)).toEqual(categorical.light.blue);
    expect(categoricalFor('#888888', false)).toEqual(categorical.light.gray);
    expect(categoricalFor('not a colour', false)).toBeNull();
  });
});

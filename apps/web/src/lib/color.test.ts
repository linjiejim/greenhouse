/**
 * Color math tests — hex↔OKLCH round-trips and brand palette generation.
 */

import { describe, it, expect } from 'vitest';
import { hexToRgb, rgbToHex, rgbToOklch, oklchToRgb, generatePalette, PALETTE_SHADES } from './color';

describe('hex ↔ rgb', () => {
  it('parses and formats 6-digit hex (with or without #)', () => {
    expect(hexToRgb('#14b8a6')).toEqual({ r: 20, g: 184, b: 166 });
    expect(hexToRgb('14B8A6')).toEqual({ r: 20, g: 184, b: 166 });
    expect(rgbToHex({ r: 20, g: 184, b: 166 })).toBe('#14b8a6');
  });

  it('rejects malformed input', () => {
    expect(hexToRgb('#fff')).toBeNull();
    expect(hexToRgb('not-a-color')).toBeNull();
  });
});

describe('rgb ↔ oklch round-trip', () => {
  it('survives a round-trip within 1/255 per channel', () => {
    for (const hex of ['#14b8a6', '#3b82f6', '#dc2626', '#111827', '#f9fafb', '#000000', '#ffffff']) {
      const rgb = hexToRgb(hex)!;
      const back = oklchToRgb(rgbToOklch(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
});

describe('generatePalette', () => {
  it('reproduces the stock teal ramp from teal-500', () => {
    const palette = generatePalette('#14b8a6')!;
    // Spot-check a few shades against the app.css defaults. Tolerance ±4: the
    // reference ramp's hue drifts slightly per shade, and generation pins every
    // shade to the brand hue, so an exact match isn't expected.
    const expected: Record<number, [number, number, number]> = {
      50: [240, 253, 250],
      500: [20, 184, 166],
      900: [19, 78, 74],
    };
    for (const [shade, [r, g, b]] of Object.entries(expected)) {
      const got = palette[Number(shade) as (typeof PALETTE_SHADES)[number]];
      expect(Math.abs(got.r - r)).toBeLessThanOrEqual(4);
      expect(Math.abs(got.g - g)).toBeLessThanOrEqual(4);
      expect(Math.abs(got.b - b)).toBeLessThanOrEqual(4);
    }
  });

  it('produces a monotonically darkening in-gamut ramp for any hue', () => {
    for (const hex of ['#3b82f6', '#e11d48', '#f59e0b', '#6b7280']) {
      const palette = generatePalette(hex)!;
      let prevLuma = Infinity;
      for (const shade of PALETTE_SHADES) {
        const { r, g, b } = palette[shade];
        for (const v of [r, g, b]) {
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        expect(luma).toBeLessThan(prevLuma);
        prevLuma = luma;
      }
    }
  });

  it('returns null for invalid hex', () => {
    expect(generatePalette('teal')).toBeNull();
  });
});

/**
 * Color math for the Branding Studio — hex ↔ OKLCH and brand-palette
 * generation. Pure functions, no DOM. Hand-rolled (standard OKLab matrices)
 * to avoid a color-library dependency for one settings panel.
 */

export interface Rgb {
  r: number; // 0–255
  g: number;
  b: number;
}

export interface Oklch {
  L: number; // 0–1 lightness
  C: number; // chroma (≥0)
  h: number; // hue in degrees
}

export const PALETTE_SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
export type PaletteShade = (typeof PALETTE_SHADES)[number];

/** The upstream Teal palette — the lightness/chroma reference curve for generated ramps. */
const TEAL_REFERENCE: Record<PaletteShade, Rgb> = {
  50: { r: 240, g: 253, b: 250 },
  100: { r: 204, g: 251, b: 241 },
  200: { r: 153, g: 246, b: 228 },
  300: { r: 94, g: 234, b: 212 },
  400: { r: 45, g: 212, b: 191 },
  500: { r: 20, g: 184, b: 166 },
  600: { r: 13, g: 148, b: 136 },
  700: { r: 15, g: 118, b: 110 },
  800: { r: 17, g: 94, b: 89 },
  900: { r: 19, g: 78, b: 74 },
};

// ─── hex ↔ rgb ───────────────────────────────────────────

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to2 = (v: number) => Math.round(v).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

/** "r g b" triplet string as used by the --primary-* CSS variables. */
export function rgbToTriplet({ r, g, b }: Rgb): string {
  return `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`;
}

// ─── sRGB ↔ OKLab / OKLCH ────────────────────────────────

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const c = v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  return c * 255;
}

export function rgbToOklch(rgb: Rgb): Oklch {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.sqrt(a * a + bb * bb);
  const h = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { L, C, h };
}

/** OKLCH → sRGB without gamut handling; components may fall outside 0–255. */
function oklchToRgbUnclamped({ L, C, h }: Oklch): Rgb {
  const hr = (h * Math.PI) / 180;
  const a = C * Math.cos(hr);
  const b = C * Math.sin(hr);

  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.291485548 * b, 3);

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function inGamut({ r, g, b }: Rgb): boolean {
  return r >= -0.01 && r <= 255.01 && g >= -0.01 && g <= 255.01 && b >= -0.01 && b <= 255.01;
}

/** OKLCH → sRGB, reducing chroma (binary search) until the color fits the gamut. */
export function oklchToRgb(color: Oklch): Rgb {
  let rgb = oklchToRgbUnclamped(color);
  if (!inGamut(rgb)) {
    let lo = 0;
    let hi = color.C;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      rgb = oklchToRgbUnclamped({ ...color, C: mid });
      if (inGamut(rgb)) lo = mid;
      else hi = mid;
    }
    rgb = oklchToRgbUnclamped({ ...color, C: lo });
  }
  const clamp = (v: number) => Math.min(255, Math.max(0, v));
  return { r: clamp(rgb.r), g: clamp(rgb.g), b: clamp(rgb.b) };
}

// ─── Palette generation ──────────────────────────────────

/**
 * Generate a full primary-50…900 palette from one brand color.
 *
 * Each shade keeps the reference (Teal) ramp's lightness, scales the reference
 * chroma by the brand color's chroma relative to Teal-500, and takes the brand
 * hue — so brand = Teal-500 reproduces the stock ramp, and near-gray brand
 * colors produce a tasteful gray ramp instead of blowing up.
 */
export function generatePalette(brandHex: string): Record<PaletteShade, Rgb> | null {
  const brandRgb = hexToRgb(brandHex);
  if (!brandRgb) return null;
  const brand = rgbToOklch(brandRgb);
  const ref500 = rgbToOklch(TEAL_REFERENCE[500]);
  const chromaScale = ref500.C > 0 ? brand.C / ref500.C : 0;

  const out = {} as Record<PaletteShade, Rgb>;
  for (const shade of PALETTE_SHADES) {
    const ref = rgbToOklch(TEAL_REFERENCE[shade]);
    out[shade] = oklchToRgb({ L: ref.L, C: ref.C * chromaScale, h: brand.h });
  }
  return out;
}

// ─── Semantic status colors ──────────────────────────────

/** The three CSS values a semantic status token needs (e.g. --t-success*). */
export interface SemanticTokens {
  /** Solid accent — text + border (the picked color, used verbatim). */
  base: string;
  /** Faint fill behind the accent (subtle). */
  subtle: string;
  /** Readable foreground on the subtle fill (fg). */
  fg: string;
}

/**
 * Derive a coherent {base, subtle, fg} trio from one picked status color,
 * matching how Greenhouse's stock status tokens relate across light/dark.
 * `base` is kept verbatim; only the fill + foreground are computed, so the
 * swatch the user picks is exactly what they see.
 */
export function deriveSemantic(baseHex: string, isDark: boolean): SemanticTokens | null {
  const rgb = hexToRgb(baseHex);
  if (!rgb) return null;
  const { C, h } = rgbToOklch(rgb);

  if (isDark) {
    return {
      base: baseHex,
      // Translucent tint so the fill sits on any dark surface (matches stock).
      subtle: `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.14)`,
      fg: rgbToHex(oklchToRgb({ L: 0.82, C: Math.min(C, 0.12), h })),
    };
  }
  return {
    base: baseHex,
    subtle: rgbToHex(oklchToRgb({ L: 0.965, C: Math.min(C * 0.4, 0.05), h })),
    fg: rgbToHex(oklchToRgb({ L: 0.4, C: Math.min(C, 0.13), h })),
  };
}

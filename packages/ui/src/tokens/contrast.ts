/** WCAG 2.x contrast for hex (#RGB / #RRGGBB) and rgba() colours; a translucent colour sits on `base`. */

type Rgba = [number, number, number, number];

function parse(input: string): Rgba {
  const src = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(src);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    return [0, 2, 4].map((i) => parseInt(digits.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(src);
  const parts = fn?.[1]!.split(',').map((part) => parseFloat(part));
  if (!parts || parts.length < 3 || parts.some(Number.isNaN)) throw new Error(`Not a colour: ${input}`);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

/** `color` composited over an opaque `base`, as #RRGGBB. */
export function flatten(color: string, base = '#FFFFFF'): string {
  const [r, g, b, a] = parse(color);
  const [br, bg, bb] = parse(base);
  const mix = [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
  return `#${mix.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
}

function channel(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: string): number {
  const [r, g, b] = parse(color).map(channel) as Rgba;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast of `foreground` on `background`; translucent values are composited (background on `base`). */
export function contrastRatio(foreground: string, background: string, base = '#FFFFFF'): number {
  const bg = flatten(background, flatten(base));
  const fg = flatten(foreground, bg);
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L* (perceived lightness); contrast ratio is blind to small steps near white. */
export function lightness(color: string, base = '#FFFFFF'): number {
  const y = relativeLuminance(flatten(color, flatten(base)));
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
}

/** The rgb channels of a colour as an `r g b` triplet (the web's `--primary-*` form) and its alpha. */
export function rgbTriplet(color: string): { triplet: string; alpha: number } {
  const [r, g, b, a] = parse(color);
  return { triplet: `${Math.round(r)} ${Math.round(g)} ${Math.round(b)}`, alpha: a };
}

/** WCAG contrast between two colors (`#RGB`, `#RRGGBB`, `rgba()` over its background). React-free. */

function channels(color: string): [number, number, number, number] {
  const src = color.trim();
  if (src.startsWith('#')) {
    let h = src.slice(1);
    if (h.length === 3) h = [...h].map((ch) => ch + ch).join('');
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
  }
  const parts = /^rgba?\(([^)]+)\)$/i
    .exec(src)?.[1]
    .split(',')
    .map((part) => parseFloat(part));
  if (!parts || parts.length < 3) throw new Error(`Unreadable color ${color}`);
  return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** A translucent color composited over an opaque background. */
function over(color: string, background: string): [number, number, number] {
  const [r, g, b, a] = channels(color);
  const [br, bg, bb] = channels(background);
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a)];
}

/** `base`: what a translucent background sits on (the page's own surface). */
export function contrastRatio(foreground: string, background: string, base = '#FFFFFF'): number {
  const bg = over(background, base);
  const fg = over(foreground, `#${bg.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

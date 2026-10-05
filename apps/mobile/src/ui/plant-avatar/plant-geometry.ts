// VENDORED from packages/ui/src/components/plant-avatar/plant-geometry.ts — do not edit here.
// Re-copy it verbatim minus the contrast/hue helpers (luminance, contrast, hueOf: the core tests and
// the legacy resolver use them, mobile does not) and run the parity test (see apps/mobile/AGENTS.md).

/**
 * Plant-avatar path + colour math (internal to the plant-avatar module).
 *
 * Silhouettes are authored as short anchor-point lists on the 100×100 viewBox and
 * smoothed (Catmull-Rom → cubic Bézier) once at module load. Every expression here
 * mirrors the reference builder operation for operation: the output is compared
 * byte for byte, so do not "simplify" the arithmetic.
 */

// ─── numbers ────────────────────────────────────────────────────────────────

/** One decimal, no negative zero. */
export function f(n: number): string {
  const v = Math.round(n * 10) / 10;
  return Object.is(v, -0) ? '0' : String(v);
}
/** Integer (ring paths — cheap at list sizes). */
export function fi(n: number): string {
  return String(Math.round(n));
}
/** Three decimals, no negative zero (scales). */
export function f2(n: number): string {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
}

// ─── points & paths ─────────────────────────────────────────────────────────

/** `[x, y]` is a smooth anchor; `[x, y, 1]` a sharp corner (leaf tips, notches). */
export type Pt = [x: number, y: number, corner?: 1];

/** Smooth closed (or open) path through anchor points. */
export function smooth(points: readonly Pt[], closed = true, tension = 1, prec = 1): string {
  const fmt = prec ? f : fi;
  const n = points.length;
  const at = (i: number): Pt => (closed ? points[(i + n) % n]! : points[Math.max(0, Math.min(n - 1, i))]!);
  let d = `M${fmt(points[0]![0])} ${fmt(points[0]![1])}`;
  const segs = closed ? n : n - 1;
  const k = tension / 6;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1);
    const p1 = at(i);
    const p2 = at(i + 1);
    const p3 = at(i + 2);
    const c1 = p1[2]
      ? [p1[0] + (p2[0] - p1[0]) * 0.3, p1[1] + (p2[1] - p1[1]) * 0.3]
      : [p1[0] + (p2[0] - p0[0]) * k, p1[1] + (p2[1] - p0[1]) * k];
    const c2 = p2[2]
      ? [p2[0] - (p2[0] - p1[0]) * 0.3, p2[1] - (p2[1] - p1[1]) * 0.3]
      : [p2[0] - (p3[0] - p1[0]) * k, p2[1] - (p3[1] - p1[1]) * k];
    d += `C${fmt(c1[0]!)} ${fmt(c1[1]!)} ${fmt(c2[0]!)} ${fmt(c2[1]!)} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}

/** Mirror a right half (top-centre → bottom-centre, x ≥ axis) into a full loop. */
export function sym(right: readonly Pt[], axis = 50): Pt[] {
  const left = right
    .slice(1, -1)
    .reverse()
    .map(([x, y, c]): Pt => (c ? [2 * axis - x, y, 1] : [2 * axis - x, y]));
  return right.concat(left);
}

export interface PointTransform {
  /** Degrees, clockwise on screen. */
  rot?: number;
  cx?: number;
  cy?: number;
  s?: number;
  sx?: number;
  sy?: number;
  dx?: number;
  dy?: number;
}

/** Rotate / scale / translate point lists about (cx, cy). */
export function xf(
  points: readonly Pt[],
  { rot = 0, cx = 50, cy = 50, s = 1, sx = s, sy = s, dx = 0, dy = 0 }: PointTransform = {},
): Pt[] {
  const a = (rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map(([x, y, c]): Pt => {
    const X = (x - cx) * sx;
    const Y = (y - cy) * sy;
    const out: Pt = [cx + X * cos - Y * sin + dx, cy + X * sin + Y * cos + dy];
    return c ? [out[0], out[1], 1] : out;
  });
}

export const circ = (cx: number, cy: number, r: number): string =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
export const ell = (cx: number, cy: number, rx: number, ry: number): string =>
  `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;

/** Parse "x,y x,y* …" into points (`*` = sharp corner). */
export function pts(str: string): Pt[] {
  return str
    .trim()
    .split(/\s+/)
    .map((tok): Pt => {
      const corner = tok.endsWith('*');
      const [x = 0, y = 0] = tok.replace('*', '').split(',').map(Number);
      return corner ? [x, y, 1] : [x, y];
    });
}
export const sm = (str: string, closed = true, tension = 1): string => smooth(pts(str), closed, tension);
export const smx = (str: string, t: PointTransform, closed = true): string => smooth(xf(pts(str), t), closed);
export const mirror = (p: readonly Pt[]): Pt[] => p.map(([x, y, c]): Pt => (c ? [100 - x, y, 1] : [100 - x, y]));
const ring = (p: readonly Pt[], n: number, offset = 0, s = 1): Pt[][] =>
  Array.from({ length: n }, (_, i) => xf(p, { rot: offset + (360 / n) * i, s }));
/** n rotated copies merged into one path (one element; nonzero fill keeps overlaps solid). */
export const ringD = (p: readonly Pt[], n: number, offset = 0, s = 1): string =>
  ring(p, n, offset, s)
    .map((q) => smooth(q, true, 1, 0))
    .join('');
export const dots = (list: readonly Pt[], r: number): string => list.map(([x, y]) => circ(x, y, r)).join('');

/** Wavy closed ring (merged petals / scallops) — one subpath, cheap at list sizes. */
export function scallop(
  cx: number,
  cy: number,
  rOut: number,
  rIn: number,
  n: number,
  offset = 0,
  pointed = false,
): string {
  const p: Pt[] = [];
  for (let i = 0; i < n * 2; i++) {
    const a = ((offset + (180 / n) * i - 90) * Math.PI) / 180;
    const r = i % 2 ? rIn : rOut;
    const q: Pt = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    p.push(pointed && !(i % 2) ? [q[0], q[1], 1] : q);
  }
  return smooth(p);
}

/** Sunflower seed head: a Fibonacci spiral of dots. */
export function fibSeeds(cx: number, cy: number, R: number, n: number): string {
  let out = '';
  for (let i = 1; i <= n; i++) {
    const r = R * Math.sqrt(i / n) * 0.92;
    const a = i * 2.39996;
    out += circ(cx + r * Math.cos(a), cy + r * Math.sin(a), 0.9 + (r / R) * 0.5);
  }
  return out;
}

// ─── colour (state treatments + contrast tests) ─────────────────────────────

type Rgb = [number, number, number];

const hexToRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const rgbToHex = (c: readonly number[]): string =>
  '#' +
  c
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase();

/** Linear RGB mix of two `#RRGGBB` colours (t = 0 → a, 1 → b). */
export function mix(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i]! - v) * t));
}

/** Pull a colour toward its own grey (keeps the hue family, lowers chroma). */
export function desaturate(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return rgbToHex([r + (y - r) * t, g + (y - g) * t, b + (y - b) * t]);
}

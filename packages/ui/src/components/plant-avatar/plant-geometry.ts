/**
 * Plant-avatar path + colour math (internal to the plant-avatar module).
 *
 * Flat geometric plants: every silhouette is built from circles, circular arcs and straight
 * lines on the 100×100 viewBox (the helpers below), once at module load. The apps/mobile copy
 * is compared byte for byte, so keep the arithmetic identical there.
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

// ─── flat geometric primitives (circular arcs + straight lines only) ─────────

/** Vesica leaf from base (x1, y1) to tip (x2, y2), `w` wide at the middle: two equal arcs. */
export function lens(x1: number, y1: number, x2: number, y2: number, w: number): string {
  const c = Math.hypot(x2 - x1, y2 - y1);
  const h = w / 2;
  const r = (c * c) / 4 / (2 * h) + h / 2;
  return `M${f(x1)} ${f(y1)}A${f(r)} ${f(r)} 0 0 1 ${f(x2)} ${f(y2)}A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y1)}Z`;
}

/**
 * Geometric heart (two semicircles on a 45° square): tip at (0, 24)·s, notch at (0, −20)·s,
 * lobes ±26.6·s wide, rotated `rot`° about its centre (cx, cy).
 */
export function heart(cx: number, cy: number, s: number, rot = 0): string {
  const a = (rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const P = (x: number, y: number) => `${f(cx + s * (x * cos - y * sin))} ${f(cy + s * (x * sin + y * cos))}`;
  const R = f(15.56 * s);
  return `M${P(0, 24)}L${P(-22, 2)}A${R} ${R} 0 0 1 ${P(0, -20)}A${R} ${R} 0 0 1 ${P(22, 2)}Z`;
}

/** Stadium between two centre points, radius r (a pill when vertical). */
export function capsule(x1: number, y1: number, x2: number, y2: number, r: number): string {
  const L = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (-(y2 - y1) / L) * r;
  const ny = ((x2 - x1) / L) * r;
  return (
    `M${f(x1 + nx)} ${f(y1 + ny)}L${f(x2 + nx)} ${f(y2 + ny)}A${f(r)} ${f(r)} 0 0 0 ${f(x2 - nx)} ${f(y2 - ny)}` +
    `L${f(x1 - nx)} ${f(y1 - ny)}A${f(r)} ${f(r)} 0 0 0 ${f(x1 + nx)} ${f(y1 + ny)}Z`
  );
}

/** Straight-edged polygon through "x,y x,y …" (sharp corners only). */
export const poly = (str: string): string =>
  'M' +
  pts(str)
    .map(([x, y]) => `${f(x)} ${f(y)}`)
    .join('L') +
  'Z';

/** Open polyline spiral about (cx, cy): radius r0 → r1 while the angle runs a0 → a1 (degrees, screen). */
export function spiral(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number, n = 36): string {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    const r = r0 + (r1 - r0) * t;
    d += `${i ? 'L' : 'M'}${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`;
  }
  return d;
}

const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => [
  cx + r * Math.cos((deg * Math.PI) / 180),
  cy + r * Math.sin((deg * Math.PI) / 180),
];

/**
 * Circle with V notches cut from the rim, or — with `fan` [from°, to°] — a fan (sector) that
 * closes through its centre. Notches are [angle°, half-width°, depth], sorted by angle; for a
 * full circle every notch lies within 360° of the first.
 */
export function notched(
  cx: number,
  cy: number,
  r: number,
  notches: readonly (readonly [number, number, number])[],
  fan?: readonly [from: number, to: number],
): string {
  const P = (rr: number, deg: number) => polar(cx, cy, rr, deg).map(f).join(' ');
  const arc = (from: number, to: number) =>
    to - from > 0.01 ? `A${f(r)} ${f(r)} 0 ${to - from > 180 ? 1 : 0} 1 ${P(r, to)}` : '';
  const vee = (deg: number, hw: number, depth: number) => `L${P(r - depth, deg)}L${P(r, deg + hw)}`;
  if (fan) {
    let d = `M${f(cx)} ${f(cy)}L${P(r, fan[0])}`;
    let at = fan[0];
    for (const [deg, hw, depth] of notches) {
      d += arc(at, deg - hw) + vee(deg, hw, depth);
      at = deg + hw;
    }
    return d + arc(at, fan[1]) + 'Z';
  }
  const [first, ...rest] = notches;
  if (!first) return circ(cx, cy, r);
  let at = first[0] + first[1];
  let d = `M${P(r, at)}`;
  for (const [deg, hw, depth] of rest) {
    d += arc(at, deg - hw) + vee(deg, hw, depth);
    at = deg + hw;
  }
  return d + arc(at, first[0] + 360 - first[1]) + `L${P(r - first[2], first[0] + 360)}Z`;
}

/** n lens petals around (cx, cy), from radius rIn to rOut, `w` wide, starting at `offset`° (0 = up). */
export function lensRing(cx: number, cy: number, n: number, rIn: number, rOut: number, w: number, offset = 0): string {
  let d = '';
  for (let i = 0; i < n; i++) {
    const deg = offset + (360 / n) * i - 90;
    const [x1, y1] = polar(cx, cy, rIn, deg);
    const [x2, y2] = polar(cx, cy, rOut, deg);
    d += lens(x1, y1, x2, y2, w);
  }
  return d;
}

/** n straight spokes from radius rIn to rOut (one stroked path), starting at `offset`° (0 = up). */
export function spokes(cx: number, cy: number, n: number, rIn: number, rOut: number, offset = 0): string {
  let d = '';
  for (let i = 0; i < n; i++) {
    const deg = offset + (360 / n) * i - 90;
    d += `M${polar(cx, cy, rIn, deg).map(f).join(' ')}L${polar(cx, cy, rOut, deg).map(f).join(' ')}`;
  }
  return d;
}

/** n dots of radius rd on a circle of radius R, starting at `offset`° (0 = up). */
export function dotRing(cx: number, cy: number, n: number, R: number, rd: number, offset = 0): string {
  let d = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = polar(cx, cy, R, offset + (360 / n) * i - 90);
    d += circ(x, y, rd);
  }
  return d;
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

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio. */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull a colour toward its own grey (keeps the hue family, lowers chroma). */
export function desaturate(hex: string, t: number): string {
  const [r, g, b] = hexToRgb(hex);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return rgbToHex([r + (y - r) * t, g + (y - g) * t, b + (y - b) * t]);
}

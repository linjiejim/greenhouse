/**
 * Plant-avatar path + colour math (internal to the plant-avatar module).
 *
 * Flat geometric plants: every silhouette is built from circles, circular arcs and straight
 * lines on the 100×100 viewBox (the helpers below), once at module load. The apps/mobile copy
 * is compared byte for byte, so keep the arithmetic identical there.
 */

// ─── numbers ────────────────────────────────────────────────────────────────

/** One decimal, no negative zero. */
export function f(n        )         {
  const v = Math.round(n * 10) / 10;
  return Object.is(v, -0) ? '0' : String(v);
}
/** Integer (ring paths — cheap at list sizes). */
export function fi(n        )         {
  return String(Math.round(n));
}
/** Three decimals, no negative zero (scales). */
export function f2(n        )         {
  const v = Math.round(n * 1000) / 1000;
  return Object.is(v, -0) ? '0' : String(v);
}

// ─── points & paths ─────────────────────────────────────────────────────────

/** `[x, y]` is a smooth anchor; `[x, y, 1]` a sharp corner (leaf tips, notches). */
                                                    

/** Smooth closed (or open) path through anchor points. */
export function smooth(points               , closed = true, tension = 1, prec = 1)         {
  const fmt = prec ? f : fi;
  const n = points.length;
  const at = (i        )     => (closed ? points[(i + n) % n]  : points[Math.max(0, Math.min(n - 1, i))] );
  let d = `M${fmt(points[0] [0])} ${fmt(points[0] [1])}`;
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
    d += `C${fmt(c1[0] )} ${fmt(c1[1] )} ${fmt(c2[0] )} ${fmt(c2[1] )} ${fmt(p2[0])} ${fmt(p2[1])}`;
  }
  return closed ? d + 'Z' : d;
}

/** Mirror a right half (top-centre → bottom-centre, x ≥ axis) into a full loop. */
export function sym(right               , axis = 50)       {
  const left = right
    .slice(1, -1)
    .reverse()
    .map(([x, y, c])     => (c ? [2 * axis - x, y, 1] : [2 * axis - x, y]));
  return right.concat(left);
}

                                 
                                      
               
              
              
             
              
              
              
              
 

/** Rotate / scale / translate point lists about (cx, cy). */
export function xf(
  points               ,
  { rot = 0, cx = 50, cy = 50, s = 1, sx = s, sy = s, dx = 0, dy = 0 }                 = {},
)       {
  const a = (rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  return points.map(([x, y, c])     => {
    const X = (x - cx) * sx;
    const Y = (y - cy) * sy;
    const out     = [cx + X * cos - Y * sin + dx, cy + X * sin + Y * cos + dy];
    return c ? [out[0], out[1], 1] : out;
  });
}

export const circ = (cx        , cy        , r        )         =>
  `M${f(cx - r)} ${f(cy)}a${f(r)} ${f(r)} 0 1 0 ${f(2 * r)} 0a${f(r)} ${f(r)} 0 1 0 ${f(-2 * r)} 0Z`;
export const ell = (cx        , cy        , rx        , ry        )         =>
  `M${f(cx - rx)} ${f(cy)}a${f(rx)} ${f(ry)} 0 1 0 ${f(2 * rx)} 0a${f(rx)} ${f(ry)} 0 1 0 ${f(-2 * rx)} 0Z`;

/** Parse "x,y x,y* …" into points (`*` = sharp corner). */
export function pts(str        )       {
  return str
    .trim()
    .split(/\s+/)
    .map((tok)     => {
      const corner = tok.endsWith('*');
      const [x = 0, y = 0] = tok.replace('*', '').split(',').map(Number);
      return corner ? [x, y, 1] : [x, y];
    });
}
export const sm = (str        , closed = true, tension = 1)         => smooth(pts(str), closed, tension);
export const smx = (str        , t                , closed = true)         => smooth(xf(pts(str), t), closed);
export const mirror = (p               )       => p.map(([x, y, c])     => (c ? [100 - x, y, 1] : [100 - x, y]));
const ring = (p               , n        , offset = 0, s = 1)         =>
  Array.from({ length: n }, (_, i) => xf(p, { rot: offset + (360 / n) * i, s }));
/** n rotated copies merged into one path (one element; nonzero fill keeps overlaps solid). */
export const ringD = (p               , n        , offset = 0, s = 1)         =>
  ring(p, n, offset, s)
    .map((q) => smooth(q, true, 1, 0))
    .join('');
export const dots = (list               , r        )         => list.map(([x, y]) => circ(x, y, r)).join('');

/** Wavy closed ring (merged petals / scallops) — one subpath, cheap at list sizes. */
export function scallop(
  cx        ,
  cy        ,
  rOut        ,
  rIn        ,
  n        ,
  offset = 0,
  pointed = false,
)         {
  const p       = [];
  for (let i = 0; i < n * 2; i++) {
    const a = ((offset + (180 / n) * i - 90) * Math.PI) / 180;
    const r = i % 2 ? rIn : rOut;
    const q     = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    p.push(pointed && !(i % 2) ? [q[0], q[1], 1] : q);
  }
  return smooth(p);
}

/** Sunflower seed head: a Fibonacci spiral of dots. */
export function fibSeeds(cx        , cy        , R        , n        )         {
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
export function lens(x1        , y1        , x2        , y2        , w        )         {
  const c = Math.hypot(x2 - x1, y2 - y1);
  const h = w / 2;
  const r = (c * c) / 4 / (2 * h) + h / 2;
  return `M${f(x1)} ${f(y1)}A${f(r)} ${f(r)} 0 0 1 ${f(x2)} ${f(y2)}A${f(r)} ${f(r)} 0 0 1 ${f(x1)} ${f(y1)}Z`;
}

/**
 * Geometric heart (two semicircles on a 45° square): tip at (0, 24)·s, notch at (0, −20)·s,
 * lobes ±26.6·s wide, rotated `rot`° about its centre (cx, cy).
 */
export function heart(cx        , cy        , s        , rot = 0)         {
  const a = (rot * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const P = (x        , y        ) => `${f(cx + s * (x * cos - y * sin))} ${f(cy + s * (x * sin + y * cos))}`;
  const R = f(15.56 * s);
  return `M${P(0, 24)}L${P(-22, 2)}A${R} ${R} 0 0 1 ${P(0, -20)}A${R} ${R} 0 0 1 ${P(22, 2)}Z`;
}

/** Stadium between two centre points, radius r (a pill when vertical). */
export function capsule(x1        , y1        , x2        , y2        , r        )         {
  const L = Math.hypot(x2 - x1, y2 - y1) || 1;
  const nx = (-(y2 - y1) / L) * r;
  const ny = ((x2 - x1) / L) * r;
  return (
    `M${f(x1 + nx)} ${f(y1 + ny)}L${f(x2 + nx)} ${f(y2 + ny)}A${f(r)} ${f(r)} 0 0 0 ${f(x2 - nx)} ${f(y2 - ny)}` +
    `L${f(x1 - nx)} ${f(y1 - ny)}A${f(r)} ${f(r)} 0 0 0 ${f(x1 + nx)} ${f(y1 + ny)}Z`
  );
}

/** Straight-edged polygon through "x,y x,y …" (sharp corners only). */
export const poly = (str        )         =>
  'M' +
  pts(str)
    .map(([x, y]) => `${f(x)} ${f(y)}`)
    .join('L') +
  'Z';

/** Open polyline spiral about (cx, cy): radius r0 → r1 while the angle runs a0 → a1 (degrees, screen). */
export function spiral(cx        , cy        , r0        , r1        , a0        , a1        , n = 36)         {
  let d = '';
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const a = ((a0 + (a1 - a0) * t) * Math.PI) / 180;
    const r = r0 + (r1 - r0) * t;
    d += `${i ? 'L' : 'M'}${f(cx + r * Math.cos(a))} ${f(cy + r * Math.sin(a))}`;
  }
  return d;
}

const polar = (cx        , cy        , r        , deg        )                   => [
  cx + r * Math.cos((deg * Math.PI) / 180),
  cy + r * Math.sin((deg * Math.PI) / 180),
];

/**
 * Circle with V notches cut from the rim, or — with `fan` [from°, to°] — a fan (sector) that
 * closes through its centre. Notches are [angle°, half-width°, depth], sorted by angle; for a
 * full circle every notch lies within 360° of the first.
 */
export function notched(
  cx        ,
  cy        ,
  r        ,
  notches                                                ,
  fan                                      ,
)         {
  const P = (rr        , deg        ) => polar(cx, cy, rr, deg).map(f).join(' ');
  const arc = (from        , to        ) =>
    to - from > 0.01 ? `A${f(r)} ${f(r)} 0 ${to - from > 180 ? 1 : 0} 1 ${P(r, to)}` : '';
  const vee = (deg        , hw        , depth        ) => `L${P(r - depth, deg)}L${P(r, deg + hw)}`;
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
export function lensRing(cx        , cy        , n        , rIn        , rOut        , w        , offset = 0)         {
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
export function spokes(cx        , cy        , n        , rIn        , rOut        , offset = 0)         {
  let d = '';
  for (let i = 0; i < n; i++) {
    const deg = offset + (360 / n) * i - 90;
    d += `M${polar(cx, cy, rIn, deg).map(f).join(' ')}L${polar(cx, cy, rOut, deg).map(f).join(' ')}`;
  }
  return d;
}

/** n dots of radius rd on a circle of radius R, starting at `offset`° (0 = up). */
export function dotRing(cx        , cy        , n        , R        , rd        , offset = 0)         {
  let d = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = polar(cx, cy, R, offset + (360 / n) * i - 90);
    d += circ(x, y, rd);
  }
  return d;
}

// ─── colour (state treatments + contrast tests) ─────────────────────────────

                                    

const hexToRgb = (h        )      => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))       ;
const rgbToHex = (c                   )         =>
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
export function mix(a        , b        , t        )         {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex(A.map((v, i) => v + (B[i]  - v) * t));
}

/** WCAG relative luminance. */
export function luminance(hex        )         {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  })       ;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio. */
export function contrast(a        , b        )         {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)                    ;
  return (hi + 0.05) / (lo + 0.05);
}

/** Pull a colour toward its own grey (keeps the hue family, lowers chroma). */
export function desaturate(hex        , t        )         {
  const [r, g, b] = hexToRgb(hex);
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  return rgbToHex([r + (y - r) * t, g + (y - g) * t, b + (y - b) * t]);
}

// ─── OKLCH (the disc-and-body recolour of a `tint`) ──────────────────────────

const toLinear = (v        ) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const fromLinear = (v        ) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);

/** `#RRGGBB` → OKLCH [L 0–1, C, H degrees 0–360]. */
export function toOklch(hex        )                                    {
  const [r, g, b] = hexToRgb(hex).map(toLinear)       ;
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(A, B), ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360];
}

/** OKLCH → linear sRGB, unclamped (out of gamut when a channel leaves 0–1). */
function oklchToLinear(L        , C        , H        )      {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

/**
 * The colour at OKLCH hue `h` with its own chroma and its own WCAG luminance (or `lum0`;
 * lightness re-solved at the new hue, so every contrast it took part in holds) — chroma eased
 * down until it fits sRGB (a vivid green turned blue keeps its lightness, not its punch).
 */
export function withHue(hex        , h        , lum0         = luminance(hex))         {
  const target = lum0;
  const C = toOklch(hex)[1];
  const at = (L        , c        ) => oklchToLinear(L, c, h);
  const lum = (rgb     ) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const toHex = (rgb     ) => rgbToHex(rgb.map((v) => fromLinear(Math.min(1, Math.max(0, v)))));
  let c = C;
  for (let i = 0; i < 30; i++) {
    let lo = 0;
    let hi = 1;
    for (let j = 0; j < 28; j++) {
      const mid = (lo + hi) / 2;
      if (lum(at(mid, c)) < target) lo = mid;
      else hi = mid;
    }
    const rgb = at((lo + hi) / 2, c);
    if (rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) return toHex(rgb);
    c *= 0.9;
  }
  return toHex(at(toOklch(hex)[0], 0));
}

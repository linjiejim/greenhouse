/**
 * Baked palettes are only allowed because their contrast is a test (spec §7, D14):
 *   - eyes (ink) vs EVERYTHING they are drawn over ≥ 4.5:1, in both themes, for every state
 *     (error desaturates, sleep desaturates and dims) and resting mood, at every LOD. What
 *     an eye sits on is not declared by hand: `underEyes` samples the builder's own static
 *     output and composites, point by point, every layer painted before the eyes (two-tone
 *     halves like basil's and sprout's crease, detail layers at their opacity);
 *   - the boundary ≥ 3:1 against the real app surfaces and the avatar's own disc —
 *     light: the keyline (rim) vs #FFFFFF / #F1F7ED; dark: the lifted body vs #1A231B / #0F1510.
 * The surface hexes are the app's canvas / chrome tokens (apps/web/src/app.css), copied here
 * as fixtures only — the builder never emits them.
 */

import { describe, expect, it } from 'vitest';
import { PLANT_IDS, PLANT_MOODS, PLANT_STATES, type PlantId, type PlantMood, type PlantState } from '@greenhouse/types';
import { PLANT_PRESETS, PLANT_TONES, type PlantTone } from './plant-catalogue';
import { contrast, luminance, mix } from './plant-geometry';
import { buildPlantAvatarSvg, plantPalette } from './plant-avatar-svg';

const SURFACES = { light: ['#FFFFFF', '#F1F7ED'], dark: ['#1A231B', '#0F1510'] } as const;
const THEMES = ['light', 'dark'] as const;

// ─── what the eyes are drawn over ───────────────────────────────────────────
// A tiny sampler for the builder's static theme-'auto' output (every paint names its tone):
// nested transforms, M/L/H/V/C/Q/A/Z paths, ellipses and circles, nonzero fill, round strokes,
// element opacity. Eyes = the shapes painted in `ink`; everything painted before the first of
// them is what they sit on.

type Mat = readonly [number, number, number, number, number, number];
type Poly = [number, number][];
interface Shape {
  fill: PlantTone | null;
  stroke: PlantTone | null;
  /** Stroke half-width in root (viewBox) units. */
  half: number;
  op: number;
  polys: Poly[];
  box: readonly [number, number, number, number];
}
/** One sampled point under an eye: the covering layers, bottom (opaque) first. */
type Stack = readonly { tone: PlantTone; op: number }[];

const mul = (m: Mat, n: Mat): Mat => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];

function parseTransform(t: string): Mat {
  let m: Mat = [1, 0, 0, 1, 0, 0];
  for (const [, fn, args] of t.matchAll(/(\w+)\(([^)]*)\)/g)) {
    const a = args!
      .trim()
      .split(/[\s,]+/)
      .map(Number);
    if (fn === 'translate') m = mul(m, [1, 0, 0, 1, a[0]!, a[1] ?? 0]);
    else if (fn === 'scale') m = mul(m, [a[0]!, 0, 0, a[1] ?? a[0]!, 0, 0]);
    else if (fn === 'rotate') {
      const r = (a[0]! * Math.PI) / 180;
      const [cx = 0, cy = 0] = a.slice(1);
      m = mul(mul(mul(m, [1, 0, 0, 1, cx, cy]), [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0]), [
        1,
        0,
        0,
        1,
        -cx,
        -cy,
      ]);
    } else throw new Error(`unsupported transform ${fn}`);
  }
  return m;
}

/** SVG endpoint arc → points (x-axis-rotation is always 0 in plant avatars). */
function arcPoints(
  x1: number,
  y1: number,
  rx: number,
  ry: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number,
) {
  const hx = (x1 - x2) / 2;
  const hy = (y1 - y2) / 2;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  const lambda = (hx * hx) / (rx * rx) + (hy * hy) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * hy * hy - ry * ry * hx * hx;
  const coef = (large !== sweep ? 1 : -1) * Math.sqrt(Math.max(0, num / (rx * rx * hy * hy + ry * ry * hx * hx)));
  const cxp = (coef * rx * hy) / ry;
  const cyp = (-coef * ry * hx) / rx;
  const cx = cxp + (x1 + x2) / 2;
  const cy = cyp + (y1 + y2) / 2;
  const a1 = Math.atan2((hy - cyp) / ry, (hx - cxp) / rx);
  let da = Math.atan2((-hy - cyp) / ry, (-hx - cxp) / rx) - a1;
  if (sweep && da < 0) da += 2 * Math.PI;
  if (!sweep && da > 0) da -= 2 * Math.PI;
  const n = Math.max(8, Math.ceil(Math.abs(da) / 0.1));
  return Array.from({ length: n }, (_, k): [number, number] => {
    const a = a1 + (da * (k + 1)) / n;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

function flatten(d: string): Poly[] {
  const tok = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  const out: Poly[] = [];
  let cur: Poly = [];
  let [i, x, y, sx, sy, cmd] = [0, 0, 0, 0, 0, ''];
  const n = () => Number(tok[i++]);
  const bez = (p: number[]) => {
    for (let k = 1; k <= 12; k++) {
      const t = k / 12;
      const u = 1 - t;
      const [bx, by] =
        p.length === 4
          ? [u * u * x + 2 * u * t * p[0]! + t * t * p[2]!, u * u * y + 2 * u * t * p[1]! + t * t * p[3]!]
          : [
              u * u * u * x + 3 * u * u * t * p[0]! + 3 * u * t * t * p[2]! + t * t * t * p[4]!,
              u * u * u * y + 3 * u * u * t * p[1]! + 3 * u * t * t * p[3]! + t * t * t * p[5]!,
            ];
      cur.push([bx, by]);
    }
  };
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i]!)) cmd = tok[i++]!;
    const rel = cmd !== cmd.toUpperCase();
    const [ox, oy] = rel ? [x, y] : [0, 0];
    switch (cmd.toUpperCase()) {
      case 'M':
        if (cur.length > 1) out.push(cur);
        x = ox + n();
        y = oy + n();
        cur = [[x, y]];
        [sx, sy] = [x, y];
        cmd = rel ? 'l' : 'L'; // implicit lineto after the first pair
        break;
      case 'L':
        x = ox + n();
        y = oy + n();
        cur.push([x, y]);
        break;
      case 'H':
        x = ox + n();
        cur.push([x, y]);
        break;
      case 'V':
        y = oy + n();
        cur.push([x, y]);
        break;
      case 'C':
      case 'Q': {
        const p = Array.from({ length: cmd.toUpperCase() === 'C' ? 6 : 4 }, (_, k) => (k % 2 ? oy : ox) + n());
        bez(p);
        [x, y] = p.slice(-2) as [number, number];
        break;
      }
      case 'A': {
        const [rx, ry, rot, large, sweep] = [n(), n(), n(), n(), n()];
        if (rot) throw new Error('rotated arcs are not sampled');
        const [x2, y2] = [ox + n(), oy + n()];
        cur.push(...arcPoints(x, y, rx, ry, large, sweep, x2, y2));
        [x, y] = [x2, y2];
        break;
      }
      case 'Z':
        cur.push([sx, sy]);
        out.push(cur);
        cur = [];
        [x, y] = [sx, sy];
        break;
      default:
        throw new Error(`unsupported path command ${cmd}`);
    }
  }
  if (cur.length > 1) out.push(cur);
  return out;
}

const ellipse = (cx: number, cy: number, rx: number, ry: number): Poly[] => [
  Array.from({ length: 65 }, (_, k): [number, number] => [
    cx + rx * Math.cos((k * Math.PI) / 32),
    cy + ry * Math.sin((k * Math.PI) / 32),
  ]),
];

function shapesOf(svg: string): Shape[] {
  const shapes: Shape[] = [];
  const stack: Mat[] = [[1, 0, 0, 1, 0, 0]];
  for (const [, close, tag, attrs = ''] of svg.matchAll(/<(\/?)(\w+)([^>]*?)\/?>/g)) {
    const at = (k: string) => new RegExp(`\\s${k}="([^"]*)"`).exec(attrs)?.[1];
    const m = stack[stack.length - 1]!;
    if (tag === 'g') {
      if (close) stack.pop();
      else stack.push(mul(m, parseTransform(at('transform') ?? '')));
      continue;
    }
    if (close || tag === 'svg') continue;
    const num = (k: string) => Number(at(k) ?? 0);
    const local =
      tag === 'path'
        ? flatten(at('d')!)
        : tag === 'circle'
          ? ellipse(num('cx'), num('cy'), num('r'), num('r'))
          : ellipse(num('cx'), num('cy'), num('rx'), num('ry'));
    const style = at('style') ?? '';
    const tone = (prop: string) => (new RegExp(`${prop}:var\\(--pa-(\\w+),`).exec(style)?.[1] as PlantTone) ?? null;
    const polys = local.map((p) =>
      p.map(([px, py]): [number, number] => [m[0] * px + m[2] * py + m[4], m[1] * px + m[3] * py + m[5]]),
    );
    const half = (num('stroke-width') * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))) / 2;
    const xs = polys.flat().map((p) => p[0]);
    const ys = polys.flat().map((p) => p[1]);
    const fill = at('fill') === 'none' ? null : tone('fill');
    const stroke = tone('stroke');
    if (fill && stroke && fill !== stroke) throw new Error('a shape paints two tones');
    shapes.push({
      fill,
      stroke,
      half,
      op: at('opacity') != null ? Number(at('opacity')) : 1,
      polys,
      box: [Math.min(...xs) - half, Math.min(...ys) - half, Math.max(...xs) + half, Math.max(...ys) + half],
    });
  }
  return shapes;
}

function covers(s: Shape, x: number, y: number): boolean {
  if (x < s.box[0] || x > s.box[2] || y < s.box[1] || y > s.box[3]) return false;
  if (s.fill) {
    let winding = 0;
    for (const p of s.polys)
      for (let k = 0; k < p.length; k++) {
        const [ax, ay] = p[k]!;
        const [bx, by] = p[(k + 1) % p.length]!;
        const side = (bx - ax) * (y - ay) - (x - ax) * (by - ay);
        if (ay <= y && by > y && side > 0) winding++;
        else if (ay > y && by <= y && side < 0) winding--;
      }
    if (winding) return true;
  }
  if (s.stroke)
    for (const p of s.polys)
      for (let k = 0; k + 1 < p.length; k++) {
        const [ax, ay] = p[k]!;
        const [bx, by] = p[k + 1]!;
        const len2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / len2)) : 0;
        if (Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) <= s.half) return true;
      }
  return false;
}

/**
 * Every distinct layer stack an eye of this rendering is drawn over (sampled every 0.5 units).
 * Points where an eye overhangs the silhouette (keyline or disc on top) are left out: that is
 * eye placement, not palette — some poses graze the outline by design (sprout's sad eyes sit on
 * the leaves' lower edge, monstera's closed eyes on its notches) and no plant tone can fix it.
 */
function underEyes(o: { plant: PlantId; state: PlantState; size: number; mood?: PlantMood }): Stack[] {
  const shapes = shapesOf(buildPlantAvatarSvg({ ...o, theme: 'auto', animate: false }));
  const first = shapes.findIndex((s) => s.fill === 'ink' || s.stroke === 'ink');
  const below = shapes.slice(0, first).reverse();
  const stacks = new Map<string, Stack>();
  for (const eye of shapes.filter((s) => s.fill === 'ink' || s.stroke === 'ink')) {
    for (let x = Math.ceil(eye.box[0] * 2) / 2; x <= eye.box[2]; x += 0.5) {
      for (let y = Math.ceil(eye.box[1] * 2) / 2; y <= eye.box[3]; y += 0.5) {
        if (!covers(eye, x, y)) continue;
        const layers: { tone: PlantTone; op: number }[] = [];
        for (const s of below) {
          if (!covers(s, x, y)) continue;
          layers.unshift({ tone: (s.fill ?? s.stroke)!, op: s.op });
          if (s.op === 1) break; // fully covers everything below it
        }
        const top = layers[layers.length - 1]!.tone;
        if (top !== 'rim' && top !== 'disc') stacks.set(layers.map((l) => `${l.tone}@${l.op}`).join('>'), layers);
      }
    }
  }
  return [...stacks.values()];
}

const composite = (stack: Stack, pal: Record<PlantTone, string>) =>
  stack.reduce((c, l, k) => (k ? mix(c, pal[l.tone], l.op) : pal[l.tone]), '');

/** Every state, plus the resting moods (idle only), at a glyph, avatar and portrait size. */
function* renderings(plant: PlantId) {
  for (const size of [16, 24, 120])
    for (const state of PLANT_STATES)
      for (const mood of state === 'idle' ? PLANT_MOODS : [undefined]) yield { plant, state, size, mood };
}

describe('plant palettes', () => {
  it('bakes every tone of both themes as a #RRGGBB literal', () => {
    for (const plant of PLANT_IDS)
      for (const theme of THEMES)
        for (const tone of PLANT_TONES)
          expect(PLANT_PRESETS[plant].palette[theme][tone], `${plant}.${theme}.${tone}`).toMatch(/^#[0-9A-F]{6}$/);
  });

  it('samples what the eyes really sit on (two-tone halves and pale faces included)', () => {
    const tones = (plant: PlantId, size: number) =>
      new Set(underEyes({ plant, state: 'idle', size }).map((s) => s[0]!.tone)); // the opaque base
    expect(tones('basil', 48)).toEqual(new Set(['body', 'shade'])); // right eye on the crease's shade half
    expect(tones('basil', 16)).toEqual(new Set(['body'])); // no crease at glyph size
    expect(tones('sprout', 48)).toEqual(new Set(['body', 'shade']));
    expect(tones('fern', 48)).toEqual(new Set(['light']));
    expect(tones('sunflower', 120)).toContain('accent');
  });

  it('eyes reach 4.5:1 on everything drawn under them, in both themes, for every state, mood and LOD', () => {
    const failures: string[] = [];
    for (const plant of PLANT_IDS) {
      for (const o of renderings(plant)) {
        const pals = plantPalette(plant, o.state);
        for (const stack of underEyes(o)) {
          for (const theme of THEMES) {
            const pal = pals[theme] as Record<PlantTone, string>;
            const under = composite(stack, pal);
            const ratio = contrast(pal.ink, under);
            if (ratio < 4.5)
              failures.push(
                `${plant} ${o.state}${o.mood ? `/${o.mood}` : ''} ${o.size}px ${theme}: ink ${pal.ink} on ` +
                  `${stack.map((l) => (l.op < 1 ? `${l.tone}×${l.op}` : l.tone)).join(' > ')} ${under} = ${ratio.toFixed(2)}`,
              );
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('the light keyline reaches 3:1 against light surfaces and its own disc', () => {
    for (const plant of PLANT_IDS) {
      const p = PLANT_PRESETS[plant].palette.light;
      for (const surface of [...SURFACES.light, p.disc])
        expect(contrast(p.rim, surface), `${plant} vs ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('the dark body reaches 3:1 against dark surfaces and its own disc', () => {
    for (const plant of PLANT_IDS) {
      const p = PLANT_PRESETS[plant].palette.dark;
      for (const surface of [...SURFACES.dark, p.disc])
        expect(contrast(p.body, surface), `${plant} vs ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('separates the five Bot templates by lightness (greyscale / deuteranopia stack)', () => {
    const order = (['ivy', 'clover', 'basil', 'fern', 'sage'] as const).map((p) =>
      luminance(PLANT_PRESETS[p].palette.light.body),
    );
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order[4]! - order[0]!).toBeGreaterThan(0.15);
  });

  it('state treatments change chroma and value only on painted tones, never disc / ink / catch', () => {
    for (const plant of PLANT_IDS) {
      const idle = plantPalette(plant, 'idle');
      for (const state of ['error', 'sleep'] as const) {
        const treated = plantPalette(plant, state);
        for (const theme of THEMES) {
          for (const tone of ['disc', 'ink', 'catch'] as const) expect(treated[theme][tone]).toBe(idle[theme][tone]);
          expect(treated[theme].body).not.toBe(idle[theme].body);
        }
      }
    }
  });
});

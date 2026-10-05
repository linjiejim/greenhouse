/**
 * Plant-avatar SVG builder — options → markup string (no DOM, no React).
 *
 * Skeleton (spec §2): tinted disc → [done bloom] → fit group (optical fit) → pose group
 * (state pose about the species pivot) → [motion hooks] → rim underlay pass → fill pass
 * → look group → eyes. Guarantees:
 *   - no `id=`, `<defs>` or `url(#)` — safe to repeat 50× on a page and to rasterise;
 *   - deterministic: the same options always produce the same string;
 *   - static poses are SVG transform ATTRIBUTES, so `animate:false` + an explicit theme
 *     renders without any CSS (react-native-svg SvgXml, sharp/librsvg PNG export, emails);
 *   - animated output always emits the same skeleton (identity transforms included) so
 *     `morphPlantAvatar` can patch it in place and CSS transitions interpolate.
 * Motion is CSS-only (PLANT_AVATAR_CSS, transform/opacity), injected once per document.
 */

import {
  DEFAULT_PLANT,
  PLANT_MOODS,
  STATE_ALIASES,
  hashSeed,
  isPlantId,
  type PlantId,
  type PlantMood,
  type PlantState,
  type PlantStateInput,
} from '@greenhouse/types';
import {
  PLANT_LOD_CODES,
  PLANT_PRESETS,
  PLANT_TONES,
  type PlantLod,
  type PlantPalette,
  type PlantPresetDef,
} from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import { desaturate, f, f2, mix } from './plant-geometry';

export { hashSeed };

const hasOwn = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Radius the rimmed silhouette lands on, per LOD. */
export const FIT_TARGET = Object.freeze({ glyph: 48, avatar: 47.5, portrait: 47 } as const satisfies Record<
  PlantLod,
  number
>);

// ─── states, poses, eyes ────────────────────────────────────────────────────

type EyeKind = 'calm' | 'soft' | 'bright' | 'drowsy' | 'look' | 'happy' | 'sad' | 'attentive' | 'closed';

export interface PlantPose {
  /** Canonical state (aliases and unknown values resolved). */
  state: PlantState;
  /** 'rest' = the resting mood. */
  eyes: Exclude<EyeKind, PlantMood> | 'rest' | 'bright';
  look: readonly [number, number];
  rot: number;
  tx: number;
  ty: number;
  sx: number;
  sy: number;
  /** Closes paired parts; single blades narrow instead. Negative opens. */
  fold: number;
  /** Per-part override of `fold`. */
  parts?: { l?: number; r?: number };
  /** Chroma pulled toward grey (the hue never changes). */
  desat: number;
  /** Value pulled toward the disc. */
  dim?: number;
  /** Counter-rotation of the eyes (error keeps sad lids level). */
  eyeRot?: number;
  fx?: 'bloom';
}

/** State poses. rot/tx/ty/sx/sy act about the species pivot. */
const POSES: Record<PlantState, Omit<PlantPose, 'state'>> = {
  idle: { eyes: 'rest', look: [0, 0], rot: 0, tx: 0, ty: 0, sx: 1, sy: 1, fold: 0, desat: 0 },
  thinking: { eyes: 'look', look: [3, -3.4], rot: -3, tx: 1, ty: 0, sx: 1, sy: 1, fold: 0.15, desat: 0 },
  speaking: { eyes: 'bright', look: [0, -1], rot: 0, tx: 0, ty: -1.6, sx: 1, sy: 1.035, fold: -0.15, desat: 0 },
  done: {
    eyes: 'happy',
    look: [0, -0.6],
    rot: 0,
    tx: 0,
    ty: -1.6,
    sx: 1.01,
    sy: 1.04,
    fold: -0.3,
    desat: 0,
    fx: 'bloom',
  },
  error: {
    eyes: 'sad',
    look: [0, 2.2],
    rot: 9,
    tx: -3.5,
    ty: 2.5,
    sx: 0.97,
    sy: 0.95,
    fold: 0.35,
    desat: 0.22,
    eyeRot: -9,
  },
  // leaning in toward you (phototropism); paired species reach with one leaf; expectant eyes
  waiting: {
    eyes: 'attentive',
    look: [-0.6, -1.8],
    rot: -6,
    tx: 2.5,
    ty: -1,
    sx: 1.025,
    sy: 1.04,
    fold: 0,
    parts: { l: -0.1, r: 0.55 },
    desat: 0,
  },
  sleep: {
    eyes: 'closed',
    look: [0, 1.6],
    rot: 3,
    tx: -1,
    ty: 1.5,
    sx: 0.98,
    sy: 0.96,
    fold: 1,
    desat: 0.3,
    dim: 0.14,
  },
};

/** State (or product alias) → pose. Unknown states idle. */
export function poseFor(state: PlantStateInput | string | null | undefined): PlantPose {
  const s = hasOwn(STATE_ALIASES, state) ? STATE_ALIASES[state as keyof typeof STATE_ALIASES] : state;
  return hasOwn(POSES, s) ? { state: s as PlantState, ...POSES[s as PlantState] } : { state: 'idle', ...POSES.idle };
}

/** Render size (px) → level of detail. */
export function lodFor(px: number): PlantLod {
  if (px <= 20) return 'glyph';
  if (px <= 44) return 'avatar';
  return 'portrait';
}

/**
 * Keyline width in final viewBox units for a render size: a 1px hairline (0.75px at glyph
 * sizes), drawn as an underlay so it only grows outward.
 */
export function rimUnits(px: number, w = px <= 20 ? 0.75 : 1): number {
  return Math.min(6.5, (w * 100) / px);
}

/**
 * Eye metrics per LOD (viewBox units, before FIT). Smaller render → bigger eyes. `inner` =
 * minimum half gap between the eyes' inner edges, so they never merge into a dash.
 */
export const EYE = Object.freeze({
  glyph: { rx: 6.8, ry: 8.2, inner: 5.6, arc: 6 },
  avatar: { rx: 5.9, ry: 7.3, inner: 4.6, arc: 4.8 },
  portrait: { rx: 5.2, ry: 6.6, inner: 4.2, arc: 3.8 },
} as const satisfies Record<PlantLod, { rx: number; ry: number; inner: number; arc: number }>);
type EyeMetrics = (typeof EYE)[PlantLod];

function eyeKind(poseEyes: PlantPose['eyes'], mood: unknown, lod: PlantLod): EyeKind {
  const k: EyeKind =
    poseEyes === 'rest'
      ? (PLANT_MOODS as readonly unknown[]).includes(mood)
        ? (mood as PlantMood)
        : 'calm'
      : poseEyes;
  if (lod === 'glyph') return k === 'happy' || k === 'closed' ? k : 'calm'; // ≤ 20px: neutral / happy / closed only
  return k;
}

/** Centre-to-centre half gap for a preset at a LOD. */
export function eyeHalfGap(plant: PlantId | string, lod: PlantLod): number {
  const P = PLANT_PRESETS[isPlantId(plant) ? plant : DEFAULT_PLANT];
  const m = EYE[lod];
  return Math.max(P.face.gap, m.rx * (P.face.scale || 1) + m.inner);
}

interface Paint {
  fill: (tone: keyof PlantPalette) => string;
  stroke: (tone: keyof PlantPalette) => string;
  /** Fill + stroke in one tone. 'auto' must merge them into ONE style attribute: two `style`
   *  attributes are invalid XML, and the HTML parser silently drops the second (the keyline). */
  both: (tone: keyof PlantPalette) => string;
}

function eyeSvg(
  kind: EyeKind,
  cx: number,
  cy: number,
  m: EyeMetrics,
  side: number,
  s: number,
  paint: Paint,
  showCatch: boolean,
): string {
  const rx = m.rx * s;
  const ry = m.ry * s;
  const arcW = m.arc * s;
  const fill = paint.fill('ink');
  const strokeArc = (d: string) =>
    `<path d="${d}" fill="none" ${paint.stroke('ink')} stroke-width="${f(arcW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const catchDot = (x: number, y: number, r: number) =>
    showCatch ? `<circle cx="${f(x)}" cy="${f(y)}" r="${f(r)}" ${paint.fill('catch')}/>` : '';
  switch (kind) {
    case 'happy':
      return strokeArc(
        `M${f(cx - rx)} ${f(cy + ry * 0.35)}Q${f(cx)} ${f(cy - ry * 1.05)} ${f(cx + rx)} ${f(cy + ry * 0.35)}`,
      );
    case 'closed':
      return strokeArc(`M${f(cx - rx)} ${f(cy)}Q${f(cx)} ${f(cy + ry * 0.62)} ${f(cx + rx)} ${f(cy)}`);
    case 'sad': {
      // Upper lid slants from inner-high down to the outer corner ("/ \" = sad, never "\ /").
      const outer = side < 0 ? 168 : 12;
      const inner = side < 0 ? -40 : 220;
      const p = (deg: number) =>
        [cx + rx * Math.cos((deg * Math.PI) / 180), cy + ry * Math.sin((deg * Math.PI) / 180)] as const;
      const [ox, oy] = p(outer);
      const [ix, iy] = p(inner);
      const sweep = side < 0 ? 1 : 0;
      return (
        `<path d="M${f(ox)} ${f(oy)}L${f(ix)} ${f(iy)}A${f(rx)} ${f(ry)} 0 1 ${sweep} ${f(ox)} ${f(oy)}Z" ${fill}/>` +
        catchDot(cx - side * rx * 0.28, cy + ry * 0.3, 1.4 * s) // low, inner: a watery glint
      );
    }
    case 'drowsy':
      // Relaxed, heavy-lidded: a lower, rounder eye (no hard lid line — that reads "unimpressed").
      return (
        `<ellipse cx="${f(cx)}" cy="${f(cy + ry * 0.22)}" rx="${f(rx * 0.98)}" ry="${f(ry * 0.68)}" ${fill}/>` +
        catchDot(cx + rx * 0.32, cy + ry * 0.02, 1.4 * s)
      );
    case 'soft': {
      // Content: a wider, shorter eye — cheeks lift the lower lid into a shallow upward bow.
      const w = rx * 1.04;
      const yb = cy + ry * 0.4;
      return (
        `<path d="M${f(cx - w)} ${f(yb)}A${f(w)} ${f(ry * 1.2)} 0 0 1 ${f(cx + w)} ${f(yb)}Q${f(cx)} ${f(cy + ry * 0.02)} ${f(cx - w)} ${f(yb)}Z" ${fill}/>` +
        catchDot(cx + rx * 0.32, cy - ry * 0.32, 1.5 * s)
      );
    }
    case 'attentive':
      // Expectant: bigger and rounder, two catch-lights at portrait size.
      return (
        `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx * 1.15)}" ry="${f(ry * 1.1)}" ${fill}/>` +
        catchDot(cx + rx * 0.4, cy - ry * 0.42, 2.1 * s) +
        catchDot(cx - rx * 0.38, cy + ry * 0.45, 1 * s)
      );
    case 'bright':
      // Speaking: taller, brighter eyes (a static cue that differs from idle at 24px).
      return (
        `<ellipse cx="${f(cx)}" cy="${f(cy - ry * 0.06)}" rx="${f(rx * 1.04)}" ry="${f(ry * 1.14)}" ${fill}/>` +
        catchDot(cx + rx * 0.34, cy - ry * 0.46, 2 * s)
      );
    case 'look':
      return (
        `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry * 0.9)}" ${fill}/>` +
        catchDot(cx + rx * 0.36, cy - ry * 0.36, 1.6 * s)
      );
    case 'calm':
    default:
      return (
        `<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(rx)}" ry="${f(ry)}" ${fill}/>` +
        catchDot(cx + rx * 0.34, cy - ry * 0.38, 1.7 * s)
      );
  }
}

const BLINKS = new Set<EyeKind>(['calm', 'soft', 'bright', 'look', 'attentive', 'drowsy']);

// ─── palettes ───────────────────────────────────────────────────────────────

export interface PlantThemePalettes {
  light: PlantPalette;
  dark: PlantPalette;
}

/** State-treated palettes for both themes (desat / dim are the only shifts; disc, ink, catch never change). */
function statePalettes(P: PlantPresetDef, pose: PlantPose): PlantThemePalettes {
  const tone = (pal: PlantPalette): PlantPalette => {
    const out = {} as Record<keyof PlantPalette, string>;
    for (const t of PLANT_TONES) {
      let c = pal[t];
      if (t !== 'disc' && t !== 'ink' && t !== 'catch') {
        if (pose.desat) c = desaturate(c, pose.desat);
        if (pose.dim) c = mix(c, pal.disc, pose.dim);
      }
      out[t] = c;
    }
    return out;
  };
  return { light: tone(P.palette.light), dark: tone(P.palette.dark) };
}

/** What the builder paints for a plant in a state (contrast tests and static native ports use it). */
export function plantPalette(plant: PlantId | string, state: PlantStateInput = 'idle'): PlantThemePalettes {
  return statePalettes(PLANT_PRESETS[isPlantId(plant) ? plant : DEFAULT_PLANT], poseFor(state));
}

// ─── build ──────────────────────────────────────────────────────────────────

export type PlantAvatarTheme = 'light' | 'dark' | 'auto';

export interface PlantAvatarSvgOptions {
  /** Species id; unknown → 'sprout'. */
  plant?: PlantId | string;
  /** idle|thinking|speaking|done|error|waiting|sleep or a product alias; unknown → idle. */
  state?: PlantStateInput;
  /** Render px — drives LOD, keyline weight and motion amplitude (default 32). */
  size?: number;
  /** 'auto' paints through CSS vars switched by `.dark-theme` (web); explicit for static targets. Default 'light'. */
  theme?: PlantAvatarTheme;
  /** false → attributes only: no classes, no style, no CSS needed. Default true. */
  animate?: boolean;
  /** Tinted backing disc (default true). */
  disc?: boolean;
  /** Keyline underlay (default true; only measurement turns it off). */
  rim?: boolean;
  /** Resting eyes (idle only). */
  mood?: PlantMood;
  /** Stable id (`bot_…`, `custom:…`) → per-instance loop phase (see PLANT_PHASE_SPAN). */
  seed?: string;
  /** Full localised accessible name supplied by the caller; omitted → aria-hidden. */
  label?: string;
  /** Force a LOD (stacks: 'glyph' at ≤ 24px). */
  lod?: PlantLod;
  /** Cap for ambient loops (WCAG 2.2.2), default 3. */
  idleCycles?: number;
  /** Play the one-shot unfurl entrance (new Bot). */
  intro?: boolean;
  /** Knockout export layers (prefer buildPlantMonoLayers). */
  mono?: 'silhouette' | 'eyes';
  /** Override the seeded loop phase in seconds (frame captures / tests). */
  phase?: number;
  /** Skip the optical fit and the keyline (FIT measurement only — scripts/plant-avatar-gallery.mjs --fit). */
  raw?: boolean;
}

const LOD_AMP: Record<PlantLod, number> = { glyph: 2.2, avatar: 1.6, portrait: 1 };

/**
 * Seeded loop phases spread over 0…PLANT_PHASE_SPAN seconds (`--pa-phase`, negative = already
 * that far into the loop). Only the infinite live loops (thinking, speaking) take the whole
 * phase. Capped loops (ambient idle, the capped blink, sleep) start at most 1s in
 * (`--pa-phase` ÷ span): a negative delay is time a capped loop never plays, so the full phase
 * would cut a hero's ≈ 15s idle short and could skip its only blink cycle (first blink at 2.9s).
 */
export const PLANT_PHASE_SPAN = 11;

const esc = (v: unknown) =>
  String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const MOTION_CLASS: Record<PlantState, string> = {
  idle: 'pa-m-idle',
  thinking: 'pa-m-think',
  speaking: 'pa-m-speak',
  done: 'pa-m-rest',
  error: 'pa-m-sigh',
  waiting: 'pa-m-lean',
  sleep: 'pa-m-sleep',
};
const ONE_SHOT_CLASS: Partial<Record<PlantState, string>> = {
  idle: 'pa-o-sway',
  thinking: 'pa-o-bob',
  done: 'pa-o-perk',
  error: 'pa-o-droop',
  sleep: 'pa-o-settle',
};

export function buildPlantAvatarSvg(o: PlantAvatarSvgOptions = {}): string {
  const key: PlantId = isPlantId(o.plant) ? o.plant : DEFAULT_PLANT;
  const P = PLANT_PRESETS[key];
  const size = o.size ?? 32;
  const lod: PlantLod = hasOwn(PLANT_LOD_CODES, o.lod) ? (o.lod as PlantLod) : lodFor(size);
  const lodCode = PLANT_LOD_CODES[lod];
  const pose = poseFor(o.state || 'idle');
  const mono = o.mono === 'silhouette' || o.mono === 'eyes' ? o.mono : null;
  const animate = o.animate !== false && !mono;
  const theme: PlantAvatarTheme = o.theme === 'dark' || o.theme === 'auto' ? o.theme : 'light';
  const disc = o.disc !== false && !mono;
  const rimOn = o.rim !== false && !mono && !o.raw;

  // ── paint: explicit theme → presentation attributes; 'auto' → CSS vars with the light fallback
  const pals = statePalettes(P, pose);
  const pl = pals.light;
  const pd = pals.dark;
  const val = (t: keyof PlantPalette) => (theme === 'dark' ? pd : pl)[t];
  const paint: Paint = mono
    ? {
        fill: () => 'fill="currentColor"',
        stroke: () => 'stroke="currentColor"',
        both: () => 'fill="currentColor" stroke="currentColor"',
      }
    : theme === 'auto'
      ? {
          fill: (t) => `style="fill:var(--pa-${t},${pl[t]})"`,
          stroke: (t) => `style="stroke:var(--pa-${t},${pl[t]})"`,
          both: (t) => `style="fill:var(--pa-${t},${pl[t]});stroke:var(--pa-${t},${pl[t]})"`,
        }
      : {
          fill: (t) => `fill="${val(t)}"`,
          stroke: (t) => `stroke="${val(t)}"`,
          both: (t) => `fill="${val(t)}" stroke="${val(t)}"`,
        };

  // ── fit (static attribute) — the rimmed silhouette lands on FIT_TARGET whatever the size
  const rimU = rimOn ? rimUnits(size) : 0;
  let fitS = 1;
  let fitDx = 0;
  let fitDy = 0;
  if (!o.raw) {
    const [maxR, dx, dy] = PLANT_FIT[key][lod];
    fitS = Math.min(1.3, (FIT_TARGET[lod] - rimU) / maxR);
    fitDx = dx;
    fitDy = dy;
  }
  const fitT = `translate(50 50) scale(${f2(fitS)}) translate(${f(fitDx - 50)} ${f(fitDy - 50)})`;
  const rimLocal = rimU / fitS; // stroke widths live inside the fit group

  // ── parts (paired organs fold about their base) — always emitted when animated, for morphing
  const [px, py] = P.pivot;
  const partT = (part: 'l' | 'r') => {
    if (!P.parts) return '';
    const override = pose.parts?.[part];
    const amount = override != null ? override : pose.fold;
    const { at, fold } = P.parts[part];
    if (!amount && !animate) return '';
    return `rotate(${f(fold * amount)} ${f(at[0])} ${f(at[1])})`;
  };
  const wrapPart = (part: 'l' | 'r', inner: string) => {
    const t = partT(part);
    if (!t && !animate) return inner;
    let body = inner;
    if (animate && part === 'r' && P.parts) {
      const [ax, ay] = P.parts.r.at;
      body = `<g class="pa-reach" style="transform-origin:${f(ax)}px ${f(ay)}px">${inner}</g>`;
    }
    return `<g${animate ? ` class="pa-part" data-part="${part}"` : ''}${t ? ` transform="${t}"` : ''}>${body}</g>`;
  };

  // ── layers: rim underlay pass (silhouette only), then fills
  const visible = P.layers.filter((l) => l.lods.includes(lodCode));
  const silhouette = (l: (typeof visible)[number]) => l.op == null && l.rim !== false;
  let rimPass = '';
  let body = '';
  if (mono !== 'eyes') {
    for (const layer of visible) {
      if (mono && !silhouette(layer)) continue;
      const w = layer.stroke ? (lod === 'glyph' ? layer.stroke * 1.15 : layer.stroke) : 0;
      if (rimOn && silhouette(layer)) {
        const el = layer.stroke
          ? `<path d="${layer.d}" fill="none" ${paint.stroke('rim')} stroke-width="${f(w + 2 * rimLocal)}" stroke-linecap="round" stroke-linejoin="round"/>`
          : `<path d="${layer.d}" ${paint.both('rim')} stroke-width="${f(2 * rimLocal)}" stroke-linejoin="round"/>`;
        rimPass += layer.part ? wrapPart(layer.part, el) : el;
      }
      const op = layer.op != null ? ` opacity="${layer.op}"` : '';
      const el = layer.stroke
        ? `<path d="${layer.d}" fill="none" ${paint.stroke(layer.tone)} stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"${op}/>`
        : `<path d="${layer.d}" ${paint.fill(layer.tone)}${op}/>`;
      body += layer.part ? wrapPart(layer.part, el) : el;
    }
  }

  // ── eyes
  const m = EYE[lod];
  const fs = P.face.scale || 1;
  const gap = eyeHalfGap(key, lod);
  const kind = eyeKind(pose.eyes, o.mood, lod);
  const showCatch = lod === 'portrait' && !mono;
  const blink = animate && BLINKS.has(kind);
  let eyes = '';
  if (mono !== 'silhouette') {
    for (const side of [-1, 1]) {
      const ex = P.face.x + side * gap;
      const ey = P.face.y;
      const turn = kind === 'look' && pose.look[0] * side > 0 ? 0.92 : 1; // far eye narrows: a cheap 3D turn
      const inner = eyeSvg(kind, ex, ey, m, side, fs * turn, paint, showCatch);
      eyes += blink ? `<g class="pa-blink" style="transform-origin:${f(ex)}px ${f(ey)}px">${inner}</g>` : inner;
    }
    if (animate && pose.state === 'thinking') eyes = `<g class="pa-glance">${eyes}</g>`;
  }
  const [lx, ly] = pose.look;
  const er = pose.eyeRot || 0;
  // eyes that sit between folding parts (sprout) move together as the parts close
  const sq = P.face.squeeze && pose.fold > 0 ? 1 - P.face.squeeze * pose.fold : 1;
  const fx0 = P.face.x;
  const fy0 = P.face.y;
  const lookT =
    (lx || ly || animate ? `translate(${f(lx)} ${f(ly)})` : '') +
    (er || animate ? ` rotate(${f(er)} ${f(fx0)} ${f(fy0)})` : '') +
    (sq !== 1 || animate ? ` translate(${f(fx0)} ${f(fy0)}) scale(${f2(sq)} 1) translate(${f(-fx0)} ${f(-fy0)})` : '');
  const face = animate
    ? `<g class="pa-look" transform="${lookT.trim()}"><g class="pa-eyes">${eyes}</g></g>`
    : lookT
      ? `<g transform="${lookT.trim()}">${eyes}</g>`
      : eyes;

  // ── pose (static attribute, canonical function list so transitions interpolate)
  const bladeFold = !P.parts && pose.fold > 0 ? 1 - 0.07 * pose.fold : 1;
  const sx = pose.sx * bladeFold;
  const poseT = animate
    ? `translate(${f(pose.tx)} ${f(pose.ty)}) rotate(${f(pose.rot)} ${f(px)} ${f(py)}) translate(${f(px)} ${f(py)}) scale(${f2(sx)} ${f2(pose.sy)}) translate(${f(-px)} ${f(-py)})`
    : (pose.tx || pose.ty ? `translate(${f(pose.tx)} ${f(pose.ty)}) ` : '') +
      (pose.rot ? `rotate(${f(pose.rot)} ${f(px)} ${f(py)}) ` : '') +
      (sx !== 1 || pose.sy !== 1
        ? `translate(${f(px)} ${f(py)}) scale(${f2(sx)} ${f2(pose.sy)}) translate(${f(-px)} ${f(-py)})`
        : '');

  // ── effects: exactly one, portrait + animated only — a species-tinted bloom ring gone by ~1.6s
  let fx = '';
  if (animate && lod === 'portrait' && pose.fx === 'bloom') {
    fx = `<circle class="pa-bloom" cx="50" cy="50" r="43" fill="none" ${paint.stroke('body')} stroke-width="2.4"/>`;
  }

  // ── motion classes
  let mo = '';
  let os = '';
  if (animate) {
    mo = MOTION_CLASS[pose.state];
    os = ONE_SHOT_CLASS[pose.state] || '';
    if (o.intro) os = 'pa-o-unfurl';
  }

  const idleCycles = Math.max(0, Math.round(o.idleCycles ?? 3));
  const seed = hashSeed(o.seed || key);
  const phase = o.phase != null ? -Math.abs(o.phase) : -((seed % 997) / 997) * PLANT_PHASE_SPAN;
  // Motion vars only when something moves. Theme 'auto' carries just the dark tones that differ
  // from light: every paint is `var(--pa-<tone>,<light hex>)`, `.pa` leaves --pa-<tone> unset in
  // light (→ the fallback), and `.dark-theme .pa` points it at --pa-d-<tone> — an undefined one
  // (same in both themes) makes it invalid, which falls back to the light hex again.
  const vars = [
    ...(animate
      ? [
          `--pa-ox:${f(px)}px;--pa-oy:${f(py)}px;--pa-fx:${f(P.face.x)}px;--pa-fy:${f(P.face.y)}px;--pa-amp:${LOD_AMP[lod]}`,
          `--pa-phase:${phase.toFixed(2)}s;--pa-cycles:${idleCycles};--pa-blinks:${Math.max(1, Math.round(idleCycles / 3))}`,
        ]
      : []),
    ...(theme === 'auto' ? PLANT_TONES.filter((t) => pd[t] !== pl[t]).map((t) => `--pa-d-${t}:${pd[t]}`) : []),
  ].join(';');

  // Static + explicit theme → plain presentation attributes only (SvgXml, PNG export, emails).
  const styleAttr = vars ? ` style="${vars}"` : '';
  const a11y = o.label ? `role="img" aria-label="${esc(o.label)}"` : 'aria-hidden="true"';
  const discEl = disc ? `<circle cx="50" cy="50" r="50" ${paint.fill('disc')}/>` : '';
  const cls = mono ? `pa pa-mono pa-${key}` : `pa pa-${key} pa-s-${pose.state} pa-lod-${lod}`;
  const data = animate ? ` data-plant="${key}" data-state="${pose.state}" data-lod="${lod}" data-theme="${theme}"` : '';

  const plant = rimPass + body + face;
  const inner = animate ? `<g class="pa-mo ${mo}"><g class="pa-os ${os}">${plant}</g></g>` : plant;
  const posed = poseT ? `<g${animate ? ' class="pa-pose"' : ''} transform="${poseT.trim()}">${inner}</g>` : inner;

  return (
    `<svg class="${cls}" viewBox="0 0 100 100" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" focusable="false" ${a11y}${data}${styleAttr}>` +
    discEl +
    fx +
    `<g${animate ? ' class="pa-fit"' : ''} transform="${fitT}">${posed}</g></svg>`
  );
}

/**
 * Knockout export for system-tinted surfaces (iOS lock-screen accessory widgets): two strings
 * with identical geometry — the silhouette and the eyes, both in currentColor, no disc/rim.
 * Composite `eyes` over `silhouette` with destination-out (sharp: blend 'dest-out') so the
 * eyes become true transparent holes; no <mask>, ids or url(#) needed.
 */
export function buildPlantMonoLayers(o: Omit<PlantAvatarSvgOptions, 'mono'> = {}): {
  silhouette: string;
  eyes: string;
} {
  return {
    silhouette: buildPlantAvatarSvg({ ...o, mono: 'silhouette' }),
    eyes: buildPlantAvatarSvg({ ...o, mono: 'eyes' }),
  };
}

// ─── motion (inject once; transform/opacity only) ───────────────────────────

const AUTO_VARS_DARK = PLANT_TONES.map((t) => `--pa-${t}:var(--pa-d-${t})`).join(';');
/** Capped loops start at most 1s in (see PLANT_PHASE_SPAN). */
const LAG = `calc(var(--pa-phase) / ${PLANT_PHASE_SPAN})`;

/**
 * Keyframes, morph transitions, pause hook and reduced-motion override. Loop caps live here
 * (`--pa-cycles`, ×3 waiting / sighs / sleep, one blink cycle), so a call site cannot forget
 * them: every loop is capped unless it is thinking / speaking (live status, WCAG 2.2.2).
 * A morph (`.pa-morph`) suppresses the entrance one-shots on `.pa-os` — the pose transition
 * is the entrance — but never the thinking bob, the Y half of its circumnutation ellipse.
 * `.dark-theme` (the app's theme class) switches the 'auto' palette.
 */
export const PLANT_AVATAR_CSS = `
.pa{display:block;overflow:visible}
.dark-theme .pa,.pa-dark .pa{${AUTO_VARS_DARK}}
.pa .pa-mo,.pa .pa-os{transform-origin:var(--pa-ox) var(--pa-oy)}
.pa .pa-pose,.pa .pa-part,.pa .pa-look,.pa .pa-fit{transition:transform .6s cubic-bezier(.34,1.3,.64,1)}
.pa.pa-s-error .pa-pose,.pa.pa-s-error .pa-part{transition-duration:1s;transition-timing-function:cubic-bezier(.35,.6,.4,1)}
.pa.pa-s-sleep .pa-pose,.pa.pa-s-sleep .pa-part{transition-duration:1.2s;transition-timing-function:cubic-bezier(.45,0,.55,1)}
.pa path,.pa circle,.pa ellipse{transition:fill .6s,stroke .6s}
.pa .pa-eyes{transform-origin:var(--pa-fx) var(--pa-fy);transition:transform .1s ease-in}
.pa .pa-eyes.pa-shut{transform:scaleY(.1)}
.pa.pa-morph .pa-os:not(.pa-o-bob){animation:none}
.pa .pa-m-idle{animation:pa-breathe 5s cubic-bezier(.37,0,.63,1) ${LAG} var(--pa-cycles)}
.pa .pa-o-sway{animation:pa-sway 4.4s ease-in-out ${LAG} var(--pa-cycles) alternate}
.pa .pa-blink{animation:pa-blink 11s linear ${LAG} var(--pa-blinks)}
.pa.pa-s-thinking .pa-blink,.pa.pa-s-speaking .pa-blink{animation-delay:var(--pa-phase);animation-iteration-count:infinite}
.pa.pa-s-sleep .pa-blink,.pa.pa-s-done .pa-blink{animation:none}
.pa .pa-m-think{animation:pa-nod-x 1.5s ease-in-out var(--pa-phase) infinite alternate}
.pa .pa-o-bob{animation:pa-nod-y 1.5s ease-in-out calc(var(--pa-phase) - .75s) infinite alternate}
.pa .pa-glance{animation:pa-glance 3.6s ease-in-out var(--pa-phase) infinite}
.pa .pa-m-speak{animation:pa-talk 1.6s ease-in-out var(--pa-phase) infinite}
.pa .pa-m-rest{animation:pa-breathe 5s cubic-bezier(.37,0,.63,1) .8s 2}
.pa .pa-o-perk{animation:pa-perk .8s cubic-bezier(.3,1.5,.6,1) both}
.pa .pa-bloom{opacity:0;transform-origin:50px 50px;animation:pa-bloom 1.4s cubic-bezier(.2,.7,.3,1) .15s both}
.pa .pa-o-droop{animation:pa-droop 1s cubic-bezier(.35,.6,.4,1) both}
.pa .pa-m-sigh{animation:pa-sigh 4s ease-in-out 1.2s 3}
.pa .pa-m-lean{animation:pa-lean 2.6s ease-in-out 3}
.pa.pa-s-waiting .pa-reach{animation:pa-reach 2.6s ease-in-out 3}
.pa.pa-s-waiting.pa-morph .pa-reach{animation-delay:.6s}
.pa .pa-m-sleep{animation:pa-breathe-slow 7s ease-in-out ${LAG} var(--pa-cycles)}
.pa .pa-o-settle{animation:pa-settle 1.2s cubic-bezier(.45,0,.55,1) both}
.pa .pa-o-unfurl{animation:pa-unfurl 1.1s cubic-bezier(.3,1.35,.55,1) both}
.pa-paused .pa *,.pa.pa-paused *{animation-play-state:paused!important}
@keyframes pa-breathe{0%,100%{transform:none}40%{transform:translateY(calc(var(--pa-amp)*-.7px)) scale(1.006,calc(1 + var(--pa-amp)*.02))}}
@keyframes pa-breathe-slow{0%,100%{transform:none}45%{transform:scale(1.004,calc(1 + var(--pa-amp)*.012))}}
@keyframes pa-sway{0%{transform:rotate(calc(var(--pa-amp)*-1.3deg))}100%{transform:rotate(calc(var(--pa-amp)*1.3deg))}}
@keyframes pa-blink{0%,25%,28%,59%,62%,64.5%,67.5%,90%,93%,100%{transform:none}26.5%,60.5%,66%,91.5%{transform:scaleY(.08)}}
@keyframes pa-nod-x{0%{transform:translateX(calc(var(--pa-amp)*-1.3px)) rotate(calc(var(--pa-amp)*-1deg))}100%{transform:translateX(calc(var(--pa-amp)*1.3px)) rotate(calc(var(--pa-amp)*1deg))}}
@keyframes pa-nod-y{0%{transform:translateY(calc(var(--pa-amp)*-.9px))}100%{transform:translateY(calc(var(--pa-amp)*.6px))}}
@keyframes pa-glance{0%,36%{transform:none}42%,70%{transform:translateX(-5.5px)}76%,100%{transform:none}}
@keyframes pa-talk{0%,100%{transform:none}12%{transform:scale(1,calc(1 + var(--pa-amp)*.03)) translateY(calc(var(--pa-amp)*-.6px))}25%{transform:scale(1.01,.99)}38%{transform:scale(1,calc(1 + var(--pa-amp)*.016))}50%{transform:none}64%{transform:scale(.995,calc(1 + var(--pa-amp)*.038)) translateY(calc(var(--pa-amp)*-.8px)) rotate(calc(var(--pa-amp)*-1.2deg))}80%{transform:scale(1.01,.985)}}
@keyframes pa-perk{0%{transform:scale(1.03,.92) translateY(1.5px)}38%{transform:scale(.98,1.05) translateY(-1.2px)}68%{transform:scale(1.01,.99)}100%{transform:none}}
@keyframes pa-bloom{0%{opacity:.7;transform:scale(.8)}100%{opacity:0;transform:scale(1.07)}}
@keyframes pa-droop{0%{transform:rotate(-10deg) translateY(-2px) scale(1,1.035)}65%{transform:rotate(1.4deg)}100%{transform:none}}
@keyframes pa-sigh{0%,100%{transform:none}35%{transform:scale(1.01,calc(1 + var(--pa-amp)*.018))}60%{transform:scale(1,calc(1 - var(--pa-amp)*.01)) rotate(calc(var(--pa-amp)*.8deg))}}
@keyframes pa-lean{0%,100%{transform:none}35%{transform:rotate(calc(var(--pa-amp)*-1.6deg)) scale(1.012,calc(1 + var(--pa-amp)*.025))}60%{transform:rotate(calc(var(--pa-amp)*-.5deg)) scale(1.004,calc(1 + var(--pa-amp)*.008))}}
@keyframes pa-reach{0%,100%{transform:none}35%{transform:rotate(-9deg)}60%{transform:rotate(-3deg)}}
@keyframes pa-settle{0%{transform:rotate(-3deg) scale(1.02,1.05)}100%{transform:none}}
@keyframes pa-unfurl{0%{opacity:0;transform:scale(.25) rotate(-28deg)}55%{opacity:1}100%{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){.pa *{animation:none!important;transition-duration:0s!important}.pa .pa-eyes{transition:opacity .15s!important}.pa .pa-eyes.pa-shut{transform:none;opacity:0}}
`;

/** Inject PLANT_AVATAR_CSS once per document (SSR-safe; idempotent per document). */
export function ensurePlantAvatarStyles(
  doc: Document | null = typeof document !== 'undefined' ? document : null,
): void {
  if (!doc || doc.querySelector('style[data-plant-avatar]')) return;
  const el = doc.createElement('style');
  el.setAttribute('data-plant-avatar', '');
  el.textContent = PLANT_AVATAR_CSS;
  doc.head.appendChild(el);
}

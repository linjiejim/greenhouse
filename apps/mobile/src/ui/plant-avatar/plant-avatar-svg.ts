// VENDORED — the STATIC half of packages/ui/src/components/plant-avatar/plant-avatar-svg.ts.
// react-native-svg's SvgXml cannot run CSS, so everything that only exists for the web's CSS
// motion is cut: animate/theme 'auto'/seed/phase/idleCycles/intro/raw/rim/label options, the
// motion classes and data-* hooks, the done bloom, PLANT_AVATAR_CSS and ensurePlantAvatarStyles.
// What remains is the canonical code with `animate === false` folded in, so for the options
// kept here the output is byte-identical to the core builder — plant-avatar.parity.test.ts
// proves it over every preset × state × size × theme (+ moods, forced LODs and mono layers).
// Do not edit here: change the core, then re-apply the change below and run the parity test.

/**
 * Plant-avatar SVG builder — options → markup string (no DOM, no React).
 *
 * Skeleton (spec §2): tinted disc → fit group (optical fit) → pose group (state pose about
 * the species pivot) → rim underlay pass → fill pass → look group → eyes. Guarantees:
 *   - no `id=`, `<defs>` or `url(#)`; deterministic;
 *   - static poses are SVG transform ATTRIBUTES with plain presentation-attribute paint, so
 *     the string renders without any CSS (SvgXml, librsvg PNG export for the iOS widget).
 */

import {
  DEFAULT_PLANT,
  PLANT_MOODS,
  STATE_ALIASES,
  isPlantId,
  type PlantId,
  type PlantMood,
  type PlantState,
  type PlantStateInput,
} from './plant-ids';
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

/** What the builder paints for a plant in a state (the RN wrapper reads the disc tone from it). */
export function plantPalette(plant: PlantId | string, state: PlantStateInput = 'idle'): PlantThemePalettes {
  return statePalettes(PLANT_PRESETS[isPlantId(plant) ? plant : DEFAULT_PLANT], poseFor(state));
}

// ─── build ──────────────────────────────────────────────────────────────────

/** Static targets always name their theme (no CSS → no `.dark-theme` switch). */
export type PlantAvatarTheme = 'light' | 'dark';

export interface PlantAvatarSvgOptions {
  /** Species id; unknown → 'sprout'. */
  plant?: PlantId | string;
  /** idle|thinking|speaking|done|error|waiting|sleep or a product alias; unknown → idle. */
  state?: PlantStateInput;
  /** Render px — drives LOD and keyline weight (default 32). */
  size?: number;
  /** Default 'light'. */
  theme?: PlantAvatarTheme;
  /** Tinted backing disc (default true). */
  disc?: boolean;
  /** Resting eyes (idle only). */
  mood?: PlantMood;
  /** Force a LOD (compact ≤ 24px sites: 'glyph'). */
  lod?: PlantLod;
  /** Knockout export layers (prefer buildPlantMonoLayers). */
  mono?: 'silhouette' | 'eyes';
}

export function buildPlantAvatarSvg(o: PlantAvatarSvgOptions = {}): string {
  const key: PlantId = isPlantId(o.plant) ? o.plant : DEFAULT_PLANT;
  const P = PLANT_PRESETS[key];
  const size = o.size ?? 32;
  const lod: PlantLod = hasOwn(PLANT_LOD_CODES, o.lod) ? (o.lod as PlantLod) : lodFor(size);
  const lodCode = PLANT_LOD_CODES[lod];
  const pose = poseFor(o.state || 'idle');
  const mono = o.mono === 'silhouette' || o.mono === 'eyes' ? o.mono : null;
  const theme: PlantAvatarTheme = o.theme === 'dark' ? 'dark' : 'light';
  const disc = o.disc !== false && !mono;
  const rimOn = !mono;

  // ── paint: presentation attributes in the named theme (mono → currentColor)
  const pals = statePalettes(P, pose);
  const val = (t: keyof PlantPalette) => (theme === 'dark' ? pals.dark : pals.light)[t];
  const paint: Paint = mono
    ? {
        fill: () => 'fill="currentColor"',
        stroke: () => 'stroke="currentColor"',
        both: () => 'fill="currentColor" stroke="currentColor"',
      }
    : {
        fill: (t) => `fill="${val(t)}"`,
        stroke: (t) => `stroke="${val(t)}"`,
        both: (t) => `fill="${val(t)}" stroke="${val(t)}"`,
      };

  // ── fit (static attribute) — the rimmed silhouette lands on FIT_TARGET whatever the size
  const rimU = rimOn ? rimUnits(size) : 0;
  const [maxR, fitDx, fitDy] = PLANT_FIT[key][lod];
  const fitS = Math.min(1.3, (FIT_TARGET[lod] - rimU) / maxR);
  const fitT = `translate(50 50) scale(${f2(fitS)}) translate(${f(fitDx - 50)} ${f(fitDy - 50)})`;
  const rimLocal = rimU / fitS; // stroke widths live inside the fit group

  // ── parts (paired organs fold about their base)
  const [px, py] = P.pivot;
  const partT = (part: 'l' | 'r') => {
    if (!P.parts) return '';
    const override = pose.parts?.[part];
    const amount = override != null ? override : pose.fold;
    const { at, fold } = P.parts[part];
    if (!amount) return '';
    return `rotate(${f(fold * amount)} ${f(at[0])} ${f(at[1])})`;
  };
  const wrapPart = (part: 'l' | 'r', inner: string) => {
    const t = partT(part);
    return t ? `<g transform="${t}">${inner}</g>` : inner;
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
  let eyes = '';
  if (mono !== 'silhouette') {
    for (const side of [-1, 1]) {
      const ex = P.face.x + side * gap;
      const ey = P.face.y;
      const turn = kind === 'look' && pose.look[0] * side > 0 ? 0.92 : 1; // far eye narrows: a cheap 3D turn
      eyes += eyeSvg(kind, ex, ey, m, side, fs * turn, paint, showCatch);
    }
  }
  const [lx, ly] = pose.look;
  const er = pose.eyeRot || 0;
  // eyes that sit between folding parts (sprout) move together as the parts close
  const sq = P.face.squeeze && pose.fold > 0 ? 1 - P.face.squeeze * pose.fold : 1;
  const fx0 = P.face.x;
  const fy0 = P.face.y;
  const lookT =
    (lx || ly ? `translate(${f(lx)} ${f(ly)})` : '') +
    (er ? ` rotate(${f(er)} ${f(fx0)} ${f(fy0)})` : '') +
    (sq !== 1 ? ` translate(${f(fx0)} ${f(fy0)}) scale(${f2(sq)} 1) translate(${f(-fx0)} ${f(-fy0)})` : '');
  const face = lookT ? `<g transform="${lookT.trim()}">${eyes}</g>` : eyes;

  // ── pose (static attribute about the species pivot)
  const bladeFold = !P.parts && pose.fold > 0 ? 1 - 0.07 * pose.fold : 1;
  const sx = pose.sx * bladeFold;
  const poseT =
    (pose.tx || pose.ty ? `translate(${f(pose.tx)} ${f(pose.ty)}) ` : '') +
    (pose.rot ? `rotate(${f(pose.rot)} ${f(px)} ${f(py)}) ` : '') +
    (sx !== 1 || pose.sy !== 1
      ? `translate(${f(px)} ${f(py)}) scale(${f2(sx)} ${f2(pose.sy)}) translate(${f(-px)} ${f(-py)})`
      : '');

  const discEl = disc ? `<circle cx="50" cy="50" r="50" ${paint.fill('disc')}/>` : '';
  const cls = mono ? `pa pa-mono pa-${key}` : `pa pa-${key} pa-s-${pose.state} pa-lod-${lod}`;

  const plant = rimPass + body + face;
  const posed = poseT ? `<g transform="${poseT.trim()}">${plant}</g>` : plant;

  return (
    `<svg class="${cls}" viewBox="0 0 100 100" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
    discEl +
    `<g transform="${fitT}">${posed}</g></svg>`
  );
}

/**
 * Knockout export for system-tinted surfaces (iOS lock-screen accessory widgets): two strings
 * with identical geometry — the silhouette and the eyes, both in currentColor, no disc/rim.
 * Composite `eyes` over `silhouette` with destination-out so the eyes become true holes
 * (apps/mobile/scripts/render-widget-art.mjs).
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

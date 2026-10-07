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
 * the species pivot) → rim underlay pass → fill pass → look group → face (eyes, brows at
 * portrait, mouth above glyph) → [state mark, portrait]. Guarantees:
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

type EyeKind = 'calm' | 'soft' | 'bright' | 'drowsy' | 'look' | 'focus' | 'happy' | 'sad' | 'attentive' | 'closed';
type MouthKind = 'smile' | 'grin' | 'side' | 'talk' | 'o' | 'wobble' | 'small';
type BrowKind = 'focus' | 'worried' | 'arched';

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

/**
 * State poses. rot/tx/ty/sx/sy act about the species pivot; `fold` > 0 droops / closes paired
 * parts, < 0 raises / opens them (per-part overrides in `parts`).
 */
const POSES: Record<PlantState, Omit<PlantPose, 'state'>> = {
  idle: { eyes: 'rest', look: [0, 0], rot: 0, tx: 0, ty: 0, sx: 1, sy: 1, fold: 0, desat: 0 },
  thinking: { eyes: 'look', look: [3, -3.4], rot: -3, tx: 1, ty: 0, sx: 1, sy: 1, fold: 0.15, desat: 0 },
  speaking: { eyes: 'focus', look: [0, -0.6], rot: 0, tx: 0, ty: -1.6, sx: 1, sy: 1.035, fold: -0.15, desat: 0 },
  done: {
    eyes: 'happy',
    look: [0, -0.6],
    rot: 0,
    tx: 0,
    ty: -1.6,
    sx: 1.01,
    sy: 1.04,
    fold: -0.45,
    desat: 0,
    fx: 'bloom',
  },
  error: {
    eyes: 'sad',
    look: [0, 1.6],
    rot: 7,
    tx: -3,
    ty: 2.5,
    sx: 0.97,
    sy: 0.95,
    fold: 0.5,
    desat: 0.22,
    eyeRot: -7,
  },
  // leaning in toward you (phototropism); paired species raise one leaf like a hand; expectant eyes
  waiting: {
    eyes: 'attentive',
    look: [-0.6, -1.8],
    rot: -6,
    tx: 2.5,
    ty: -1,
    sx: 1.025,
    sy: 1.04,
    fold: 0,
    parts: { l: 0.1, r: -0.9 },
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
  // a new Bot says hi: one leaf (or arm) up and waving
  hello: {
    eyes: 'bright',
    look: [0, -1],
    rot: 0,
    tx: 0,
    ty: -1.4,
    sx: 1,
    sy: 1.03,
    fold: 0,
    parts: { l: 0.1, r: -0.8 },
    desat: 0,
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
  glyph: { rx: 3.9, ry: 4.9, inner: 4.8, arc: 3.2 },
  avatar: { rx: 3.3, ry: 4.2, inner: 3.8, arc: 2.6 },
  portrait: { rx: 2.9, ry: 3.7, inner: 3.6, arc: 2.1 },
} as const satisfies Record<PlantLod, { rx: number; ry: number; inner: number; arc: number }>);
type EyeMetrics = (typeof EYE)[PlantLod];

/**
 * Mouth metrics (viewBox units before FIT, × face scale): half width, height, stroke and the
 * drop below the eye line. No mouth at glyph sizes — two eyes are all 16–20px can carry.
 */
export const MOUTH = Object.freeze({
  avatar: { w: 4.4, h: 3, sw: 2.5, dy: 8.6 },
  portrait: { w: 3.9, h: 2.7, sw: 2.1, dy: 7.8 },
} as const satisfies Record<Exclude<PlantLod, 'glyph'>, { w: number; h: number; sw: number; dy: number }>);
type MouthMetrics = (typeof MOUTH)[keyof typeof MOUTH];

const STATE_MOUTH: Record<PlantState, MouthKind> = {
  idle: 'smile',
  thinking: 'side',
  speaking: 'talk',
  done: 'grin',
  error: 'wobble',
  waiting: 'o',
  sleep: 'small',
  hello: 'grin',
};
const MOOD_MOUTH: Record<PlantMood, MouthKind> = { calm: 'smile', soft: 'smile', bright: 'grin', drowsy: 'small' };

/** Brows: portrait only (a 1px line at list sizes reads as noise). */
const STATE_BROWS: Partial<Record<PlantState, BrowKind>> = { speaking: 'focus', error: 'worried', waiting: 'arched' };

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
}

function eyeSvg(kind: EyeKind, cx: number, cy: number, m: EyeMetrics, side: number, s: number, paint: Paint): string {
  const rx = m.rx * s;
  const ry = m.ry * s;
  const arcW = m.arc * s;
  const fill = paint.fill('ink');
  const strokeArc = (d: string) =>
    `<path d="${d}" fill="none" ${paint.stroke('ink')} stroke-width="${f(arcW)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  const oval = (x: number, y: number, ex: number, ey: number) =>
    `<ellipse cx="${f(x)}" cy="${f(y)}" rx="${f(ex)}" ry="${f(ey)}" ${fill}/>`;
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
      return `<path d="M${f(ox)} ${f(oy)}L${f(ix)} ${f(iy)}A${f(rx)} ${f(ry)} 0 1 ${sweep} ${f(ox)} ${f(oy)}Z" ${fill}/>`;
    }
    case 'drowsy':
      // Relaxed, heavy-lidded: a lower, rounder eye (no hard lid line — that reads "unimpressed").
      return oval(cx, cy + ry * 0.22, rx * 0.98, ry * 0.68);
    case 'soft': {
      // Content: a wider, shorter eye — cheeks lift the lower lid into a shallow upward bow.
      const w = rx * 1.04;
      const yb = cy + ry * 0.4;
      return `<path d="M${f(cx - w)} ${f(yb)}A${f(w)} ${f(ry * 1.2)} 0 0 1 ${f(cx + w)} ${f(yb)}Q${f(cx)} ${f(cy + ry * 0.02)} ${f(cx - w)} ${f(yb)}Z" ${fill}/>`;
    }
    case 'attentive':
      // Expectant: bigger and rounder.
      return oval(cx, cy, rx * 1.15, ry * 1.1);
    case 'bright':
      // Lit up (hello, bright mood): taller.
      return oval(cx, cy - ry * 0.06, rx * 1.04, ry * 1.14);
    case 'focus':
      // Concentrating (speaking / working): flatter.
      return oval(cx, cy + ry * 0.1, rx * 1.02, ry * 0.74);
    case 'look':
      return oval(cx, cy, rx, ry * 0.9);
    case 'calm':
    default:
      return oval(cx, cy, rx, ry);
  }
}

/** A brow over one eye (`side` −1 left, 1 right). */
function browSvg(kind: BrowKind, cx: number, cy: number, m: EyeMetrics, side: number, s: number, paint: Paint): string {
  const rx = m.rx * s;
  const ry = m.ry * s;
  const out = cx + side * rx * 1.12; // outer end
  const inn = cx - side * rx * 0.98; // inner end, toward the nose
  const stroke = `fill="none" ${paint.stroke('ink')} stroke-width="${f(m.arc * 0.62 * s)}" stroke-linecap="round"`;
  if (kind === 'arched')
    return `<path d="M${f(out)} ${f(cy - ry * 1.28)}Q${f(cx)} ${f(cy - ry * 1.9)} ${f(inn)} ${f(cy - ry * 1.28)}" ${stroke}/>`;
  const [yo, yi] = kind === 'focus' ? [1.48, 1.2] : [1.22, 1.62]; // focus: inner end low; worried: inner end high
  return `<path d="M${f(out)} ${f(cy - ry * yo)}L${f(inn)} ${f(cy - ry * yi)}" ${stroke}/>`;
}

/** The mouth, centred at (cx, cy). */
function mouthSvg(kind: MouthKind, cx: number, cy: number, mm: MouthMetrics, s: number, paint: Paint): string {
  const w = mm.w * s;
  const h = mm.h * s;
  const fill = paint.fill('ink');
  const stroke = (d: string, k = 1) =>
    `<path d="${d}" fill="none" ${paint.stroke('ink')} stroke-width="${f(mm.sw * s * k)}" stroke-linecap="round" stroke-linejoin="round"/>`;
  switch (kind) {
    case 'grin':
      return `<path d="M${f(cx - w * 1.05)} ${f(cy - h * 0.45)}Q${f(cx)} ${f(cy + h * 1.9)} ${f(cx + w * 1.05)} ${f(cy - h * 0.45)}Z" ${fill}/>`;
    case 'side':
      return stroke(`M${f(cx - w * 0.35)} ${f(cy)}Q${f(cx + w * 0.3)} ${f(cy + h * 0.75)} ${f(cx + w * 0.95)} ${f(cy - h * 0.25)}`);
    case 'talk':
      return `<ellipse cx="${f(cx)}" cy="${f(cy + h * 0.15)}" rx="${f(w * 0.52)}" ry="${f(h * 0.62)}" ${fill}/>`;
    case 'o':
      return `<ellipse cx="${f(cx)}" cy="${f(cy + h * 0.2)}" rx="${f(w * 0.42)}" ry="${f(h * 0.78)}" ${fill}/>`;
    case 'wobble': {
      // four shallow waves; explicit Q segments (no T — the contrast sampler reads M/L/Q/C/A only)
      const y = cy + h * 0.25;
      const step = (w * 2) / 4;
      let d = `M${f(cx - w)} ${f(y)}`;
      for (let i = 0; i < 4; i++) {
        const x0 = cx - w + step * i;
        d += `Q${f(x0 + step / 2)} ${f(y + (i % 2 ? h * 0.7 : -h * 0.7))} ${f(x0 + step)} ${f(y)}`;
      }
      return stroke(d, 0.82);
    }
    case 'small':
      return stroke(`M${f(cx - w * 0.45)} ${f(cy)}Q${f(cx)} ${f(cy + h * 0.6)} ${f(cx + w * 0.45)} ${f(cy)}`, 0.9);
    case 'smile':
    default:
      return stroke(`M${f(cx - w)} ${f(cy - h * 0.3)}Q${f(cx)} ${f(cy + h * 1.1)} ${f(cx + w)} ${f(cy - h * 0.3)}`);
  }
}

/** State marks for portraits, on the disc (not fitted): fixed badge colours, the rest in `mark`. */
const MARK = Object.freeze({ badge: '#F2B53A', done: '#3F9B6E', glyph: '#FFFFFF', drop: '#6FB4DE' });

function marksSvg(state: PlantState, paint: Paint): string {
  const line = (d: string, w: number, _name: string, op = 1) =>
    `<path d="${d}" fill="none" ${paint.stroke('mark')} stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${op < 1 ? ` opacity="${op}"` : ''}/>`;
  const badge = (fill: string, glyph: string) => `<g><circle cx="84" cy="16" r="11" fill="${fill}"/>${glyph}</g>`;
  const star = (x: number, y: number, r: number) => {
    const k = r * 0.22;
    return (
      `<path d="M${f(x)} ${f(y - r)}Q${f(x + k)} ${f(y - k)} ${f(x + r)} ${f(y)}Q${f(x + k)} ${f(y + k)} ${f(x)} ${f(y + r)}` +
      `Q${f(x - k)} ${f(y + k)} ${f(x - r)} ${f(y)}Q${f(x - k)} ${f(y - k)} ${f(x)} ${f(y - r)}Z" fill="${MARK.badge}"/>`
    );
  };
  switch (state) {
    case 'hello':
      return line('M80 14Q86 19 85 27', 2.6, 'arc', 0.7) + line('M86.5 7Q95 16 92.5 29', 2.6, 'arc', 0.7);
    case 'thinking':
      return [
        [73, 21, 2.8],
        [81, 14, 3.4],
        [90, 7.5, 4.1],
      ]
        .map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" ${paint.fill('mark')}/>`)
        .join('');
    case 'speaking':
      return line('M6 44H16M3 54H15', 2.6, 'dash', 0.55) + line('M84 44H94M85 54H97', 2.6, 'dash', 0.55);
    case 'waiting':
      return badge(
        MARK.badge,
        `<path d="M84 9.5V17.5" fill="none" stroke="${MARK.glyph}" stroke-width="3.2" stroke-linecap="round"/><circle cx="84" cy="22" r="1.9" fill="${MARK.glyph}"/>`,
      );
    case 'done':
      return (
        badge(
          MARK.done,
          `<path d="M78.6 16.4L82.4 20.2L89.4 12.6" fill="none" stroke="${MARK.glyph}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/>`,
        ) +
        star(15, 20, 5.2) +
        star(91, 40, 3.8) +
        star(25, 6, 3.2)
      );
    case 'error':
      return `<path d="M83 9C87.6 15.6 88.8 19 86.3 21.9C84.3 24.2 80.7 23.5 80.4 20.3C80.2 17.6 81.5 15 83 9Z" fill="${MARK.drop}"/>`;
    case 'sleep':
      return line('M68 26h6l-6 6h6', 2.4, 'z', 0.8) + line('M78 15h7.5l-7.5 7.5h7.5', 2.4, 'z', 0.8) + line('M88 3h9l-9 9h9', 2.4, 'z', 0.8);
    default:
      return '';
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
  /** idle|thinking|speaking|done|error|waiting|sleep|hello or a product alias; unknown → idle. */
  state?: PlantStateInput;
  /** Render px — drives LOD (default 32). */
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

  // ── paint: presentation attributes in the named theme (mono → currentColor)
  const pals = statePalettes(P, pose);
  const val = (t: keyof PlantPalette) => (theme === 'dark' ? pals.dark : pals.light)[t];
  const paint: Paint = mono
    ? {
        fill: () => 'fill="currentColor"',
        stroke: () => 'stroke="currentColor"',
      }
    : {
        fill: (t) => `fill="${val(t)}"`,
        stroke: (t) => `stroke="${val(t)}"`,
      };

  // ── fit (static attribute) — the silhouette lands on FIT_TARGET whatever the size (no keyline:
  // the core's opt-in `rim` is not vendored)
  const [maxR, fitDx, fitDy] = PLANT_FIT[key][lod];
  const fitS = Math.min(1.3, FIT_TARGET[lod] / maxR);
  const fitT = `translate(50 50) scale(${f2(fitS)}) translate(${f(fitDx - 50)} ${f(fitDy - 50)})`;

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

  // ── layers: fills (mono: the silhouette layers only)
  const visible = P.layers.filter((l) => l.lods.includes(lodCode));
  const silhouette = (l: (typeof visible)[number]) => l.op == null && l.rim !== false;
  let body = '';
  if (mono !== 'eyes') {
    for (const layer of visible) {
      if (mono && !silhouette(layer)) continue;
      const w = layer.stroke ? (lod === 'glyph' ? layer.stroke * 1.15 : layer.stroke) : 0;
      const op = layer.op != null ? ` opacity="${layer.op}"` : '';
      const el = layer.stroke
        ? `<path d="${layer.d}" fill="none" ${paint.stroke(layer.tone)} stroke-width="${f(w)}" stroke-linecap="round" stroke-linejoin="round"${op}/>`
        : `<path d="${layer.d}" ${paint.fill(layer.tone)}${op}/>`;
      body += layer.part ? wrapPart(layer.part, el) : el;
    }
  }

  // ── face: eyes (+ brows at portrait), then the mouth from the avatar LOD up
  const m = EYE[lod];
  const fs = P.face.scale || 1;
  const gap = eyeHalfGap(key, lod);
  const kind = eyeKind(pose.eyes, o.mood, lod);
  const brow = lod === 'portrait' ? STATE_BROWS[pose.state] : undefined;
  let eyes = '';
  if (mono !== 'silhouette') {
    let brows = '';
    for (const side of [-1, 1]) {
      const ex = P.face.x + side * gap;
      const ey = P.face.y;
      const turn = kind === 'look' && pose.look[0] * side > 0 ? 0.92 : 1; // far eye narrows: a cheap 3D turn
      eyes += eyeSvg(kind, ex, ey, m, side, fs * turn, paint);
      if (brow) brows += browSvg(brow, ex, ey, m, side, fs, paint);
    }
    if (lod !== 'glyph') {
      const mm = MOUTH[lod];
      const my = P.face.y + mm.dy * fs;
      const mk =
        pose.state === 'idle' && (PLANT_MOODS as readonly unknown[]).includes(o.mood)
          ? MOOD_MOUTH[o.mood as PlantMood]
          : STATE_MOUTH[pose.state];
      eyes += brows + mouthSvg(mk, P.face.x, my, mm, fs, paint);
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

  const plant = body + face;
  const posed = poseT ? `<g transform="${poseT.trim()}">${plant}</g>` : plant;

  // ── state mark: portrait only, on the disc above the plant (never in knockout layers)
  const mk = lod === 'portrait' && !mono ? marksSvg(pose.state, paint) : '';
  const marks = mk ? `<g>${mk}</g>` : '';

  return (
    `<svg class="${cls}" viewBox="0 0 100 100" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" focusable="false" aria-hidden="true">` +
    discEl +
    `<g transform="${fitT}">${posed}</g>${marks}</svg>`
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

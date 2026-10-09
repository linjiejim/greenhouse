/**
 * Plant-avatar SVG builder — options → markup string (no DOM, no React).
 *
 * Skeleton (spec §2): tinted disc → [done bloom] → fit group (optical fit) → pose group
 * (state pose about the species pivot) → [motion hooks] → rim underlay pass → fill pass
 * → look group → face (eyes, brows at portrait, mouth above glyph) → [state mark, portrait].
 * Guarantees:
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
  PLANT_TINT_HUES,
  PLANT_TINT_TONES,
  PLANT_TONES,
  type PlantLod,
  type PlantPalette,
  type PlantPresetDef,
} from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import { desaturate, f, f2, luminance, mix, toOklch, withHue } from './plant-geometry';

export { hashSeed };

const hasOwn = (o: object, k: unknown): boolean => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Radius the rimmed silhouette lands on, per LOD. */
export const FIT_TARGET = Object.freeze({ glyph: 48, avatar: 47.5, portrait: 47 } as const satisfies Record<
  PlantLod,
  number
>);

// ─── states, poses, eyes ────────────────────────────────────────────────────

type EyeKind = 'calm' | 'soft' | 'bright' | 'drowsy' | 'look' | 'focus' | 'happy' | 'sad' | 'attentive' | 'closed';
type MouthKind = 'smile' | 'grin' | 'side' | 'talk' | 'o' | 'wobble' | 'small';
/** Mouth shapes (the `mouth` override — a native renderer closing a talking mouth between beats). */
export type PlantMouth = MouthKind;
const MOUTHS: readonly MouthKind[] = ['smile', 'grin', 'side', 'talk', 'o', 'wobble', 'small'];
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
  /** Fill + stroke in one tone. 'auto' must merge them into ONE style attribute: two `style`
   *  attributes are invalid XML, and the HTML parser silently drops the second (the keyline). */
  both: (tone: keyof PlantPalette) => string;
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
      return stroke(
        `M${f(cx - w * 0.35)} ${f(cy)}Q${f(cx + w * 0.3)} ${f(cy + h * 0.75)} ${f(cx + w * 0.95)} ${f(cy - h * 0.25)}`,
      );
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

function marksSvg(state: PlantState, paint: Paint, animate: boolean): string {
  const c = (name: string) => (animate ? ` class="pa-mk-${name}"` : '');
  const line = (d: string, w: number, name: string, op = 1) =>
    `<path${c(name)} d="${d}" fill="none" ${paint.stroke('mark')} stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${op < 1 ? ` opacity="${op}"` : ''}/>`;
  const badge = (fill: string, glyph: string) =>
    `<g${c('badge')}><circle cx="84" cy="16" r="11" fill="${fill}"/>${glyph}</g>`;
  const star = (x: number, y: number, r: number) => {
    const k = r * 0.22;
    return (
      `<path${c('spark')} d="M${f(x)} ${f(y - r)}Q${f(x + k)} ${f(y - k)} ${f(x + r)} ${f(y)}Q${f(x + k)} ${f(y + k)} ${f(x)} ${f(y + r)}` +
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
        .map(([x, y, r]) => `<circle${c('dot')} cx="${x}" cy="${y}" r="${r}" ${paint.fill('mark')}/>`)
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
      return `<path${c('drop')} d="M83 9C87.6 15.6 88.8 19 86.3 21.9C84.3 24.2 80.7 23.5 80.4 20.3C80.2 17.6 81.5 15 83 9Z" fill="${MARK.drop}"/>`;
    case 'sleep':
      return (
        line('M68 26h6l-6 6h6', 2.4, 'z', 0.8) +
        line('M78 15h7.5l-7.5 7.5h7.5', 2.4, 'z', 0.8) +
        line('M88 3h9l-9 9h9', 2.4, 'z', 0.8)
      );
    default:
      return '';
  }
}

const BLINKS = new Set<EyeKind>(['calm', 'soft', 'bright', 'look', 'focus', 'attentive', 'drowsy']);

// ─── palettes ───────────────────────────────────────────────────────────────

export interface PlantThemePalettes {
  light: PlantPalette;
  dark: PlantPalette;
}

/**
 * A palette's body family turned to a tint's hue: each tone keeps its hue offset from the body and
 * its luminance — nudged a hair away from the body's, so 8-bit rounding can only widen a contrast.
 */
function tinted(pal: PlantPalette, hue: number): PlantPalette {
  const base = toOklch(pal.body)[2];
  const body = luminance(pal.body);
  const out = { ...pal } as Record<keyof PlantPalette, string>;
  for (const t of PLANT_TINT_TONES) {
    const lum = luminance(pal[t]);
    const away = t === 'body' ? 0 : Math.sign(lum - body) * 0.004;
    out[t] = withHue(pal[t], hue + toOklch(pal[t])[2] - base, Math.min(1, Math.max(0, lum + away)));
  }
  return out;
}

/**
 * State-treated palettes for both themes (desat / dim are the only shifts; disc, ink, catch never
 * change). A `tint` turns the body family to its hue first (PLANT_TINT_HUES).
 */
function statePalettes(P: PlantPresetDef, pose: PlantPose, tint?: unknown): PlantThemePalettes {
  const hue = hasOwn(PLANT_TINT_HUES, tint) ? PLANT_TINT_HUES[tint as keyof typeof PLANT_TINT_HUES] : null;
  const tone = (raw: PlantPalette): PlantPalette => {
    const pal = hue == null ? raw : tinted(raw, hue);
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
export function plantPalette(
  plant: PlantId | string,
  state: PlantStateInput = 'idle',
  tint?: string,
): PlantThemePalettes {
  return statePalettes(PLANT_PRESETS[isPlantId(plant) ? plant : DEFAULT_PLANT], poseFor(state), tint);
}

// ─── build ──────────────────────────────────────────────────────────────────

export type PlantAvatarTheme = 'light' | 'dark' | 'auto';

export interface PlantAvatarSvgOptions {
  /** Species id; unknown → 'sprout'. */
  plant?: PlantId | string;
  /** idle|thinking|speaking|done|error|waiting|sleep|hello or a product alias; unknown → idle. */
  state?: PlantStateInput;
  /** Render px — drives LOD, the opt-in keyline's weight and motion amplitude (default 32). */
  size?: number;
  /** 'auto' paints through CSS vars switched by `.dark-theme` (web); explicit for static targets. Default 'light'. */
  theme?: PlantAvatarTheme;
  /** false → attributes only: no classes, no style, no CSS needed. Default true. */
  animate?: boolean;
  /** Tinted backing disc (default true). */
  disc?: boolean;
  /** Opt-in keyline underlay in the `rim` tone (busy export backgrounds). The flat design paints none. */
  rim?: boolean;
  /** Resting eyes (idle only). Bots no longer pass it — their face follows state. */
  mood?: PlantMood;
  /** Colour (PLANT_TINTS: the body family turned to a hue; `plant` / unknown = the species' own). */
  tint?: string;
  /**
   * One layer of the avatar, for native renderers that move the face on its own (a glance, a
   * head shake, a blink): `body` = everything but the face, `face` = only the face (eyes, brows,
   * mouth) — same viewBox and transforms, so the two stack into the whole avatar.
   */
  layer?: 'body' | 'face';
  /** Eyes shut (the closed frame of a blink: each eye flattened about its centre). */
  blink?: boolean;
  /** Mouth override (a talking mouth closing between beats); unknown → the state's mouth. */
  mouth?: PlantMouth;
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
  hello: 'pa-m-hello',
};
const ONE_SHOT_CLASS: Partial<Record<PlantState, string>> = {
  idle: 'pa-o-sway',
  thinking: 'pa-o-bob',
  done: 'pa-o-perk',
  error: 'pa-o-droop',
  sleep: 'pa-o-settle',
  hello: 'pa-o-perk',
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
  const layer = o.layer === 'body' || o.layer === 'face' ? o.layer : null;
  const disc = o.disc !== false && !mono && layer !== 'face';
  const rimOn = o.rim === true && !mono && !o.raw;

  // ── paint: explicit theme → presentation attributes; 'auto' → CSS vars with the light fallback
  const pals = statePalettes(P, pose, o.tint);
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
  if (mono !== 'eyes' && layer !== 'face') {
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

  // ── face: eyes (+ brows at portrait), then the mouth from the avatar LOD up
  const m = EYE[lod];
  const fs = P.face.scale || 1;
  const gap = eyeHalfGap(key, lod);
  const kind = eyeKind(pose.eyes, o.mood, lod);
  const shut = o.blink === true;
  const blink = animate && !shut && BLINKS.has(kind);
  const brow = lod === 'portrait' ? STATE_BROWS[pose.state] : undefined;
  let eyes = '';
  if (mono !== 'silhouette' && layer !== 'body') {
    let brows = '';
    for (const side of [-1, 1]) {
      const ex = P.face.x + side * gap;
      const ey = P.face.y;
      const turn = kind === 'look' && pose.look[0] * side > 0 ? 0.92 : 1; // far eye narrows: a cheap 3D turn
      const inner = eyeSvg(kind, ex, ey, m, side, fs * turn, paint);
      eyes += blink
        ? `<g class="pa-blink" style="transform-origin:${f(ex)}px ${f(ey)}px">${inner}</g>`
        : shut
          ? `<g transform="translate(${f(ex)} ${f(ey)}) scale(1 0.1) translate(${f(-ex)} ${f(-ey)})">${inner}</g>`
          : inner;
      if (brow) brows += browSvg(brow, ex, ey, m, side, fs, paint);
    }
    if (animate && pose.state === 'thinking') eyes = `<g class="pa-glance">${eyes}</g>`;
    if (lod !== 'glyph') {
      const mm = MOUTH[lod];
      const my = P.face.y + mm.dy * fs;
      const mk = MOUTHS.includes(o.mouth as MouthKind)
        ? (o.mouth as MouthKind)
        : pose.state === 'idle' && (PLANT_MOODS as readonly unknown[]).includes(o.mood)
          ? MOOD_MOUTH[o.mood as PlantMood]
          : STATE_MOUTH[pose.state];
      const mouth = mouthSvg(mk, P.face.x, my, mm, fs, paint);
      eyes +=
        brows +
        (animate && pose.state === 'speaking'
          ? `<g class="pa-talk" style="transform-origin:${f(P.face.x)}px ${f(my)}px">${mouth}</g>`
          : mouth);
    }
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
  const face =
    layer === 'body'
      ? ''
      : animate
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
  if (animate && lod === 'portrait' && pose.fx === 'bloom' && layer !== 'face') {
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

  // ── state mark: portrait only, on the disc above the plant (never in knockout layers)
  const mk = lod === 'portrait' && !mono && layer !== 'face' ? marksSvg(pose.state, paint, animate) : '';
  const marks = mk ? `<g${animate ? ' class="pa-mk"' : ''}>${mk}</g>` : '';

  return (
    `<svg class="${cls}" viewBox="0 0 100 100" width="${size}" height="${size}" ` +
    `xmlns="http://www.w3.org/2000/svg" focusable="false" ${a11y}${data}${styleAttr}>` +
    discEl +
    fx +
    `<g${animate ? ' class="pa-fit"' : ''} transform="${fitT}">${posed}</g>${marks}</svg>`
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
.pa .pa-m-hello{animation:pa-hop 1.1s cubic-bezier(.3,0,.3,1) 3}
.pa.pa-s-hello .pa-reach{animation:pa-wave .45s ease-in-out 6 alternate}
.pa.pa-s-hello.pa-morph .pa-reach{animation-delay:.5s}
.pa .pa-talk{animation:pa-chat .45s ease-in-out var(--pa-phase) infinite alternate}
.pa .pa-mk-dot{transform-box:fill-box;transform-origin:center;animation:pa-dot 1.4s ease-in-out infinite}
.pa .pa-mk-dot:nth-child(2){animation-delay:.2s}
.pa .pa-mk-dot:nth-child(3){animation-delay:.4s}
.pa .pa-mk-dash{animation:pa-dash .4s linear infinite alternate}
.pa .pa-mk-badge{transform-box:fill-box;transform-origin:center;animation:pa-pop .5s cubic-bezier(.3,1.6,.5,1) backwards,pa-pulse .7s ease-in-out .5s 4 alternate}
.pa .pa-mk-spark{transform-box:fill-box;transform-origin:center;animation:pa-twinkle 1.3s ease-in-out 2 backwards}
.pa .pa-mk-spark:nth-of-type(3){animation-delay:.35s}
.pa .pa-mk-spark:nth-of-type(4){animation-delay:.7s}
.pa .pa-mk-drop{animation:pa-drip 1.6s ease-in 3 backwards}
.pa .pa-mk-z{transform-box:fill-box;transform-origin:center;animation:pa-z 3s ease-out 3 backwards}
.pa .pa-mk-z:nth-child(2){animation-delay:1s}
.pa .pa-mk-z:nth-child(3){animation-delay:2s}
.pa .pa-mk-arc{animation:pa-flick .45s ease-in-out 6 alternate}
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
@keyframes pa-hop{0%,40%,100%{transform:none}20%{transform:translateY(calc(var(--pa-amp)*-2.6px))}}
@keyframes pa-wave{0%{transform:rotate(8deg)}100%{transform:rotate(-16deg)}}
@keyframes pa-chat{0%{transform:none}100%{transform:scaleY(.45)}}
@keyframes pa-dot{0%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:scale(1.1)}}
@keyframes pa-dash{0%{transform:translateX(-1.5px)}100%{transform:translateX(1.5px)}}
@keyframes pa-pop{0%{transform:scale(0)}100%{transform:none}}
@keyframes pa-pulse{0%{transform:none}100%{transform:scale(1.12)}}
@keyframes pa-twinkle{0%,100%{opacity:0;transform:scale(.3)}50%{opacity:1;transform:scale(1) rotate(45deg)}}
@keyframes pa-drip{0%{opacity:0;transform:translateY(-3px)}25%{opacity:1}100%{opacity:0;transform:translateY(7px)}}
@keyframes pa-z{0%{opacity:0;transform:translate(-2px,4px) scale(.6)}30%{opacity:1}100%{opacity:0;transform:translate(3px,-6px) scale(1.1)}}
@keyframes pa-flick{0%{opacity:.25}100%{opacity:1}}
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

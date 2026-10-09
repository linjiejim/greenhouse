/**
 * React-free rules of the RN PlantAvatar (plant-avatar.tsx): which motion runs, where it pivots,
 * and how the builder string is adapted for SvgXml. Kept out of the component so the root vitest
 * can pin them (plant-avatar-native.test.ts) without a React Native renderer.
 */

import { FIT_TARGET, lodFor, poseFor } from './plant-avatar-svg';
import { PLANT_PRESETS, type PlantLod } from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import type { PlantId, PlantState, PlantStateInput } from './plant-ids';

/**
 * The motions RN plays (spec §5–6, ported to Reanimated transforms on the plant layer): an ambient
 * idle float, the thinking nod, the speaking stretch, the waiting lean, and the one-shots — done's
 * perk, error's droop, hello's hop.
 */
export type PlantMotion = 'float' | 'nod' | 'talk' | 'lean' | 'perk' | 'droop' | 'hop';

/** Keyframe amplitude per LOD — mirrors the core's LOD_AMP so 44px motion stays perceptible. */
export const LOD_AMP: Readonly<Record<PlantLod, number>> = { glyph: 2.2, avatar: 1.6, portrait: 1 };

const STATE_MOTION: Readonly<Record<PlantState, PlantMotion | null>> = {
  idle: 'float',
  thinking: 'nod',
  speaking: 'talk',
  waiting: 'lean',
  done: 'perk',
  error: 'droop',
  hello: 'hop',
  sleep: null, // asleep holds still
};

/**
 * Motion for a state. `animate: true` (the avatars that stand for a Bot being here: a DM's title,
 * the thread's start, a profile, the Bot talking right now) plays the state's motion; `false`
 * (lists, rows, pickers) never moves; unset keeps the old default — thinking nods, and idle floats
 * at hero size (≥ 80px). Reduced motion is the caller's veto.
 */
export function motionFor(state: PlantStateInput | undefined, size: number, animate?: boolean): PlantMotion | null {
  const s = poseFor(state || 'idle').state;
  const on = animate ?? (s === 'thinking' || (s === 'idle' && size >= 80));
  return on ? STATE_MOTION[s] : null;
}

/**
 * The idle float: one slow rise-and-settle (with a lean that alternates sides), then a rest in
 * which nothing runs at all — alive, never busy, and the screen goes idle between bouts. The first
 * bout and every rest are offset by the Bot's id, so a roster never bobs in step.
 */
export const FLOAT_RISE_MS = 1600;
export const FLOAT_SETTLE_MS = 2200;

/** How far the plant rises (pt): about 4.5% of the avatar, never under 1pt or over 3pt. */
export function floatLift(size: number): number {
  return Math.min(3, Math.max(1, size * 0.045));
}

/** A stable 0–1 number for an id (FNV-1a) — the motion's phase. */
export function motionSeed(id: string | undefined): number {
  if (!id) return 0.5;
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i += 1) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 0x100000000;
}

/** Before the first bout: 0.4–2.4s. */
export function floatDelay(seed: number): number {
  return Math.round(400 + seed * 2000);
}

/** The rest after bout `n`: 2.2–5.2s, a different length each time. */
export function floatRest(seed: number, n: number): number {
  const x = (seed + n * 0.618034) % 1;
  return Math.round(2200 + x * 3000);
}

/**
 * The species pivot (where the plant grows from) in px of the box — the motion's transform
 * origin, so the plant stretches and nods from its base. Numbers, not a '%' string: RN's
 * transform-origin string parser only reads integers ("81.9%" would parse as "9%").
 */
export function pivotOrigin(plant: PlantId, size: number): [x: number, y: number, z: number] {
  const lod = lodFor(size);
  const [maxR, dx, dy] = PLANT_FIT[plant][lod];
  const s = Math.min(1.3, FIT_TARGET[lod] / maxR); // no keyline: the flat design paints none
  const [px, py] = PLANT_PRESETS[plant].pivot;
  const unit = size / 100;
  return [(50 + s * (px + dx - 50)) * unit, (50 + s * (py + dy - 50)) * unit, 0];
}

/**
 * SvgXml maps every attribute 1:1 onto a prop, and react-dom (Expo web) rejects the root's web
 * hooks (`class`, `aria-hidden`). Drop them — the wrapper View carries accessibility — so the
 * builder output itself stays byte-identical to the core (parity test).
 */
export function forSvgXml(svg: string): string {
  return svg.replace(/^<svg class="[^"]*" /, '<svg ').replace(' focusable="false" aria-hidden="true">', '>');
}

// ─── The face's own life (layered avatars: body + face, plant-avatar.tsx) ───

/** A small seeded random stream (mulberry32): each avatar's blinks and glances come in its own rhythm. */
export function lifeRandom(seed: number): () => number {
  let a = Math.floor(seed * 0x100000000) >>> 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

/** Which motions blink: every open-eyed one (done smiles, error looks down, asleep has its eyes shut). */
export function blinksIn(motion: PlantMotion): boolean {
  return motion === 'float' || motion === 'nod' || motion === 'talk' || motion === 'lean';
}

/** Which motions glance aside now and then (a turn of the head): at rest and while thinking. */
export function glancesIn(motion: PlantMotion): boolean {
  return motion === 'float' || motion === 'nod';
}

/** How long the eyes stay shut in a blink (ms) — a real blink is 100–150. */
export const BLINK_MS = 120;

/** The wait before the next blink: 2.4–6s; one in five comes as a double blink. */
export function nextBlink(rand: () => number): { wait: number; double: boolean } {
  return { wait: Math.round(2400 + rand() * 3600), double: rand() < 0.2 };
}

/** The wait before the next glance (5–11s), its side, and how long it holds (0.6–1.4s). */
export function nextGlance(rand: () => number): { wait: number; side: 1 | -1; hold: number } {
  return { wait: Math.round(5000 + rand() * 6000), side: rand() < 0.5 ? -1 : 1, hold: Math.round(600 + rand() * 800) };
}

/** How far the face turns in a glance or a head shake (pt): ~2.8 viewBox units at the LOD's amplitude, ≤ 2.5pt. */
export function faceShift(size: number): number {
  return Math.min(2.5, (2.8 * LOD_AMP[lodFor(size)] * size) / 100);
}

/**
 * A talking mouth's next beat: open 110–230ms, then closed 70–150ms — and now and then a pause
 * (a breath between phrases, closed 320–520ms).
 */
export function mouthBeat(rand: () => number): { open: number; closed: number } {
  const pause = rand() < 0.12;
  return {
    open: Math.round(110 + rand() * 120),
    closed: Math.round(pause ? 320 + rand() * 200 : 70 + rand() * 80),
  };
}

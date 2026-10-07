/**
 * React-free rules of the RN PlantAvatar (plant-avatar.tsx): which motion runs, where it pivots,
 * and how the builder string is adapted for SvgXml. Kept out of the component so the root vitest
 * can pin them (plant-avatar-native.test.ts) without a React Native renderer.
 */

import { FIT_TARGET, lodFor, poseFor } from './plant-avatar-svg';
import { PLANT_PRESETS, type PlantLod } from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import type { PlantId, PlantStateInput } from './plant-ids';

/** The two motions RN can do without CSS (spec §10.8): hero breathing and the thinking nod. */
export type PlantMotion = 'breathe' | 'nod';

/** Keyframe amplitude per LOD — mirrors the core's LOD_AMP so 44px motion stays perceptible. */
export const LOD_AMP: Readonly<Record<PlantLod, number>> = { glyph: 2.2, avatar: 1.6, portrait: 1 };
/** Ambient idle cap (spec §6.4, WCAG 2.2.2): 3 breaths ≈ 15s, then the avatar holds still. */
export const IDLE_CYCLES = 3;

/**
 * Motion for a state (spec §6): thinking nods while it lasts; idle breathes only at hero size
 * (≥ 80px); every other state shows its static pose. `animate: false` (lists) never moves;
 * `animate: true` opts a smaller idle avatar into breathing. Reduced motion is the caller's veto.
 */
export function motionFor(state: PlantStateInput | undefined, size: number, animate?: boolean): PlantMotion | null {
  const s = poseFor(state || 'idle').state;
  const on = animate ?? (s === 'thinking' || (s === 'idle' && size >= 80));
  if (!on) return null;
  return s === 'thinking' ? 'nod' : s === 'idle' ? 'breathe' : null;
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

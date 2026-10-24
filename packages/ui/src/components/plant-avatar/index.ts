/**
 * Plant avatars — every Bot / Agent is one flat, geometric plant with a small ink face on a tinted disc.
 * Ids, the legacy resolver and the writer rule: `@greenhouse/types/plant-avatar`
 * (re-exported here for convenience). Design spec:
 * docs/specs/assets/avatar-proto/final/spec.md.
 *
 * Ported verbatim from v2 (3.0, spec B10) so web, v2 and the mobile app draw the same pixels;
 * the parity digests in plant-avatar-parity.test.ts must stay identical across them. The design
 * spec and the gallery / fit scripts named in comments live in the v2 line, not in this repo.
 *
 * React-free entry point for scripts and static exports:
 * `@greenhouse/ui/components/plant-avatar/svg`.
 */

export {
  PlantAvatar,
  PlantAvatarStack,
  PLANT_AVATAR_SIZES,
  PLANT_SETTLE_MS,
  usePlantSettling,
  plantAvatarPx,
  type PlantAvatarProps,
  type PlantAvatarSize,
  type PlantAvatarStackItem,
  type PlantAvatarStackProps,
} from './plant-avatar';
export {
  buildPlantAvatarSvg,
  buildPlantMonoLayers,
  plantPalette,
  poseFor,
  lodFor,
  rimUnits,
  eyeHalfGap,
  hashSeed,
  PLANT_AVATAR_CSS,
  ensurePlantAvatarStyles,
  type PlantAvatarSvgOptions,
  type PlantAvatarTheme,
  type PlantPose,
  type PlantThemePalettes,
} from './plant-avatar-svg';
export { morphPlantAvatar } from './plant-morph';
export { legacyToPlant, legacyToMood, resolvePlantAvatar, type ResolvedPlantAvatar } from '@greenhouse/types';
export type { PlantLod, PlantPalette, PlantTone } from './plant-catalogue';

export { stateForWork, type PlantWork } from './plant-work';
export { usePlantWorkState } from './use-plant-work';

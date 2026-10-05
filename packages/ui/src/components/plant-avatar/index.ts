/**
 * Plant avatars — every Bot / Agent is one real plant + two ink eyes on a tinted disc.
 * Ids, the legacy resolver and the writer rule: `@greenhouse/types/plant-avatar`
 * (re-exported here for convenience). Design spec:
 * docs/specs/assets/avatar-proto/final/spec.md.
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
export { morphPlantAvatar, type MorphTiming } from './plant-morph';
export { legacyToPlant, legacyToMood, resolvePlantAvatar, type ResolvedPlantAvatar } from '@greenhouse/types';
export type { PlantLod, PlantPalette, PlantTone } from './plant-catalogue';

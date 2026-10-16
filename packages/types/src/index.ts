/**
 * Shared types that every client and the server agree on: plant avatars, rich-output
 * blocks, entity deep links and the deployment config shape. API request and response
 * types live in @greenhouse/contract.
 */

export { registerEntityKinds, extensionEntityKinds } from './entity-links.js';
export type { ExtensionEntityKindDef, CoreEntityKind, ExtensionEntityKind } from './entity-links.js';

// Plant avatars: ids, the legacy resolver and the writer rule. Dependency-free (no zod);
// the renderer lives in @greenhouse/ui/components/plant-avatar.
export type {
  PlantId,
  PlantState,
  PlantStateAlias,
  PlantStateInput,
  PlantMood,
  PlantTint,
  ProfileAvatar,
  ResolvedPlantAvatar,
} from './plant-avatar.js';
export {
  PLANT_IDS,
  DEFAULT_PLANT,
  PLANT_STATES,
  STATE_ALIASES,
  PLANT_MOODS,
  PLANT_TINTS,
  TEMPLATE_PLANT,
  COLOR_FAMILY,
  PLANT_LEGACY_COLOR,
  IMPLICIT_POOL,
  isPlantId,
  isPlantMood,
  isPlantTint,
  avatarTint,
  hashSeed,
  legacyToPlant,
  legacyToMood,
  resolvePlantAvatar,
  MOOD_FACE_STYLE,
  withPlant,
  withTint,
  withMood,
  plantAvatarConfig,
} from './plant-avatar.js';

// Avatar config types only, so client bundles never pull in zod. Server code imports
// the schema values from '@greenhouse/types/profile-manifest'.
export type {
  AvatarConfig,
  SproutyColorId,
  SproutyAccessoryId,
  SproutyLeafStyleId,
  SproutyFaceStyleId,
} from './profile-manifest.js';

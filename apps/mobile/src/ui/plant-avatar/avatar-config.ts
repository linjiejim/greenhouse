// VENDORED subset of packages/types/src/profile-manifest.ts (apps/mobile cannot import workspace
// packages — see apps/mobile/AGENTS.md). The legacy Sprouty id tables are copied verbatim (they
// type the plant-avatar legacy mapping in ./plant-ids.ts); `AvatarConfig` is the canonical zod
// schema written out as a plain interface (zod is not a mobile dependency). Drift guard:
// src/bots/vendor/vendor.parity.test.ts (declarations verbatim + the schema's key set).

// ─── Legacy Sprouty avatar vocabulary ────────────────────
// The option ids the retired Sprouty mascot stored. Avatars are no longer drawn
// from them, but stored rows are never rewritten, so they stay readable: the
// plant-avatar legacy mapping (COLOR_FAMILY, accessory / leafStyle hints,
// faceStyle → mood) is typed against these unions.

export const SPROUTY_COLOR_IDS = [
  'forest',
  'ocean',
  'blossom',
  'sunset',
  'lavender',
  'sunshine',
  'midnight',
  'autumn',
] as const;
export type SproutyColorId = (typeof SPROUTY_COLOR_IDS)[number];

export const SPROUTY_ACCESSORY_IDS = [
  'crown',
  'cap',
  'graduation',
  'headset',
  'round-glasses',
  'sunglasses',
  'coffee',
  'wrench',
  'magnifier',
  'pencil',
  'clipboard',
  'chart',
] as const;
export type SproutyAccessoryId = (typeof SPROUTY_ACCESSORY_IDS)[number];

export const SPROUTY_LEAF_STYLE_IDS = ['normal', 'big', 'mini', 'double'] as const;
export type SproutyLeafStyleId = (typeof SPROUTY_LEAF_STYLE_IDS)[number];

export const SPROUTY_FACE_STYLE_IDS = ['default', 'happy', 'sparkle', 'sleepy'] as const;
export type SproutyFaceStyleId = (typeof SPROUTY_FACE_STYLE_IDS)[number];

/**
 * Avatar DSL — a Bot's stored avatar JSON (canonical: `avatarConfigSchema`).
 *
 * `plant` is the species id (PLANT_IDS in ./plant-ids) and `mood` the resting
 * eyes (PLANT_MOODS). Every legacy Sprouty key stays readable and resolves to a
 * plant at render time (`legacyToPlant` / `legacyToMood`); nothing is migrated.
 * Writers store `plant` plus the nearest legacy `color` (`withPlant`). Plain
 * strings: unknown ids are kept and render through the resolver's fallbacks.
 */
export interface AvatarConfig {
  plant?: string;
  mood?: string;
  color?: string;
  accessories?: string[];
  leafStyle?: string;
  faceStyle?: string;
  eyeStyle?: string;
  palette?: { body: string; leaf: string };
}

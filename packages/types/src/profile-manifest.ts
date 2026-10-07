/**
 * The avatar DSL (plant + legacy Sprouty keys) shared by Bots and the Chat picker.
 *
 * Not a profile validator: system profiles are YAML files in
 * `apps/api/src/profiles/` (plus any `packs.profiles` directory) checked on load
 * by the hand-written `validateProfile()` in `apps/api/src/profiles/profile.ts`,
 * and Bots are checked by `apps/api/src/bots/routes.ts`. (The zod manifest
 * schemas that once described custom Agents were deleted with them, 2026-10.) The
 * legacy Sprouty option-ID types are re-exported by the package index: the
 * plant-avatar legacy mapping (`legacyToPlant` / `legacyToMood` in
 * `@greenhouse/types/plant-avatar`) pins its input tables against them.
 *
 * NOTE on bundling: this module imports zod (a runtime value). It is exported
 * via the dedicated `@greenhouse/types/profile-manifest` subpath and ONLY
 * re-exported as *types* from the package index, so the web bundle (which
 * imports types only) never pulls in zod.
 */

import { z } from 'zod';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// ─── Legacy Sprouty avatar vocabulary ────────────────────
// The option ids the retired Sprouty mascot stored. Avatars are no longer drawn
// from them, but stored rows are never rewritten (custom_profile_versions.avatar
// is hashed), so they stay readable: the plant-avatar legacy mapping
// (COLOR_FAMILY, accessory / leafStyle hints, faceStyle → mood) is typed against
// these unions. The zod schema below deliberately stays permissive (plain
// strings) so forks can add options and the resolver can ignore unknowns.

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
 * Avatar DSL — shared by custom Agent avatars and Bots.
 *
 * `plant` is the species id (PLANT_IDS in `@greenhouse/types/plant-avatar`) and
 * `mood` the resting eyes (PLANT_MOODS). Every legacy Sprouty key stays accepted
 * and readable — `color`, `accessories`, `leafStyle`, `faceStyle`, the profile
 * editor's `eyeStyle` and the free `palette` hexes — and resolves to a plant at
 * render time (`legacyToPlant` / `legacyToMood`); nothing is migrated. Writers
 * store `plant` plus the nearest legacy `color` (PLANT_LEGACY_COLOR) so older
 * clients still show a matching hue. Plain strings: unknown ids are kept and
 * render through the resolver's fallbacks.
 */
export const avatarConfigSchema = z.object({
  plant: z.string().max(40).optional(),
  mood: z.string().max(40).optional(),
  color: z.string().max(40).optional(),
  accessories: z.array(z.string().max(40)).max(10).optional(),
  leafStyle: z.string().max(40).optional(),
  faceStyle: z.string().max(40).optional(),
  eyeStyle: z.string().max(40).optional(),
  palette: z
    .object({
      body: z.string().regex(HEX_COLOR_RE, 'body must be a #rrggbb hex color'),
      leaf: z.string().regex(HEX_COLOR_RE, 'leaf must be a #rrggbb hex color'),
    })
    .optional(),
});
export type AvatarConfig = z.infer<typeof avatarConfigSchema>;

/**
 * Agent Profile manifest schemas (zod) and the avatar DSL (plant + legacy Sprouty keys).
 *
 * Not the runtime validator: system profiles are YAML files in
 * `apps/api/src/profiles/` (plus any `packs.profiles` directory) checked on load
 * by the hand-written `validateProfile()` in `apps/api/src/profiles/profile.ts`,
 * and custom Agents are checked by `apps/api/src/routes/profiles.ts`. The legacy
 * Sprouty option-ID types are re-exported by the package index: the plant-avatar
 * legacy mapping (`legacyToPlant` / `legacyToMood` in `@greenhouse/types/plant-avatar`)
 * pins its input tables against them.
 *
 * NOTE on bundling: this module imports zod (a runtime value). It is exported
 * via the dedicated `@greenhouse/types/profile-manifest` subpath and ONLY
 * re-exported as *types* from the package index, so the web bundle (which
 * imports types only) never pulls in zod.
 */

import { z } from 'zod';

// ─── Constants / limits ──────────────────────────────────

export const PROFILE_MANIFEST_VERSION = 1;
export const MAX_SYSTEM_PROMPT = 8000;
export const MAX_CAPABILITIES = 6;
export const MAX_SUGGESTED_FOLLOWUPS = 4;
export const MAX_STEPS_LIMIT = 50;

/** Custom profiles inherit model + access ceiling from one of these system bases. */
export const CUSTOM_BASE_PROFILE_IDS = ['default', 'team'] as const;
export type CustomBaseProfileId = (typeof CUSTOM_BASE_PROFILE_IDS)[number];

// ─── Leaf schemas ────────────────────────────────────────

export const capabilitySchema = z.object({
  icon: z.string().min(1).max(40),
  label: z.string().min(1).max(60),
  prompt: z.string().min(1).max(400),
});
export type Capability = z.infer<typeof capabilitySchema>;

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

/**
 * Safe model knobs a user may set on a custom profile. NOT credentials —
 * provider/baseUrl/apiKey are deployment-level and never live here.
 */
export const modelOptionsSchema = z.object({
  thinking: z.boolean().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().positive().max(200000).optional(),
});
export type ModelOptions = z.infer<typeof modelOptionsSchema>;

export const modelChoiceSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
});
export type ModelChoice = z.infer<typeof modelChoiceSchema>;

export const accessConfigSchema = z.object({
  level: z.enum(['public', 'internal', 'admin', 'hidden']),
  requires_session: z.boolean(),
  rich_output: z.boolean(),
});
export type AccessConfig = z.infer<typeof accessConfigSchema>;

/**
 * Full model config — system-profile only. `apiKey` is the NAME of an env var,
 * never a raw secret (see packages/agent-core/src/model.ts). Structurally
 * compatible with agent-core's `ModelConfig`.
 */
export const modelConfigSchema = z.object({
  id: z.string().optional(),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  options: modelOptionsSchema.optional(),
  choices: z.array(modelChoiceSchema).optional(),
});
export type ModelConfigInput = z.infer<typeof modelConfigSchema>;

// ─── Fields shared by user manifests + system profiles ───

const sharedProfileFields = {
  name: z.string().trim().min(1).max(60),
  description: z.string().trim().max(280).optional(),
  system_prompt: z.string().trim().min(1).max(MAX_SYSTEM_PROMPT),
  tools: z.array(z.string()).default([]),
  max_steps: z.number().int().min(1).max(MAX_STEPS_LIMIT).default(12),
  tool_choice: z.enum(['auto', 'none', 'required']).default('auto'),
  capabilities: z.array(capabilitySchema).max(MAX_CAPABILITIES).default([]),
  avatar: avatarConfigSchema.optional(),
  // ── Safe declarative config (surfaced to users) ──
  default_language: z.string().trim().max(40).optional(),
  greeting: z.string().trim().max(500).optional(),
  suggested_followups: z.array(z.string().trim().min(1).max(200)).max(MAX_SUGGESTED_FOLLOWUPS).optional(),
};

// ─── User-created custom profile (safe subset) ───────────
//
// Unknown keys are stripped (zod object default), so an injected `access` /
// `model` / `apiKey` never reaches storage or the prompt.

export const profileManifestSchema = z.object({
  ...sharedProfileFields,
  slug: z
    .string()
    .regex(/^[a-z0-9一-鿿-]+$/)
    .max(50)
    .optional(),
  base_profile_id: z.enum(CUSTOM_BASE_PROFILE_IDS).default('default'),
  model_options: modelOptionsSchema.optional(),
  model_choice_ids: z.array(z.string()).max(10).optional(),
});
export type ProfileManifest = z.infer<typeof profileManifestSchema>;

/**
 * Payload stored in `custom_profiles.data` (jsonb): the manifest minus the
 * fields kept as relational/queryable columns (slug, name, base_profile_id).
 * Adding a config field here = ZERO migration.
 */
export const profileDataSchema = profileManifestSchema.omit({
  slug: true,
  name: true,
  base_profile_id: true,
});
export type ProfileData = z.infer<typeof profileDataSchema>;

// ─── System / first-party profile (superset) ─────────────
//
// The privileged fields a system profile carries and a user manifest may never
// set: access tier, raw model config, hidden flag.

export const systemProfileSchema = z.object({
  ...sharedProfileFields,
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  access: accessConfigSchema,
  model: modelConfigSchema,
  hidden: z.boolean().default(false),
  version: z.string().optional(),
});
export type SystemProfile = z.infer<typeof systemProfileSchema>;

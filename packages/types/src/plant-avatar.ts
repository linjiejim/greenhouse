/**
 * Plant avatars — the zod-free vocabulary every Bot / Agent avatar is built from.
 *
 * One flat, geometric plant + an ink face on a tinted disc. Identity = species
 * (`plant`), live state = pose + face (+ a state mark at portrait size). The renderer (geometry, baked palettes,
 * SVG builder, React wrapper) lives in `@greenhouse/ui/components/plant-avatar`;
 * this module only holds the ids and the legacy-mapping tables, so the API, the
 * web pickers and the mobile app can import them at runtime without zod.
 *
 * Stored avatar JSON is never rewritten: legacy Sprouty configs (`color`,
 * `accessories`, `leafStyle`, `faceStyle`, `eyeStyle`, `palette`) render through
 * `legacyToPlant` / `legacyToMood` below. The resolver and the writer rule
 * (`withPlant` / `withTint` / `withMood` / `plantAvatarConfig`) live here, not in the ui
 * package, so the API (template seeds, fork pinning), the web editors and the
 * renderer all share one copy.
 */

import type {
  AvatarConfig,
  SproutyAccessoryId,
  SproutyColorId,
  SproutyFaceStyleId,
  SproutyLeafStyleId,
} from './profile-manifest.js';

/**
 * The sixteen species, in catalogue order. Never reorder, and only ever append: the first
 * fifteen also drive the legacy hash picks (IMPLICIT_POOL / COLOR_FAMILY).
 */
export const PLANT_IDS = Object.freeze([
  'sprout',
  'ivy',
  'sage',
  'basil',
  'fern',
  'clover',
  'monstera',
  'ginkgo',
  'maple',
  'echeveria',
  'opuntia',
  'lotus',
  'eucalyptus',
  'lavender',
  'sunflower',
  'dandelion',
] as const);
export type PlantId = (typeof PLANT_IDS)[number];

/** The built-in Sprouty's plant. Reserved: implicit resolution never lands on it. */
export const DEFAULT_PLANT = 'sprout' satisfies PlantId;

export const PLANT_STATES = Object.freeze([
  'idle',
  'thinking',
  'speaking',
  'done',
  'error',
  'waiting',
  'sleep',
  'hello',
] as const);
export type PlantState = (typeof PLANT_STATES)[number];

/** Product vocabularies → plant state (`unread` stays a StatusDot, the avatar idles). */
export const STATE_ALIASES = Object.freeze({
  responding: 'speaking',
  working: 'speaking',
  needs_you: 'waiting',
  blocked: 'waiting',
  paused: 'sleep',
  stopped: 'sleep',
  asleep: 'sleep',
  archived: 'sleep',
  unread: 'idle',
} as const satisfies Record<string, PlantState>);
export type PlantStateAlias = keyof typeof STATE_ALIASES;
/** Anything a call site may pass as a state. */
export type PlantStateInput = PlantState | PlantStateAlias;

/**
 * Resting eyes (idle only). Legacy faceStyle / eyeStyle map onto these. No longer offered by the
 * editors or rendered for Bots (2026-10: a face follows what the Bot is doing, not a setting) —
 * kept so stored configs stay readable and the builder's `mood` option keeps working.
 */
export const PLANT_MOODS = Object.freeze(['calm', 'soft', 'bright', 'drowsy'] as const);
export type PlantMood = (typeof PLANT_MOODS)[number];

/**
 * Colours a Bot can wear (`tint`): the species' own (`plant`, the default — never stored) or the
 * plant's body and disc turned to another hue at the same lightness (a blue sprout, a rose
 * cactus), so two Bots of one species tell apart at list sizes. Hues live in the renderer
 * (packages/ui plant-catalogue PLANT_TINT_HUES). Append only.
 */
export const PLANT_TINTS = Object.freeze(['plant', 'sky', 'violet', 'rose', 'coral', 'gold', 'teal'] as const);
export type PlantTint = (typeof PLANT_TINTS)[number];

/**
 * Bot template key → species: the built-in Sprouty is the sprout; the gallery templates are named
 * after theirs (蒲蒲 Dandy, 仙仙 Cactus, 卷卷 Fern, 叶叶 Clover); the retired chief of staff was
 * ivy. Bots store their `plant`, so changing a row here only affects new Bots — and
 * template-keyed avatars that never stored one.
 */
export const TEMPLATE_PLANT = Object.freeze({
  sprouty: 'sprout',
  chief: 'ivy',
  researcher: 'dandelion',
  operator: 'opuntia',
  writer: 'fern',
  analyst: 'clover',
} as const satisfies Record<string, PlantId>);

/**
 * Legacy colour id → species family. The legacy colour is the old avatar's most
 * visible attribute, so it is preserved; single-member families are injective and
 * `forest` never contains `sprout` (forest → sprout would make every legacy custom
 * Agent look like the system Sprouty).
 */
export const COLOR_FAMILY = Object.freeze({
  forest: ['basil', 'ivy', 'clover', 'monstera', 'fern', 'sage', 'opuntia'],
  ocean: ['echeveria'],
  blossom: ['lotus'],
  sunset: ['ginkgo'],
  lavender: ['lavender'],
  sunshine: ['sunflower'],
  midnight: ['eucalyptus'],
  autumn: ['maple'],
} as const satisfies Record<SproutyColorId, readonly PlantId[]>);

/** Nearest legacy colour, dual-written next to `plant` so old desktop builds degrade to a matching hue. */
export const PLANT_LEGACY_COLOR = Object.freeze({
  sprout: 'forest',
  ivy: 'forest',
  sage: 'forest',
  basil: 'forest',
  fern: 'forest',
  clover: 'forest',
  monstera: 'forest',
  opuntia: 'forest',
  ginkgo: 'sunset',
  maple: 'autumn',
  echeveria: 'ocean',
  lotus: 'blossom',
  eucalyptus: 'midnight',
  lavender: 'lavender',
  sunflower: 'sunshine',
  dandelion: 'sunshine',
} as const satisfies Record<PlantId, SproutyColorId>);

/**
 * Species a stored avatar without a `plant` may land on implicitly (resolution steps 4–6). FROZEN
 * to the fifteen species that existed when plant avatars shipped (minus the reserved sprout): a
 * longer pool would move every legacy avatar's hash pick. Later species are reachable through
 * templates and pickers only.
 */
export const IMPLICIT_POOL: readonly Exclude<PlantId, 'sprout'>[] = Object.freeze([
  'ivy',
  'sage',
  'basil',
  'fern',
  'clover',
  'monstera',
  'ginkgo',
  'maple',
  'echeveria',
  'opuntia',
  'lotus',
  'eucalyptus',
  'lavender',
  'sunflower',
] as const);

export function isPlantId(value: unknown): value is PlantId {
  return typeof value === 'string' && (PLANT_IDS as readonly string[]).includes(value);
}

export function isPlantMood(value: unknown): value is PlantMood {
  return typeof value === 'string' && (PLANT_MOODS as readonly string[]).includes(value);
}

export function isPlantTint(value: unknown): value is PlantTint {
  return typeof value === 'string' && (PLANT_TINTS as readonly string[]).includes(value);
}

/**
 * 31× rolling hash over code points. Used for the stable-id → plant fallback and
 * the per-instance loop phase; same recipe as the Bot team tool's proposed avatar.
 */
export function hashSeed(str: unknown = ''): number {
  let h = 0;
  for (const ch of String(str)) h = (h * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return h;
}

// ─── Legacy → plant resolution (render-time; spec §9) ─────────────────────
//
// Pure, total (never throws; any input → a valid id) and deterministic; no DOM.
// Resolution order:
//   1. `avatar.plant` if it is a known id
//   2. `templateKey` (TEMPLATE_PLANT: chief → ivy, researcher → dandelion, operator → opuntia, …)
//   3. exact template fingerprint (template avatars copied into Agents / Bot proposals)
//   4. legacy colour family (+ role-cue accessory, else leafStyle hint, else stable-id hash)
//   5. free `palette.leaf` / `palette.body` hex → nearest colour family by hue, then as 4
//   6. anything else (`{}` of every fork, unknown colours) → IMPLICIT_POOL[hash(stableId)]
//   7. no stable id at all, or the built-in `sprouty` → sprout

/** Hue in degrees, or null for greys. */
function hueOf(hex: string): number | null {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === mn) return null;
  const d = mx - mn;
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

const hasOwn = (o: object, k: unknown): k is string =>
  typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

/** Exact legacy template avatars (colour + role accessory) → species. */
const TEMPLATE_FINGERPRINTS: readonly (readonly [SproutyColorId, SproutyAccessoryId, PlantId])[] = [
  ['forest', 'clipboard', 'ivy'],
  ['ocean', 'magnifier', 'sage'],
  ['sunset', 'headset', 'basil'],
  ['blossom', 'pencil', 'fern'],
  ['lavender', 'chart', 'clover'],
];

/** Legacy accessory (role cue) → species, used only inside the colour family. */
const ACCESSORY_HINT: Partial<Record<SproutyAccessoryId, PlantId>> = {
  clipboard: 'ivy',
  magnifier: 'sage',
  'round-glasses': 'sage',
  graduation: 'sage',
  headset: 'basil',
  wrench: 'basil',
  coffee: 'basil',
  pencil: 'fern',
  chart: 'clover',
};
const LEAF_HINT: Partial<Record<SproutyLeafStyleId, PlantId>> = { double: 'clover', big: 'monstera', mini: 'fern' };

const FACE_MOOD: Record<SproutyFaceStyleId, PlantMood> = {
  default: 'calm',
  happy: 'soft',
  sparkle: 'bright',
  sleepy: 'drowsy',
};
/** Profile-editor eye styles (never in the id catalogue, but stored by the old editor). */
const EYE_MOOD: Record<string, PlantMood> = { classic: 'calm', dot: 'calm', soft: 'bright', focused: 'drowsy' };

/** Colour wheel anchors (hue °) of the legacy colour ids. */
const HUE_WHEEL: readonly (readonly [SproutyColorId, number])[] = [
  ['autumn', 20],
  ['sunset', 38],
  ['sunshine', 58],
  ['forest', 100],
  ['midnight', 170],
  ['ocean', 200],
  ['lavender', 275],
  ['blossom', 325],
];

/** Free palette hex → nearest legacy colour family by hue. */
function colorFromHex(hex: unknown): SproutyColorId | null {
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  const h = hueOf(hex);
  if (h == null) return null;
  let best = HUE_WHEEL[0]![0];
  let bd = 999;
  for (const [id, hh] of HUE_WHEEL) {
    const dd = Math.min(Math.abs(h - hh), 360 - Math.abs(h - hh));
    if (dd < bd) {
      bd = dd;
      best = id;
    }
  }
  return best;
}

type LooseAvatar = Record<string, unknown>;
const asRecord = (avatar: unknown): LooseAvatar =>
  avatar && typeof avatar === 'object' && !Array.isArray(avatar) ? (avatar as LooseAvatar) : {};

/** Resolve any stored avatar JSON to a plant id. Never throws; never lands on sprout implicitly. */
export function legacyToPlant(avatar: unknown, templateKey?: string | null, stableId?: string | null): PlantId {
  const a = asRecord(avatar);
  if (isPlantId(a.plant)) return a.plant;
  if (hasOwn(TEMPLATE_PLANT, templateKey)) return TEMPLATE_PLANT[templateKey as keyof typeof TEMPLATE_PLANT];
  const acc = Array.isArray(a.accessories) ? a.accessories.filter((x): x is string => typeof x === 'string') : [];
  for (const [color, accessory, plant] of TEMPLATE_FINGERPRINTS) {
    if (a.color === color && acc.includes(accessory)) return plant;
  }
  const id = typeof stableId === 'string' ? stableId : '';
  const h = hashSeed(id);
  const pal = asRecord(a.palette);
  const color: SproutyColorId | null = hasOwn(COLOR_FAMILY, a.color)
    ? (a.color as SproutyColorId)
    : colorFromHex(pal.leaf) || colorFromHex(pal.body);
  if (color) {
    const fam: readonly PlantId[] = COLOR_FAMILY[color];
    const hinted = acc
      .map((x) => (hasOwn(ACCESSORY_HINT, x) ? ACCESSORY_HINT[x as SproutyAccessoryId] : undefined))
      .find((p) => p && fam.includes(p));
    if (hinted) return hinted;
    const leaf = hasOwn(LEAF_HINT, a.leafStyle) ? LEAF_HINT[a.leafStyle as SproutyLeafStyleId] : undefined;
    if (leaf && fam.includes(leaf)) return leaf;
    return id ? fam[h % fam.length]! : fam[0]!;
  }
  if (!id || id === 'sprouty') return DEFAULT_PLANT;
  return IMPLICIT_POOL[h % IMPLICIT_POOL.length]!;
}

/** Stored avatar → resting mood: `mood` → faceStyle → eyeStyle → calm. */
export function legacyToMood(avatar: unknown): PlantMood {
  const a = asRecord(avatar);
  if (isPlantMood(a.mood)) return a.mood;
  if (hasOwn(FACE_MOOD, a.faceStyle)) return FACE_MOOD[a.faceStyle as SproutyFaceStyleId];
  if (hasOwn(EYE_MOOD, a.eyeStyle)) return EYE_MOOD[a.eyeStyle]!;
  return 'calm';
}

/** Stored avatar → colour: a known `tint`, else the species' own. */
export function avatarTint(avatar: unknown): PlantTint {
  const a = asRecord(avatar);
  return isPlantTint(a.tint) ? a.tint : 'plant';
}

export interface ResolvedPlantAvatar {
  plant: PlantId;
  /** Colour (`plant` = the species' own). */
  tint: PlantTint;
  /** Stable id → loop phase (undefined → the builder seeds from the plant). */
  seed: string | undefined;
}

/**
 * Stored avatar + context → builder options. No mood: the face follows the Bot's state
 * (`state`), never a stored setting.
 */
export function resolvePlantAvatar(
  avatar: unknown,
  { templateKey, stableId }: { templateKey?: string | null; stableId?: string } = {},
): ResolvedPlantAvatar {
  return { plant: legacyToPlant(avatar, templateKey, stableId), tint: avatarTint(avatar), seed: stableId };
}

// ─── Writer rule (both editors, the API's template seeds, fork pinning) ────

/** Resting mood → the legacy `faceStyle` that stores it. */
export const MOOD_FACE_STYLE = Object.freeze({
  calm: 'default',
  soft: 'happy',
  bright: 'sparkle',
  drowsy: 'sleepy',
} as const satisfies Record<PlantMood, SproutyFaceStyleId>);

/** The avatar keys a writer sets (AvatarConfig and ProfileAvatar both fit). */
interface WritableAvatar {
  plant?: string;
  mood?: string;
  color?: string;
  faceStyle?: string;
  tint?: string;
}

/**
 * Choose a species: `plant` plus its nearest legacy `color`, so a client that
 * predates plant avatars still shows a matching hue. Every other key is kept
 * (rollback-safe).
 */
export function withPlant<T extends WritableAvatar>(avatar: T, plant: PlantId): T {
  return { ...avatar, plant, color: PLANT_LEGACY_COLOR[plant] };
}

/**
 * Choose a resting mood. Stored as `faceStyle`; a `mood` key is dropped, because
 * `legacyToMood` reads it first and an old client editing `faceStyle` would never
 * update it.
 */
export function withMood<T extends WritableAvatar>(avatar: T, mood: PlantMood): T {
  const { mood: _superseded, ...rest } = avatar;
  return { ...rest, faceStyle: MOOD_FACE_STYLE[mood] } as T;
}

/** Choose a colour; `plant` (the species' own) drops the key. Every other key is kept. */
export function withTint<T extends WritableAvatar>(avatar: T, tint: PlantTint): T {
  const { tint: _previous, ...rest } = avatar;
  return (tint === 'plant' ? rest : { ...rest, tint }) as T;
}

/** A fresh stored avatar: species + legacy colour (+ resting mood). Accessories are not written. */
export function plantAvatarConfig(plant: PlantId, mood?: PlantMood): AvatarConfig {
  const avatar = withPlant<AvatarConfig>({}, plant);
  return mood ? withMood(avatar, mood) : avatar;
}

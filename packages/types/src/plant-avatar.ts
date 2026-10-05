/**
 * Plant avatars — the zod-free vocabulary every Bot / Agent avatar is built from.
 *
 * One real plant silhouette + two ink eyes on a tinted disc. Identity = species
 * (`plant`), live state = pose + eyes. The renderer (geometry, baked palettes,
 * SVG builder, React wrapper) lives in `@greenhouse/ui/components/plant-avatar`;
 * this module only holds the ids and the legacy-mapping tables, so the API, the
 * web pickers and the mobile app can import them at runtime without zod.
 *
 * Stored avatar JSON is never rewritten: legacy Sprouty configs (`color`,
 * `accessories`, `leafStyle`, `faceStyle`, `eyeStyle`, `palette`) render through
 * `legacyToPlant` / `legacyToMood` below. The resolver and the writer rule
 * (`withPlant` / `withMood` / `plantAvatarConfig`) live here, not in the ui
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

/** The fifteen species, in catalogue order (the order also drives hash picks — never reorder). */
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

/** Resting eyes (idle only). Legacy faceStyle / eyeStyle map onto these. */
export const PLANT_MOODS = Object.freeze(['calm', 'soft', 'bright', 'drowsy'] as const);
export type PlantMood = (typeof PLANT_MOODS)[number];

/** Bot template key → species (the templates are already named after these plants). */
export const TEMPLATE_PLANT = Object.freeze({
  chief: 'ivy',
  researcher: 'sage',
  operator: 'basil',
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
} as const satisfies Record<PlantId, SproutyColorId>);

/** Species a fresh Agent / Bot may land on implicitly (everything but the reserved sprout). */
export const IMPLICIT_POOL: readonly Exclude<PlantId, 'sprout'>[] = Object.freeze(
  PLANT_IDS.filter((id): id is Exclude<PlantId, 'sprout'> => id !== DEFAULT_PLANT),
);

export function isPlantId(value: unknown): value is PlantId {
  return typeof value === 'string' && (PLANT_IDS as readonly string[]).includes(value);
}

export function isPlantMood(value: unknown): value is PlantMood {
  return typeof value === 'string' && (PLANT_MOODS as readonly string[]).includes(value);
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
//   2. `templateKey` (chief → ivy, researcher → sage, operator → basil, writer → fern, analyst → clover)
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

export interface ResolvedPlantAvatar {
  plant: PlantId;
  mood: PlantMood;
  /** Stable id → loop phase (undefined → the builder seeds from the plant). */
  seed: string | undefined;
}

/** Stored avatar + context → builder options. */
export function resolvePlantAvatar(
  avatar: unknown,
  { templateKey, stableId }: { templateKey?: string | null; stableId?: string } = {},
): ResolvedPlantAvatar {
  return { plant: legacyToPlant(avatar, templateKey, stableId), mood: legacyToMood(avatar), seed: stableId };
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

/** A fresh stored avatar: species + legacy colour (+ resting mood). Accessories are not written. */
export function plantAvatarConfig(plant: PlantId, mood?: PlantMood): AvatarConfig {
  const avatar = withPlant<AvatarConfig>({}, plant);
  return mood ? withMood(avatar, mood) : avatar;
}

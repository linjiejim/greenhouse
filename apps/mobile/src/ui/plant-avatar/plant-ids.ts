// VENDORED subset of packages/types/src/plant-avatar.ts (apps/mobile cannot import workspace
// packages — see apps/mobile/AGENTS.md). Only what the static builder needs: the ids, states,
// aliases and moods. The legacy-mapping tables and hashSeed stay in the canonical module: mobile
// only renders the built-in Sprouty (plant 'sprout') and never resolves stored avatar configs.

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

/** The built-in Sprouty's plant. */
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

/** Resting eyes (idle only). */
export const PLANT_MOODS = Object.freeze(['calm', 'soft', 'bright', 'drowsy'] as const);
export type PlantMood = (typeof PLANT_MOODS)[number];

export function isPlantId(value: unknown): value is PlantId {
  return typeof value === 'string' && (PLANT_IDS as readonly string[]).includes(value);
}

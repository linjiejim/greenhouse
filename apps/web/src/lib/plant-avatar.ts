/**
 * Plant avatars on the web — who wears which plant, and how the editors write it.
 *
 * Rendering is `<PlantAvatar/>` from `@greenhouse/ui/components/plant-avatar`
 * (design spec: docs/specs/assets/avatar-proto/final/spec.md). How a pick is
 * written (`withPlant` / `withMood`: plant + nearest legacy colour, mood stored
 * as `faceStyle`) is the shared writer rule in `@greenhouse/types/plant-avatar`,
 * the same copy the API's template seeds use. This module holds the web-only
 * choices: which plant a profile / Bot wears, and a fresh species for a new one.
 *
 * Stored avatars are never rewritten behind the member's back: legacy rows
 * resolve at render time (`legacyToPlant`).
 */

import { DEFAULT_PLANT, PLANT_IDS, TEMPLATE_PLANT, legacyToPlant, type PlantId } from '@greenhouse/types';
import { DEFAULT_AGENT_ID } from './agent-constants';

/**
 * Fresh picks try the non-template species first: the five template plants (藤藤 ivy,
 * 蒲蒲 dandelion, 仙仙 cactus, 卷卷 fern, 叶叶 clover) stay free for the templates the member
 * may add. Every species but the reserved sprout is pickable — including those added after the
 * frozen IMPLICIT_POOL (a fresh pick is written, never re-resolved).
 */
const TEMPLATE_PLANTS = new Set<PlantId>(Object.values(TEMPLATE_PLANT));
const PICKABLE = PLANT_IDS.filter((plant) => plant !== DEFAULT_PLANT);
const FRESH_ORDER: readonly PlantId[] = [
  ...PICKABLE.filter((plant) => !TEMPLATE_PLANTS.has(plant)),
  ...PICKABLE.filter((plant) => TEMPLATE_PLANTS.has(plant)),
];

/**
 * A species none of `taken` wears yet, so a new Bot or Agent is told apart from
 * its siblings at a glance. Never the reserved sprout; cycles once every species is used.
 */
export function freshPlant(taken: readonly PlantId[]): PlantId {
  const used = new Set<PlantId>(taken);
  return FRESH_ORDER.find((plant) => !used.has(plant)) ?? FRESH_ORDER[taken.length % FRESH_ORDER.length]!;
}

/** The plant a Bot renders as: stored `plant`, else its template, else the legacy mapping seeded by its id. */
export function botPlant(bot: { id?: string; avatar?: unknown; template_key?: string | null }): PlantId {
  return legacyToPlant(bot.avatar, bot.template_key, bot.id);
}

/** The plant an Agent profile renders as (custom: `custom:<id>`; system: its id, so `sprouty` → sprout). */
export function profilePlant(profile: { id?: string | null; avatar?: unknown } | null | undefined): PlantId {
  if (!profile) return DEFAULT_PLANT;
  return legacyToPlant(profile.avatar, null, profile.id || DEFAULT_AGENT_ID);
}

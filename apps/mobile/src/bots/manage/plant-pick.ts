/**
 * Which plant a new Bot wears (spec docs/specs/20261008-mobile-bots.md §2.5.7).
 *
 * Ported from the web's apps/web/src/lib/plant-avatar.ts (`freshPlant`,
 * `botPlant`) — the declarations below are copied as they are there, and
 * ./plant-pick.test.ts runs both sides on the same inputs (behaviour parity,
 * spec §2.8 guard 4), so a member who adds a Bot on the phone gets the species
 * the web would have picked. The web module also imports app-only constants,
 * which is why this is a port and not a verbatim file copy.
 */

import { DEFAULT_PLANT, PLANT_IDS, TEMPLATE_PLANT, legacyToPlant, type PlantId } from '../../ui/plant-avatar/plant-ids';

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

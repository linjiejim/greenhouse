/**
 * Behaviour parity for ./plant-pick.ts against the web's canonical
 * apps/web/src/lib/plant-avatar.ts (spec docs/specs/20261008-mobile-bots.md
 * §2.8 guard 4): the same `taken` lists — empty, partial, template-heavy, every
 * species, repeats, longer than the catalogue — and the same stored avatars
 * give the same answers. Runs in the ROOT vitest (the canonical module resolves
 * `@greenhouse/types`).
 */

import { describe, expect, it } from 'vitest';
import * as web from '../../../../web/src/lib/plant-avatar';
import { PLANT_IDS, TEMPLATE_PLANT, type PlantId } from '../../ui/plant-avatar/plant-ids';
import { botPlant, freshPlant } from './plant-pick';

/** A small deterministic generator, so the random cases are the same on every run. */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('freshPlant', () => {
  it('never picks the reserved sprout, and skips the template plants while others are free', () => {
    const first = freshPlant([]);
    expect(first).not.toBe('sprout');
    expect(Object.values(TEMPLATE_PLANT)).not.toContain(first);
  });

  it('avoids every species already taken', () => {
    const taken: PlantId[] = ['ivy', 'sage', 'basil'];
    expect(taken).not.toContain(freshPlant(taken));
  });

  const cases: Array<readonly PlantId[]> = [
    [],
    ['sprout'],
    ['ivy', 'sage', 'basil'],
    Object.values(TEMPLATE_PLANT),
    PLANT_IDS.filter((plant) => plant !== 'sunflower'),
    [...PLANT_IDS],
    [...PLANT_IDS, ...PLANT_IDS.slice(0, 5)],
    ['fern', 'fern', 'fern'],
  ];
  it.each(cases.map((taken) => [taken.join(',') || '(none)', taken] as const))(
    'answers like the web for %s',
    (_label, taken) => {
      expect(freshPlant(taken)).toBe(web.freshPlant(taken));
    },
  );

  it('answers like the web for random rosters', () => {
    const next = rng(20261008);
    for (let round = 0; round < 500; round += 1) {
      const size = Math.floor(next() * 22);
      const taken = Array.from({ length: size }, () => PLANT_IDS[Math.floor(next() * PLANT_IDS.length)]!);
      expect(freshPlant(taken)).toBe(web.freshPlant(taken));
    }
  });
});

describe('botPlant', () => {
  const bots = [
    { id: 'b1', avatar: { plant: 'lotus' }, template_key: null },
    { id: 'b2', avatar: {}, template_key: 'researcher' },
    { id: 'b3', avatar: { color: 'teal' }, template_key: null },
    { id: 'b4', avatar: null, template_key: null },
    { id: 'b5', avatar: { plant: 'not-a-plant', color: 'amber' }, template_key: 'writer' },
    { id: 'sprouty', avatar: {}, template_key: 'sprouty' },
  ];
  it.each(bots.map((bot) => [bot.id, bot] as const))('resolves %s like the web', (_id, bot) => {
    expect(botPlant(bot)).toBe(web.botPlant(bot));
  });
});

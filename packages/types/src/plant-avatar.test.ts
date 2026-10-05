import { describe, expect, it } from 'vitest';
import {
  COLOR_FAMILY,
  DEFAULT_PLANT,
  IMPLICIT_POOL,
  PLANT_IDS,
  PLANT_LEGACY_COLOR,
  PLANT_STATES,
  STATE_ALIASES,
  TEMPLATE_PLANT,
  hashSeed,
  isPlantId,
  isPlantMood,
} from './plant-avatar';
import { SPROUTY_COLOR_IDS } from './profile-manifest';

describe('plant-avatar vocabulary', () => {
  it('has fifteen species with sprout reserved outside the implicit pool', () => {
    expect(PLANT_IDS).toHaveLength(15);
    expect(DEFAULT_PLANT).toBe('sprout');
    expect(IMPLICIT_POOL).toEqual(PLANT_IDS.filter((id) => id !== 'sprout'));
  });

  it('guards ids and moods without trusting the prototype chain', () => {
    expect(isPlantId('ivy')).toBe(true);
    for (const v of ['pothos', 'constructor', '__proto__', '', 3, null, undefined]) expect(isPlantId(v)).toBe(false);
    expect(isPlantMood('soft')).toBe(true);
    expect(isPlantMood('toString')).toBe(false);
  });

  it('aliases only onto real states', () => {
    for (const state of Object.values(STATE_ALIASES)) expect(PLANT_STATES).toContain(state);
  });

  it('maps every legacy colour, never to sprout, and reaches every other species', () => {
    expect(Object.keys(COLOR_FAMILY).sort()).toEqual([...SPROUTY_COLOR_IDS].sort());
    const reachable = Object.values(COLOR_FAMILY).flat();
    expect(reachable).not.toContain('sprout');
    expect(new Set(reachable)).toEqual(new Set(IMPLICIT_POOL));
    for (const plant of Object.values(TEMPLATE_PLANT)) expect(PLANT_IDS).toContain(plant);
  });

  it('dual-writes a legacy colour whose family contains the plant', () => {
    for (const plant of IMPLICIT_POOL) expect(COLOR_FAMILY[PLANT_LEGACY_COLOR[plant]]).toContain(plant);
    expect(PLANT_LEGACY_COLOR.sprout).toBe('forest');
  });

  it('hashes like the Bot team tool (31× rolling over code points, uint32)', () => {
    expect(hashSeed('')).toBe(0);
    expect(hashSeed()).toBe(0);
    expect(hashSeed('a')).toBe(97);
    expect(hashSeed('abc')).toBe(96354);
    expect(hashSeed('小青')).toBe((23567 * 31 + 38738) >>> 0);
    expect(hashSeed('bot_' + 'f'.repeat(40))).toBeLessThan(2 ** 32);
  });
});

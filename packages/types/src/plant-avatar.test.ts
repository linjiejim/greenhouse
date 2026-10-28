import { describe, expect, it } from 'vitest';
import {
  COLOR_FAMILY,
  DEFAULT_PLANT,
  IMPLICIT_POOL,
  PLANT_IDS,
  PLANT_STATES,
  STATE_ALIASES,
  TEMPLATE_PLANT,
  hashSeed,
  isPlantId,
  isPlantMood,
  plantForClient,
} from './plant-avatar';
import { SPROUTY_COLOR_IDS } from './profile-manifest';

describe('plant-avatar vocabulary', () => {
  it('has sixteen species; the implicit pool is frozen to the first fifteen, sprout reserved', () => {
    expect(PLANT_IDS).toHaveLength(16);
    expect(DEFAULT_PLANT).toBe('sprout');
    // a longer pool would move every legacy avatar's hash pick: later species stay out of it
    expect(IMPLICIT_POOL).toEqual(PLANT_IDS.slice(1, 15));
    expect(IMPLICIT_POOL).not.toContain('dandelion');
  });

  it('names the Agent templates after their plants', () => {
    expect(TEMPLATE_PLANT).toEqual({
      main: 'sprout',
      researcher: 'dandelion',
      operator: 'opuntia',
      writer: 'fern',
      analyst: 'clover',
      reporter: 'sunflower',
      notetaker: 'lavender',
      tracker: 'maple',
    });
    expect(PLANT_STATES).toContain('hello');
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

  it('hashes like the Bot team tool (31× rolling over code points, uint32)', () => {
    expect(hashSeed('')).toBe(0);
    expect(hashSeed()).toBe(0);
    expect(hashSeed('a')).toBe(97);
    expect(hashSeed('abc')).toBe(96354);
    expect(hashSeed('小青')).toBe((23567 * 31 + 38738) >>> 0);
    expect(hashSeed('bot_' + 'f'.repeat(40))).toBeLessThan(2 ** 32);
  });
});

describe('plantForClient', () => {
  it('maps the well-known clients by name, case-insensitively', () => {
    expect(plantForClient('Claude Code').plant).toBe('fern');
    expect(plantForClient('Claude Code (MCP)').plant).toBe('fern');
    expect(plantForClient('Codex CLI').plant).toBe('opuntia');
    expect(plantForClient('CURSOR').plant).toBe('clover');
    expect(plantForClient('Claude Code').tint).toBe('plant');
  });

  it('hashes other clients deterministically onto the remaining species', () => {
    const reserved = new Set(['sprout', 'fern', 'opuntia', 'clover']);
    for (const name of ['Windsurf', 'Zed', 'my-script', '', 'Claude Desktop']) {
      const a = plantForClient(name);
      expect(a).toEqual(plantForClient(name));
      expect(reserved.has(a.plant)).toBe(false);
      expect(PLANT_IDS).toContain(a.plant);
    }
    expect(plantForClient(null)).toEqual(plantForClient(''));
  });

  it('prefers the avatar stored on the connection', () => {
    expect(plantForClient('Codex', { plant: 'lotus', tint: 'sky' })).toEqual({ plant: 'lotus', tint: 'sky' });
    expect(plantForClient('Codex', { tint: 'rose' })).toEqual({ plant: 'opuntia', tint: 'rose' });
    expect(plantForClient('Codex', { plant: 'nope' }).plant).toBe('opuntia');
  });
});

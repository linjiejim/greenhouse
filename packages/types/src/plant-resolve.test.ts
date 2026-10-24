/**
 * Legacy avatar → plant (spec §9): total over any input, deterministic, follows the
 * documented resolution order, and never lands on the reserved sprout implicitly.
 */

import { describe, expect, it } from 'vitest';
import { COLOR_FAMILY, PLANT_IDS, PLANT_MOODS, TEMPLATE_PLANT, type PlantId } from './plant-avatar';
import { avatarTint, legacyToMood, legacyToPlant, resolvePlantAvatar, withTint } from './plant-avatar';

describe('legacyToPlant — documented cases (sheet 14)', () => {
  const cases: [
    avatar: unknown,
    templateKey: string | undefined,
    stableId: string | undefined,
    plant: PlantId,
    why: string,
  ][] = [
    [{ plant: 'monstera', color: 'forest' }, undefined, 'bot_7f', 'monstera', 'explicit plant wins'],
    [{ color: 'forest', accessories: ['clipboard'], faceStyle: 'happy' }, 'chief', 'bot_1', 'ivy', 'template key'],
    [
      { color: 'ocean', accessories: ['magnifier', 'round-glasses'] },
      undefined,
      'custom:42',
      'sage',
      'template fingerprint',
    ],
    [{ color: 'ocean' }, undefined, 'custom:43', 'echeveria', 'colour family (blue)'],
    [{ color: 'blossom', accessories: ['crown'] }, undefined, 'custom:44', 'lotus', 'colour family (pink)'],
    [{ color: 'sunset' }, undefined, 'custom:45', 'ginkgo', 'colour family (amber)'],
    [{ color: 'sunshine' }, undefined, 'custom:46', 'sunflower', 'colour family (yellow)'],
    [{ color: 'midnight' }, undefined, 'custom:47', 'eucalyptus', 'colour family (teal)'],
    [{ color: 'autumn' }, undefined, 'custom:48', 'maple', 'colour family (orange) — never red'],
    [{ color: 'lavender' }, undefined, 'custom:49', 'lavender', 'colour family (purple)'],
    [{ color: 'forest', accessories: ['pencil'] }, undefined, 'custom:50', 'fern', 'green family + accessory hint'],
    [{ color: 'forest', leafStyle: 'double' }, undefined, 'custom:51', 'clover', 'green family + leafStyle hint'],
    [{ color: 'forest' }, undefined, 'custom:52', 'basil', 'green family, stable-id hash'],
    [{ color: 'forest' }, undefined, 'custom:53', 'ivy', 'green family, stable-id hash'],
    [{ palette: { body: '#d65ea4', leaf: '#bf4b8a' } }, undefined, 'custom:54', 'lotus', 'free palette → hue family'],
    [{ color: 'mint' }, undefined, 'custom:55', 'fern', 'unknown colour (seed data) → id hash'],
    [{}, undefined, 'custom:56', 'clover', 'empty {} (every fork) → id hash, never sprout'],
    [null, undefined, undefined, 'sprout', 'garbage / no id → sprout'],
    [{}, undefined, 'sprouty', 'sprout', 'built-in Sprouty'],
  ];
  it.each(cases)('%j / %s / %s → %s (%s)', (avatar, templateKey, stableId, plant) => {
    expect(legacyToPlant(avatar, templateKey, stableId)).toBe(plant);
  });
});

describe('legacyToPlant — resolution order', () => {
  it('1. a known `plant` beats everything; an unknown one is ignored', () => {
    expect(legacyToPlant({ plant: 'sunflower', color: 'ocean', accessories: ['clipboard'] }, 'chief', 'bot_1')).toBe(
      'sunflower',
    );
    expect(legacyToPlant({ plant: 'pothos', color: 'autumn' }, undefined, 'bot_1')).toBe('maple');
  });

  it('2. the template key beats fingerprints and colours', () => {
    for (const [key, plant] of Object.entries(TEMPLATE_PLANT)) {
      expect(legacyToPlant({ color: 'sunshine' }, key, 'bot_1')).toBe(plant);
    }
  });

  it('3. exact template fingerprints map copied template avatars back to their species', () => {
    expect(legacyToPlant({ color: 'forest', accessories: ['clipboard'] }, null, 'bot_x')).toBe('ivy');
    expect(legacyToPlant({ color: 'ocean', accessories: ['magnifier'] }, null, 'bot_x')).toBe('sage');
    expect(legacyToPlant({ color: 'sunset', accessories: ['wrench', 'headset'] }, null, 'bot_x')).toBe('basil');
    expect(legacyToPlant({ color: 'blossom', accessories: ['pencil'] }, null, 'bot_x')).toBe('fern');
    expect(legacyToPlant({ color: 'lavender', accessories: ['chart'] }, null, 'bot_x')).toBe('clover');
  });

  it('4. single-colour families are injective; accessory hints only act inside the family', () => {
    const singles = Object.values(COLOR_FAMILY)
      .filter((f) => f.length === 1)
      .map((f) => f[0]);
    expect(new Set(singles).size).toBe(singles.length);
    // coffee hints basil, but ocean's family is echeveria only — the colour the member saw wins
    expect(legacyToPlant({ color: 'ocean', accessories: ['coffee'] }, null, 'bot_x')).toBe('echeveria');
    expect(legacyToPlant({ color: 'forest', accessories: ['crown', 'headset'] }, null, 'bot_x')).toBe('basil');
    expect(legacyToPlant({ color: 'forest', leafStyle: 'big' }, null, 'bot_x')).toBe('monstera');
    expect(legacyToPlant({ color: 'forest', leafStyle: 'mini' }, null, 'bot_x')).toBe('fern');
    expect(legacyToPlant({ color: 'forest' }, null, undefined)).toBe('basil'); // no id → family head
  });

  it('5. free palette hexes pick the nearest colour family by hue (leaf before body)', () => {
    expect(legacyToPlant({ palette: { body: '#ff8800', leaf: '#3366ff' } }, null, 'bot_x')).toBe('echeveria');
    expect(legacyToPlant({ palette: { body: '#e8721f', leaf: 'nope' } }, null, 'bot_x')).toBe('maple');
    expect(legacyToPlant({ palette: { body: '#777777', leaf: '#777777' } }, null, 'bot_x')).not.toBe('sprout');
  });

  it('6. unknown colours and empty avatars spread over IMPLICIT_POOL by stable id', () => {
    const picks = new Set(Array.from({ length: 80 }, (_, i) => legacyToPlant({}, null, `custom:${i}`)));
    expect(picks.size).toBeGreaterThan(8);
    expect(picks.has('sprout')).toBe(false);
  });

  it('7. sprout only for the built-in Sprouty or when there is nothing to go on', () => {
    expect(legacyToPlant({}, null, 'sprouty')).toBe('sprout');
    expect(legacyToPlant(undefined)).toBe('sprout');
    expect(legacyToPlant({ color: 'mint' }, null, '')).toBe('sprout');
  });
});

describe('legacyToPlant — totality', () => {
  /** Seeded PRNG so the fuzz corpus is the same on every run. */
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 2 ** 32;
    };
  }
  const STRINGS = [
    'forest',
    'ocean',
    'mint',
    'constructor',
    '__proto__',
    'toString',
    'hasOwnProperty',
    'sprout',
    'ivy',
    '',
    '#00ff00',
    '#zzzzzz',
    'big',
    'chart',
    'happy',
  ];
  function junk(r: () => number, depth = 0): unknown {
    const k = Math.floor(r() * 9);
    if (depth > 2 && k > 5) return null;
    switch (k) {
      case 0:
        return undefined;
      case 1:
        return null;
      case 2:
        return Math.floor(r() * 1000) - 500;
      case 3:
        return STRINGS[Math.floor(r() * STRINGS.length)];
      case 4:
        return r() > 0.5;
      case 5:
        return Array.from({ length: Math.floor(r() * 3) }, () => junk(r, depth + 1));
      default: {
        const keys = [
          'plant',
          'color',
          'accessories',
          'leafStyle',
          'faceStyle',
          'eyeStyle',
          'mood',
          'palette',
          'body',
          'leaf',
        ];
        return Object.fromEntries(keys.filter(() => r() > 0.5).map((key) => [key, junk(r, depth + 1)]));
      }
    }
  }

  it('returns a valid id and mood for 5,000 fuzzed inputs, deterministically', () => {
    const r = rng(42);
    for (let i = 0; i < 5000; i++) {
      const avatar = junk(r);
      const templateKey = junk(r) as string;
      const stableId = junk(r) as string;
      const plant = legacyToPlant(avatar, templateKey, stableId);
      expect(PLANT_IDS, JSON.stringify([avatar, templateKey, stableId])).toContain(plant);
      expect(legacyToPlant(avatar, templateKey, stableId)).toBe(plant);
      expect(PLANT_MOODS).toContain(legacyToMood(avatar));
      const explicitSprout = (avatar as { plant?: unknown } | null)?.plant === 'sprout';
      if (typeof stableId === 'string' && stableId && stableId !== 'sprouty' && !explicitSprout) {
        expect(plant, JSON.stringify([avatar, templateKey, stableId])).not.toBe('sprout');
      }
    }
  });

  it('treats prototype-named values as unknown instead of leaking Object.prototype members', () => {
    expect(legacyToPlant({ plant: 'constructor' }, 'constructor', 'bot_1')).toBe(legacyToPlant({}, null, 'bot_1'));
    expect(legacyToPlant({ color: 'toString' }, null, 'bot_1')).toBe(legacyToPlant({}, null, 'bot_1'));
    expect(
      legacyToPlant({ color: 'forest', leafStyle: 'constructor', accessories: ['__proto__'] }, null, 'bot_1'),
    ).toBe(legacyToPlant({ color: 'forest' }, null, 'bot_1'));
    expect(legacyToMood({ faceStyle: 'constructor', eyeStyle: 'toString' })).toBe('calm');
  });
});

describe('legacyToMood', () => {
  it.each([
    [{ mood: 'drowsy', faceStyle: 'happy' }, 'drowsy'],
    [{ mood: 'grumpy', faceStyle: 'happy' }, 'soft'],
    [{ faceStyle: 'default' }, 'calm'],
    [{ faceStyle: 'happy' }, 'soft'],
    [{ faceStyle: 'sparkle' }, 'bright'],
    [{ faceStyle: 'sleepy' }, 'drowsy'],
    [{ eyeStyle: 'classic' }, 'calm'],
    [{ eyeStyle: 'dot' }, 'calm'],
    [{ eyeStyle: 'soft' }, 'bright'],
    [{ eyeStyle: 'focused' }, 'drowsy'],
    [{ faceStyle: 'sparkle', eyeStyle: 'focused' }, 'bright'],
    [{}, 'calm'],
    [null, 'calm'],
  ])('%j → %s', (avatar, mood) => {
    expect(legacyToMood(avatar)).toBe(mood);
  });
});

describe('resolvePlantAvatar', () => {
  it('bundles plant, tint and the stable id as the loop seed — never a stored mood', () => {
    expect(resolvePlantAvatar({ color: 'autumn', faceStyle: 'sleepy' }, { stableId: 'bot_1' })).toEqual({
      plant: 'maple',
      tint: 'plant',
      seed: 'bot_1',
    });
    expect(resolvePlantAvatar(undefined, { stableId: 'sprouty' })).toEqual({
      plant: 'sprout',
      tint: 'plant',
      seed: 'sprouty',
    });
    expect(resolvePlantAvatar({ plant: 'ivy', tint: 'rose' }).tint).toBe('rose');
    expect(resolvePlantAvatar({ plant: 'ivy', tint: 'neon' }).tint).toBe('plant'); // unknown → the species' own
    expect(resolvePlantAvatar({}, { templateKey: 'analyst' }).plant).toBe('clover');
  });
});

describe('withTint', () => {
  it('stores a colour and drops the key for the species disc, keeping every other key', () => {
    const base = { plant: 'ivy', color: 'forest', faceStyle: 'happy' };
    expect(withTint(base, 'sky')).toEqual({ ...base, tint: 'sky' });
    expect(withTint({ ...base, tint: 'sky' }, 'plant')).toEqual(base);
    expect(avatarTint(withTint(base, 'gold'))).toBe('gold');
  });
});

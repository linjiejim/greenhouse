/**
 * Drift guard for the vendored plant-avatar builder and the stored-avatar resolver (apps/mobile
 * cannot import workspace packages, so it carries a static copy; ./plant-ids.ts is a verbatim
 * copy of packages/types/src/plant-avatar.ts, guarded line by line in
 * src/bots/vendor/vendor.parity.test.ts — this file checks it answers the same). Runs in the ROOT vitest unit project — the mobile
 * tsconfig excludes *.test.ts because the canonical modules resolve `@greenhouse/types`,
 * which only exists inside the pnpm workspace.
 *
 * The vendored static builder must paint exactly what the core paints with `animate:false`
 * and an explicit theme, for every option the mobile copy keeps.
 */

import { describe, expect, it } from 'vitest';
import {
  PLANT_IDS as CORE_PLANT_IDS,
  PLANT_MOODS as CORE_PLANT_MOODS,
  PLANT_STATES as CORE_PLANT_STATES,
  STATE_ALIASES as CORE_STATE_ALIASES,
} from '@greenhouse/types';
import * as coreIds from '@greenhouse/types/plant-avatar';
import {
  SPROUTY_ACCESSORY_IDS,
  SPROUTY_COLOR_IDS,
  SPROUTY_FACE_STYLE_IDS,
  SPROUTY_LEAF_STYLE_IDS,
} from '@greenhouse/types/profile-manifest';
import * as core from '../../../../../packages/ui/src/components/plant-avatar/plant-avatar-svg';
import { PLANT_PRESETS as CORE_PRESETS } from '../../../../../packages/ui/src/components/plant-avatar/plant-catalogue';
import { PLANT_FIT as CORE_FIT } from '../../../../../packages/ui/src/components/plant-avatar/plant-fit.generated';
import * as vendored from './plant-avatar-svg';
import { PLANT_PRESETS } from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
import * as ids from './plant-ids';
import {
  DEFAULT_PLANT,
  PLANT_IDS,
  PLANT_MOODS,
  PLANT_STATES,
  STATE_ALIASES,
  isPlantId,
  type PlantStateInput,
} from './plant-ids';

/** Canonical states, product aliases, and the unknown / missing values that must idle. */
const STATES = [...PLANT_STATES, ...Object.keys(STATE_ALIASES), 'bogus', undefined] as (PlantStateInput | undefined)[];
/** Glyph / avatar / portrait boundaries, the mobile call sites (40/44/84) and the widget export sizes. */
const SIZES = [16, 20, 21, 24, 32, 40, 44, 45, 48, 84, 120, 1024];
const THEMES = ['light', 'dark'] as const;

describe('vendored plant-avatar ids', () => {
  it('match the canonical vocabulary', () => {
    expect(PLANT_IDS).toEqual(CORE_PLANT_IDS);
    expect(PLANT_STATES).toEqual(CORE_PLANT_STATES);
    expect(STATE_ALIASES).toEqual(CORE_STATE_ALIASES);
    expect(PLANT_MOODS).toEqual(CORE_PLANT_MOODS);
    expect(DEFAULT_PLANT).toBe('sprout');
    expect(isPlantId('sprout')).toBe(true);
    expect(isPlantId('constructor')).toBe(false);
  });
});

describe('vendored plant-avatar catalogue', () => {
  it('carries the same geometry, palettes and optical fit', () => {
    expect(PLANT_PRESETS).toEqual(CORE_PRESETS);
    expect(PLANT_FIT).toEqual(CORE_FIT);
    expect(vendored.FIT_TARGET).toEqual(core.FIT_TARGET);
    expect(vendored.EYE).toEqual(core.EYE);
  });
});

describe('vendored static builder', () => {
  it('is byte-identical to the core static output for every preset × state × size × theme', () => {
    let checked = 0;
    for (const plant of PLANT_IDS) {
      for (const state of STATES) {
        for (const size of SIZES) {
          for (const theme of THEMES) {
            const opts = { plant, state, size, theme } as const;
            expect(vendored.buildPlantAvatarSvg(opts), `${plant}/${state}/${size}/${theme}`).toBe(
              core.buildPlantAvatarSvg({ ...opts, animate: false }),
            );
            checked++;
          }
        }
      }
    }
    expect(checked).toBe(PLANT_IDS.length * STATES.length * SIZES.length * THEMES.length);
  });

  it('matches for moods, no disc, forced LODs, defaults and unknown plants', () => {
    for (const plant of [...PLANT_IDS, 'pothos', undefined]) {
      for (const theme of THEMES) {
        for (const mood of PLANT_MOODS) {
          const o = { plant, theme, mood, size: 84 };
          expect(vendored.buildPlantAvatarSvg(o)).toBe(core.buildPlantAvatarSvg({ ...o, animate: false }));
        }
        for (const lod of ['glyph', 'avatar', 'portrait'] as const) {
          const o = { plant, theme, lod, size: 24, state: 'sleep' as const };
          expect(vendored.buildPlantAvatarSvg(o)).toBe(core.buildPlantAvatarSvg({ ...o, animate: false }));
        }
        const bare = { plant, theme, disc: false, size: 48, state: 'error' as const };
        expect(vendored.buildPlantAvatarSvg(bare)).toBe(core.buildPlantAvatarSvg({ ...bare, animate: false }));
      }
    }
    expect(vendored.buildPlantAvatarSvg()).toBe(core.buildPlantAvatarSvg({ animate: false }));
  });

  it('produces the same knockout layers for the lock-screen widget', () => {
    for (const plant of PLANT_IDS) {
      for (const size of [22, 32, 64]) {
        for (const state of ['idle', 'sleep'] as const) {
          expect(vendored.buildPlantMonoLayers({ plant, size, state })).toEqual(
            core.buildPlantMonoLayers({ plant, size, state }),
          );
        }
      }
    }
  });

  it('shares the pose, palette, LOD and eye-gap helpers', () => {
    for (const state of STATES) expect(vendored.poseFor(state)).toEqual(core.poseFor(state));
    for (const size of SIZES) {
      expect(vendored.lodFor(size)).toBe(core.lodFor(size));
      expect(vendored.rimUnits(size)).toBe(core.rimUnits(size));
    }
    for (const plant of PLANT_IDS) {
      for (const state of PLANT_STATES)
        expect(vendored.plantPalette(plant, state)).toEqual(core.plantPalette(plant, state));
      for (const lod of ['glyph', 'avatar', 'portrait'] as const) {
        expect(vendored.eyeHalfGap(plant, lod)).toBe(core.eyeHalfGap(plant, lod));
      }
    }
  });
});

/**
 * Stored avatars every surface may meet: none, every template's seed, every legacy colour
 * (with and without the role accessory / leaf hint), free palette hexes (incl. a grey), the
 * old editor's eyeStyle, unknown keys, junk, and explicit plants / moods.
 */
const AVATARS: unknown[] = [
  undefined,
  null,
  {},
  [],
  'forest',
  42,
  ...coreIds.PLANT_IDS.map((plant) => ({ plant })),
  { plant: 'pothos' },
  ...SPROUTY_COLOR_IDS.map((color) => ({ color })),
  ...SPROUTY_COLOR_IDS.flatMap((color) =>
    SPROUTY_ACCESSORY_IDS.map((accessory) => ({ color, accessories: [accessory] })),
  ),
  ...SPROUTY_COLOR_IDS.flatMap((color) => SPROUTY_LEAF_STYLE_IDS.map((leafStyle) => ({ color, leafStyle }))),
  ...SPROUTY_FACE_STYLE_IDS.map((faceStyle) => ({ faceStyle })),
  ...['classic', 'dot', 'soft', 'focused', 'nope'].map((eyeStyle) => ({ eyeStyle })),
  ...coreIds.PLANT_MOODS.map((mood) => ({ mood, faceStyle: 'sleepy' })),
  { palette: { body: '#ff8800', leaf: '#22aa44' } },
  { palette: { body: '#3355ff', leaf: 'not-a-hex' } },
  { palette: { body: '#777777', leaf: '#888888' } },
  { color: 'neon', accessories: ['crown', 7] },
];
const TEMPLATE_KEYS = [undefined, null, '', 'sprouty', 'chief', 'researcher', 'operator', 'writer', 'analyst', 'nope'];
const STABLE_IDS = [undefined, null, '', 'sprouty', 'bot_1', 'bot_7f3a', '小卷', 'a-very-long-stable-id-0123456789'];

describe('vendored plant-avatar resolver', () => {
  it('carries the same tables', () => {
    expect(ids.TEMPLATE_PLANT).toEqual(coreIds.TEMPLATE_PLANT);
    expect(ids.COLOR_FAMILY).toEqual(coreIds.COLOR_FAMILY);
    expect(ids.PLANT_LEGACY_COLOR).toEqual(coreIds.PLANT_LEGACY_COLOR);
    expect(ids.IMPLICIT_POOL).toEqual(coreIds.IMPLICIT_POOL);
    expect(ids.MOOD_FACE_STYLE).toEqual(coreIds.MOOD_FACE_STYLE);
  });

  it('resolves every stored avatar × template × stable id like the canonical resolver', () => {
    let checked = 0;
    for (const avatar of AVATARS) {
      expect(ids.legacyToMood(avatar)).toBe(coreIds.legacyToMood(avatar));
      for (const templateKey of TEMPLATE_KEYS) {
        for (const stableId of STABLE_IDS) {
          expect(
            ids.legacyToPlant(avatar, templateKey, stableId),
            JSON.stringify([avatar, templateKey, stableId]),
          ).toBe(coreIds.legacyToPlant(avatar, templateKey, stableId));
          const options = { templateKey, stableId: stableId ?? undefined };
          expect(ids.resolvePlantAvatar(avatar, options)).toEqual(coreIds.resolvePlantAvatar(avatar, options));
          checked++;
        }
      }
    }
    expect(checked).toBe(AVATARS.length * TEMPLATE_KEYS.length * STABLE_IDS.length);
  });

  it('writes avatars the same way (withPlant / withMood / plantAvatarConfig)', () => {
    const bases = [{}, { color: 'ocean', faceStyle: 'happy' }, { plant: 'ivy', mood: 'soft', accessories: ['cap'] }];
    for (const base of bases) {
      for (const plant of coreIds.PLANT_IDS) expect(ids.withPlant(base, plant)).toEqual(coreIds.withPlant(base, plant));
      for (const mood of coreIds.PLANT_MOODS) expect(ids.withMood(base, mood)).toEqual(coreIds.withMood(base, mood));
    }
    for (const plant of coreIds.PLANT_IDS) {
      expect(ids.plantAvatarConfig(plant)).toEqual(coreIds.plantAvatarConfig(plant));
      for (const mood of coreIds.PLANT_MOODS) {
        expect(ids.plantAvatarConfig(plant, mood)).toEqual(coreIds.plantAvatarConfig(plant, mood));
      }
    }
  });

  it('hashes and recognises ids the same way', () => {
    for (const seed of [...STABLE_IDS, 0, 12345, '🌱sprout', 'Ω≈ç√'])
      expect(ids.hashSeed(seed)).toBe(coreIds.hashSeed(seed));
    for (const value of [...coreIds.PLANT_MOODS, 'calm ', 'nope', null, 3]) {
      expect(ids.isPlantMood(value)).toBe(coreIds.isPlantMood(value));
    }
  });
});

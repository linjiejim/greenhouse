/**
 * Drift guard for the vendored plant-avatar builder (apps/mobile cannot import workspace
 * packages, so it carries a static copy). Runs in the ROOT vitest unit project — the mobile
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
import * as core from '../../../../../packages/ui/src/components/plant-avatar/plant-avatar-svg';
import { PLANT_PRESETS as CORE_PRESETS } from '../../../../../packages/ui/src/components/plant-avatar/plant-catalogue';
import { PLANT_FIT as CORE_FIT } from '../../../../../packages/ui/src/components/plant-avatar/plant-fit.generated';
import * as vendored from './plant-avatar-svg';
import { PLANT_PRESETS } from './plant-catalogue';
import { PLANT_FIT } from './plant-fit.generated';
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

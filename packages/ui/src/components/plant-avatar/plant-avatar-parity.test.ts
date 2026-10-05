/**
 * Golden output. The TypeScript builder is the source of truth (the prototype's reference
 * builder.js under docs/specs is history, no longer compared). These digests pin every
 * preset × state × size × theme × animate × option and the stylesheet, so any change to
 * geometry, palettes, poses, eyes, markup or CSS fails here. After an INTENDED visual change:
 * review the gallery (`node --import tsx scripts/plant-avatar-gallery.mjs`), then re-run this
 * file with `-u` and say below what changed.
 *
 * Regenerated 2026-10 after the review fixes (all intentional):
 *   - basil's light body/shade and dark body/shade were lifted so ink holds 4.5:1 on the
 *     shade half in error and sleep (basil digest);
 *   - theme 'auto' root vars carry only the dark tones that differ from light (no `--pa-l-*`;
 *     each paint's fallback is the light hex) and static output drops the motion vars (every
 *     preset digest);
 *   - the stylesheet: the seeded phase drives only the infinite loops (thinking / speaking),
 *     capped loops start ≤ 1s in, the blink is capped outside thinking / speaking (waiting
 *     too), and a morph no longer stops the thinking bob (stylesheet digest).
 *
 * Earlier deliberate deviations from the prototype (each has its own regression test):
 *   - theme 'auto' writes the rim underlay's fill + stroke into ONE style attribute (two
 *     `style` attributes are invalid XML and lose the keyline in HTML);
 *   - prototype-named ids ('constructor', '__proto__', …) resolve like unknown ids.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PLANT_IDS, PLANT_STATES, type PlantId } from '@greenhouse/types';
import {
  PLANT_AVATAR_CSS,
  buildPlantAvatarSvg,
  buildPlantMonoLayers,
  type PlantAvatarSvgOptions,
} from './plant-avatar-svg';

const EXTRAS: PlantAvatarSvgOptions[] = [
  {},
  { mood: 'soft' },
  { mood: 'bright', seed: 'bot_ab' },
  { mood: 'drowsy' },
  { intro: true, label: 'Ivy · <x> & "y"' },
  { disc: false },
  { lod: 'glyph' },
  { idleCycles: 0, phase: 2 },
];

function* options(plant: PlantId): Generator<PlantAvatarSvgOptions> {
  for (const state of [...PLANT_STATES, 'responding', 'needs_you'] as const)
    for (const size of [16, 24, 32, 48, 120])
      for (const theme of ['light', 'dark', 'auto'] as const)
        for (const animate of [false, true])
          for (const extra of EXTRAS) yield { plant, state, size, theme, animate, ...extra };
}

const digestOf = (plant: PlantId) => {
  const h = createHash('sha256');
  for (const o of options(plant)) h.update(buildPlantAvatarSvg(o)).update('\n');
  const mono = buildPlantMonoLayers({ plant, size: 44 });
  h.update(mono.silhouette).update(mono.eyes);
  return h.digest('hex').slice(0, 16);
};

describe('golden output', () => {
  it('matches the reviewed digests for every preset', () => {
    expect(Object.fromEntries(PLANT_IDS.map((plant) => [plant, digestOf(plant)]))).toMatchInlineSnapshot(`
      {
        "basil": "e97dfe8fca856288",
        "clover": "e1754b6849c777fd",
        "echeveria": "f81cab59f067e45f",
        "eucalyptus": "1b28fccfe8ffddc7",
        "fern": "a3e5339417a5a77b",
        "ginkgo": "6345d18a0d5ff236",
        "ivy": "f6f435e7858e8cf6",
        "lavender": "432668ca417c582e",
        "lotus": "2cfc78025fbd9dcc",
        "maple": "160c467b2ced2c99",
        "monstera": "1d66e3f643163c89",
        "opuntia": "88fb72696d875210",
        "sage": "cfbec84f27250740",
        "sprout": "7b4727caab6bb30f",
        "sunflower": "3a495596a45e84ea",
      }
    `);
  });

  it('matches the reviewed stylesheet', () => {
    expect(createHash('sha256').update(PLANT_AVATAR_CSS).digest('hex').slice(0, 16)).toMatchInlineSnapshot(
      `"358aefb8a5163e14"`,
    );
  });
});

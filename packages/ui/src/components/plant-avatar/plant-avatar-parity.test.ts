/**
 * Golden output. The TypeScript builder is the source of truth (the prototype's reference
 * builder.js under docs/specs is history, no longer compared). These digests pin every
 * preset × state × size × theme × animate × option and the stylesheet, so any change to
 * geometry, palettes, poses, eyes, markup or CSS fails here. After an INTENDED visual change:
 * review the gallery (`node --import tsx scripts/plant-avatar-gallery.mjs`), then re-run this
 * file with `-u` and say below what changed.
 *
 * Regenerated 2026-10-07 for the flat geometric redesign (all intentional, reviewed on the gallery
 * sheet): every preset redrawn from circles, arcs and straight lines; the dandelion added; the
 * opuntia redrawn as the cactus; smaller eyes, a mouth from the avatar LOD up, brows and a state
 * mark on portraits; the `hello` state; no keyline unless `rim: true`; the stylesheet gained the
 * hello / talking / mark keyframes.
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
        "basil": "b35c21733ceda515",
        "clover": "f5cd2a757d3d679f",
        "dandelion": "46220ae9c083d416",
        "echeveria": "6a56f3274642c91c",
        "eucalyptus": "9f3e39b17f8d3a94",
        "fern": "072154cf69a77007",
        "ginkgo": "72e254ae3b26e234",
        "ivy": "dc6de4f866db883f",
        "lavender": "baf9f8c7914dcc57",
        "lotus": "8eac5a6ec0b6842a",
        "maple": "359a67fc0d1b54f9",
        "monstera": "54ef2ca790601066",
        "opuntia": "b6c047baada5010f",
        "sage": "03c1bf5686958363",
        "sprout": "a0cced3e7f9d153e",
        "sunflower": "5be8a3ebbc383445",
      }
    `);
  });

  it('matches the reviewed stylesheet', () => {
    expect(createHash('sha256').update(PLANT_AVATAR_CSS).digest('hex').slice(0, 16)).toMatchInlineSnapshot(
      `"8fc3fe9ae481e5a4"`,
    );
  });
});

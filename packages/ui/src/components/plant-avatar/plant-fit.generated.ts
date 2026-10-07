/**
 * Optical fit per species × LOD: [maxR, dx, dy] — GENERATED, do not edit by hand.
 *
 * Measured in Chromium from the unrimmed, unfitted geometry (strokes included):
 * (dx, dy) recentres the silhouette's bounding box on the disc and maxR is its
 * farthest point after recentring. At render time
 * scale = (FIT_TARGET[lod] − rim) / maxR, so the rimmed silhouette always lands on
 * the same radius whatever the render size.
 *
 * Regenerate after editing any silhouette in plant-catalogue.ts:
 *   node --import tsx scripts/plant-avatar-gallery.mjs --fit
 */

import type { PlantId } from '@greenhouse/types';
import type { PlantLod } from './plant-catalogue';

export type PlantFitEntry = readonly [maxR: number, dx: number, dy: number];

// FIT:BEGIN
export const PLANT_FIT: Readonly<Record<PlantId, Readonly<Record<PlantLod, PlantFitEntry>>>> = {
  sprout: { glyph: [41.75, 0, 0.8], avatar: [41.75, 0, 0.8], portrait: [41.75, 0, 0.8] },
  ivy: { glyph: [34.68, 0, -8], avatar: [43.02, 0, 2.7], portrait: [43.02, 0, 2.7] },
  sage: { glyph: [44.97, 0, -3.3], avatar: [44.79, 0, -3.1], portrait: [44.79, 0, -3.1] },
  basil: { glyph: [45.45, 0, -3.5], avatar: [45.25, 0, -3.3], portrait: [45.25, 0, -3.3] },
  fern: { glyph: [40.24, -2.5, -5.9], avatar: [39.69, -2.5, -6], portrait: [39.69, -2.5, -6] },
  clover: { glyph: [40.8, 0, -4.4], avatar: [40.55, 0, -4.2], portrait: [40.55, 0, -4.2] },
  monstera: { glyph: [41.13, 0, -7.1], avatar: [40.93, 0, -6.9], portrait: [40.93, 0, -6.9] },
  ginkgo: { glyph: [42.12, 0, -12.9], avatar: [42.09, 0, -12.7], portrait: [42.09, 0, -12.7] },
  maple: { glyph: [45.17, 0, -1.8], avatar: [45.04, 0, -1.6], portrait: [45.04, 0, -1.6] },
  echeveria: { glyph: [46.98, 0, 0], avatar: [46.98, 0, 0], portrait: [46.98, 0, 0] },
  opuntia: { glyph: [40.25, 0, -0.7], avatar: [41.57, 0, 0.6], portrait: [41.57, 0, 0.6] },
  lotus: { glyph: [48.79, 0.1, -3], avatar: [48.76, 0, -3], portrait: [48.76, 0, -3] },
  eucalyptus: { glyph: [42.45, 0, -1.5], avatar: [42.58, 0, -1.5], portrait: [42.58, 0, -1.5] },
  lavender: { glyph: [45.8, 0, 0.2], avatar: [45.62, 0, 0.4], portrait: [45.62, 0, 0.4] },
  sunflower: { glyph: [46.5, 0, 0], avatar: [47.11, 0.2, 0.1], portrait: [47.11, 0.2, 0.1] },
  dandelion: { glyph: [47.02, 0, 0.6], avatar: [46.62, 0, 0.6], portrait: [46.62, 0, 0.6] },
};
// FIT:END

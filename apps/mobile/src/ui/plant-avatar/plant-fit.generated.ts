// VENDORED from packages/ui/src/components/plant-avatar/plant-fit.generated.ts — do not edit here.
// Re-copy it verbatim after `scripts/plant-avatar-gallery.mjs --fit` rewrites the canonical table
// (only the PlantId import below differs) and run the parity test (see apps/mobile/AGENTS.md).

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

import type { PlantId } from './plant-ids';
import type { PlantLod } from './plant-catalogue';

export type PlantFitEntry = readonly [maxR: number, dx: number, dy: number];

// FIT:BEGIN
export const PLANT_FIT: Readonly<Record<PlantId, Readonly<Record<PlantLod, PlantFitEntry>>>> = {
  sprout: { glyph: [52.6, 0, -3.3], avatar: [52.4, 0, -3], portrait: [52.4, 0, -3] },
  ivy: { glyph: [42.42, 0, -1], avatar: [42.36, 0, -0.8], portrait: [42.36, 0, -0.8] },
  sage: { glyph: [46.11, 2, -1.4], avatar: [45.9, 2, -1.2], portrait: [45.9, 2, -1.2] },
  basil: { glyph: [44.45, 0, -1.5], avatar: [44.25, 0, -1.3], portrait: [44.25, 0, -1.3] },
  fern: { glyph: [47.33, 5, -1.8], avatar: [46.39, 5, -2.5], portrait: [46.39, 5, -2.5] },
  clover: { glyph: [40.46, 0, -2.8], avatar: [40.25, 0, -2.6], portrait: [40.25, 0, -2.6] },
  monstera: { glyph: [42.67, 0, -1], avatar: [42.22, 0, -0.8], portrait: [42.22, 0, -0.8] },
  ginkgo: { glyph: [47.03, 0, 0.7], avatar: [47.08, -0.2, 0.9], portrait: [48.92, -0.2, -2.5] },
  maple: { glyph: [45.28, 0, -0.3], avatar: [46.83, 0, 0.4], portrait: [46.83, 0, 0.4] },
  echeveria: { glyph: [42.52, 0.2, 1.9], avatar: [42.52, 0.2, 1.9], portrait: [42.52, 0.1, 1.9] },
  opuntia: { glyph: [46.54, -4.4, 1.7], avatar: [46.5, -4.4, 2], portrait: [46.5, -4.4, 2] },
  lotus: { glyph: [44.7, 0, 0.5], avatar: [44.7, 0, 0.5], portrait: [44.7, 0, 0.5] },
  eucalyptus: { glyph: [43.45, 0, -0.5], avatar: [43.2, 0, -0.5], portrait: [43.2, 0, -0.5] },
  lavender: { glyph: [46.05, 0, 0.4], avatar: [46.37, 0, 1.1], portrait: [46.37, 0, 1.1] },
  sunflower: { glyph: [46.5, 0, 0], avatar: [47, 0, 0], portrait: [43.09, -0.2, -0.2] },
};
// FIT:END

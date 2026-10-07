// VENDORED from packages/ui/src/components/plant-avatar/plant-catalogue.ts — do not edit here.
// Edit the canonical file, re-copy it verbatim (only the PlantId import below differs) and run
// the parity test: npx vitest run --project unit apps/mobile/src/ui/plant-avatar (see apps/mobile/AGENTS.md).

/**
 * Plant-avatar catalogue — geometry + baked palettes for the sixteen species.
 *
 * Flat, geometric plants (2026-10 redesign, design/bot-characters): every silhouette is
 * circles, circular arcs and straight lines, painted flat — no gradients, no highlights. The
 * face-bearing body is the biggest shape; stems are short and thick.
 *
 * Geometry lives on a 100×100 viewBox (disc = circle r50). Each preset has:
 *   pivot   where the plant grows from; state poses rotate / scale about it
 *   face    eye anchor (x, y), centre half-gap, optional face scale, squeeze (eyes that
 *           move together when paired parts fold) and the tone the face sits on; the
 *           mouth and brows hang off the same anchor
 *   parts   paired organs (leaves, arms, petals) that fold about their own base (l / r):
 *           `fold` is the rotation at full fold (a droop / close); negative amounts raise
 *   layers  silhouette + detail layers, each tagged with the LODs it shows at
 *           (g = glyph ≤ 20px, a = avatar 21–44px, p = portrait ≥ 45px)
 *   palette BAKED light + dark tones (reviewed literals, no runtime lifting; the
 *           contrast floors are unit tests — plant-avatar-palette.test.ts)
 *
 * Opaque layers (no `op`) form the silhouette: they get the rim underlay and the mono
 * silhouette. `rim: false` marks interior layers whose outline is hidden anyway.
 * Plant hexes live ONLY here — never in theme tokens or app code.
 * After editing any silhouette, re-measure the optical fit:
 *   node --import tsx scripts/plant-avatar-gallery.mjs --fit
 */

import type { PlantId } from './plant-ids';
import {
  capsule,
  circ,
  dotRing,
  dots,
  ell,
  fibSeeds,
  heart,
  lens,
  lensRing,
  notched,
  poly,
  pts,
  scallop,
  spiral,
  spokes,
} from './plant-geometry';

/** Paint tones a palette defines. Layers reference tones, never hexes. Order is part of the output. */
export const PLANT_TONES = Object.freeze([
  'disc',
  'body',
  'shade',
  'light',
  'accent',
  'accent2',
  'stem',
  'ink',
  'catch',
  'rim',
  'mark',
] as const);
export type PlantTone = (typeof PLANT_TONES)[number];
export type PlantPalette = Readonly<Record<PlantTone, string>>;

/** Level of detail: adds detail, never changes the silhouette. */
export type PlantLod = 'glyph' | 'avatar' | 'portrait';
export const PLANT_LOD_CODES = Object.freeze({ glyph: 'g', avatar: 'a', portrait: 'p' } as const);

export interface PlantLayer {
  d: string;
  tone: PlantTone;
  /** LOD codes the layer shows at ('gap' = every LOD). */
  lods: string;
  /** Stroke width (fill none, round caps). */
  stroke?: number;
  /** Paired part the layer folds with. */
  part?: 'l' | 'r';
  /** Detail opacity (detail layers are not part of the silhouette). */
  op?: number;
  /** Never outlined (interior layers). */
  rim?: false;
}

export interface PlantFace {
  x: number;
  y: number;
  gap: number;
  scale?: number;
  squeeze?: number;
  tone?: PlantTone;
}

export interface PlantPart {
  at: readonly [number, number];
  fold: number;
}

export interface PlantPresetDef {
  pivot: readonly [number, number];
  face: PlantFace;
  parts?: { l: PlantPart; r: PlantPart };
  layers: readonly PlantLayer[];
  palette: { light: PlantPalette; dark: PlantPalette };
}

type LayerExtra = Pick<PlantLayer, 'part' | 'op' | 'rim'>;
const L = (d: string, tone: PlantTone = 'body', lods = 'gap', extra: LayerExtra = {}): PlantLayer => ({
  d,
  tone,
  lods,
  ...extra,
});
const S = (d: string, tone: PlantTone, width: number, lods = 'gap', extra: LayerExtra = {}): PlantLayer => ({
  d,
  tone,
  lods,
  stroke: width,
  ...extra,
});

// ─── geometry ───────────────────────────────────────────────────────────────

/** A baked palette in PLANT_TONES order: disc body shade light accent accent2 stem ink catch rim mark. */
function tones(hexes: string): PlantPalette {
  const v = hexes.trim().split(/\s+/);
  if (v.length !== PLANT_TONES.length) throw new Error(`palette needs ${PLANT_TONES.length} tones: ${hexes}`);
  return Object.freeze(Object.fromEntries(PLANT_TONES.map((t, i) => [t, v[i]!]))) as PlantPalette;
}

// The fern's crozier: a thick coil wound round its head, from the stem (bottom-left) inward.
const FERN_COIL = spiral(54, 46, 28, 22.5, 110, 440);

// ─── presets ────────────────────────────────────────────────────────────────
// Contrast floors (spec §7): the face (eyes, mouth, brows) vs every tone drawn under it ≥ 4.5:1
// in both themes and every state (error desaturates, sleep dims) — two-tone halves included,
// sampled from the real output. No keyline (flat design): in light, body and shade vs the own
// disc ≥ 1.8:1 — colour on a tint, the name sits next to every avatar; dark body vs #1A231B /
// #0F1510 / own disc ≥ 3:1. `rim` is only painted for the opt-in keyline (`rim: true`).
// `face.tone` names the tone the face sits on (body unless set). `mark` paints the portrait
// state marks (dots, z, motion lines) on the disc: dark in light, light in dark.

export const PLANT_PRESETS = Object.freeze({
  // 1 ── 芽芽 Sprout — a round seed with three small leaves; the built-in Sprouty.
  sprout: {
    pivot: [50, 91],
    face: { x: 50, y: 62, gap: 9.6 },
    parts: { l: { at: [50, 25], fold: -38 }, r: { at: [50, 25], fold: 38 } },
    layers: [
      S('M50 36V24', 'stem', 5.5),
      L(lens(50, 25.5, 50, 7.5, 10.5), 'shade'),
      L(lens(49, 25.5, 34.5, 13.5, 10), 'shade', 'gap', { part: 'l' }),
      L(lens(51, 25.5, 65.5, 13.5, 10), 'shade', 'gap', { part: 'r' }),
      L(circ(50, 62, 29)),
    ],
    palette: {
      light: tones('#EAF1E2 #9AB67A #5E9466 #D6E8C4 #E2B04A #E2B04A #4A8A6C #14200F #FFFFFF #56744A #56744A'),
      dark: tones('#1F2E1C #A9C78A #74AA79 #D6E8C4 #E2B04A #E2B04A #5FA287 #14200F #FFFFFF #0E170C #A9C78A'),
    },
  },

  // 2 ── 藤藤 Ivy (chief of staff) — a geometric heart leaf with a curling tendril.
  ivy: {
    pivot: [50, 90],
    face: { x: 50, y: 56, gap: 9.6 },
    layers: [
      S('M50 35C50 27 55 22 62 21C69 20 72 15 69 11C66 8 61 10 63 14', 'stem', 3.6, 'ap'),
      L(heart(66.6, 24.9, 0.3, -50), 'shade', 'ap'),
      L(heart(50, 58, 1.2)),
      S('M50 72V84', 'light', 1.8, 'p', { op: 0.55 }),
    ],
    palette: {
      light: tones('#E2EFEA #4A8C7B #3B7767 #BFE0D4 #3F7F70 #3F7F70 #3E7A69 #03100A #FFFFFF #2A5F51 #2A5F51'),
      dark: tones('#183028 #62A894 #4E927F #BFE0D4 #3F7F70 #3F7F70 #57988A #03100A #FFFFFF #08140F #62A894'),
    },
  },

  // 3 ── Sage — a tall oval leaf, tilted, silver-green.
  sage: {
    pivot: [57, 92],
    face: { x: 50, y: 51, gap: 9.2 },
    layers: [
      S('M57.5 88V95', 'stem', 4.5),
      L(lens(57.5, 90, 42.5, 9, 52)),
      S('M56.4 86L53 68M46.8 33L43.6 15', 'shade', 1.8, 'p', { op: 0.55 }),
    ],
    palette: {
      light: tones('#EEF2E9 #A8B698 #8A9C7B #F1F4EA #8B7BC4 #8B7BC4 #7D8F6E #141C10 #FFFFFF #56654A #56654A'),
      dark: tones('#252F20 #A4B98D #879E72 #E8F1DC #8B7BC4 #8B7BC4 #8DA37D #141C10 #FFFFFF #0D120B #A4B98D'),
    },
  },

  // 4 ── Basil — a teardrop leaf with a two-tone crease.
  basil: {
    pivot: [50, 95],
    face: { x: 50, y: 63, gap: 10 },
    layers: [
      S('M50 91V96', 'stem', 5),
      L('M50 8L74.9 45.3A30 30 0 1 1 25.1 45.3Z'),
      L('M50 8L74.9 45.3A30 30 0 0 1 50 92Z', 'shade', 'ap', { rim: false }),
      S('M50 15V40', 'light', 1.6, 'p', { op: 0.7 }),
    ],
    palette: {
      light: tones('#E3F2E3 #5DB052 #4E9C45 #B5E39C #F4F1EA #F4F1EA #2F6E33 #06180A #FFFFFF #24622A #24622A'),
      dark: tones('#173419 #6CC062 #5AAC51 #B5E39C #F4F1EA #F4F1EA #4A8A4E #06180A #FFFFFF #07140A #6CC062'),
    },
  },

  // 5 ── 卷卷 Fern (writer) — a crozier: round head inside its own coil, short thick stem.
  fern: {
    pivot: [47, 92],
    face: { x: 54, y: 46, gap: 8.8, scale: 0.95 },
    parts: { l: { at: [45, 82], fold: -30 }, r: { at: [46, 87], fold: 30 } },
    layers: [
      S('M44.4 72C43 80 45 87 47 92', 'stem', 6.5),
      L(lens(45, 82, 31.5, 75.5, 8.5), 'light', 'ap', { part: 'l' }),
      L(lens(46, 87, 60, 81, 8.5), 'light', 'ap', { part: 'r' }),
      S(FERN_COIL, 'shade', 8),
      L(circ(54, 46, 20)),
    ],
    palette: {
      light: tones('#FBEDE0 #DA9452 #B8743A #8DB062 #B98A5E #B98A5E #6F8F47 #2A1405 #FFFFFF #8A4F1E #8A4F1E'),
      dark: tones('#3A2A1C #E3A365 #C7864A #9DBF70 #B98A5E #B98A5E #84A65C #2A1405 #FFFFFF #160E07 #E3A365'),
    },
  },

  // 6 ── 叶叶 Clover (analyst) — a round head before three heart leaflets, short thick stem.
  clover: {
    pivot: [50, 91],
    face: { x: 50, y: 50, gap: 8.8, scale: 0.95 },
    layers: [
      S('M50 70V91', 'stem', 6.5),
      L(heart(50, 27, 0.55), 'shade'),
      L(heart(30, 61.5, 0.55, -120), 'shade'),
      L(heart(70, 61.5, 0.55, 120), 'shade'),
      L(circ(50, 50, 21)),
    ],
    palette: {
      light: tones('#EEEAF7 #8E80C2 #B1A6DA #D9D2F0 #F3EEF2 #F3EEF2 #6E8F5E #120A24 #FFFFFF #4E3F86 #4E3F86'),
      dark: tones('#2A2438 #A194D4 #C0B6E6 #D9D2F0 #F3EEF2 #F3EEF2 #84A673 #120A24 #FFFFFF #110C19 #A194D4'),
    },
  },

  // 7 ── Monstera — a round leaf with notched splits (none near the face).
  monstera: {
    pivot: [50, 95],
    face: { x: 50, y: 53, gap: 9.6 },
    layers: [
      S('M50 87V95', 'stem', 5),
      L(
        notched(50, 52, 36, [
          [-90, 9, 10],
          [-28, 6, 13],
          [14, 6, 12],
          [166, 6, 12],
          [208, 6, 13],
        ]),
      ),
      S('M50 72V86M50 28V38', 'light', 1.8, 'p', { op: 0.5 }),
    ],
    palette: {
      light: tones('#E2EEE7 #3E9467 #2F7A53 #A9D9B8 #EFE6C8 #EFE6C8 #2A7049 #020D06 #FFFFFF #1A5236 #1A5236'),
      dark: tones('#143324 #4BA676 #3B8C61 #A9D9B8 #EFE6C8 #EFE6C8 #3F8A60 #020D06 #FFFFFF #06120B #4BA676'),
    },
  },

  // 8 ── Ginkgo — a notched fan in autumn gold.
  ginkgo: {
    pivot: [50, 93],
    face: { x: 50, y: 57, gap: 9.2 },
    layers: [
      S('M50 74V93', 'stem', 4.5),
      L(notched(50, 76, 46, [[270, 5, 15]], [205, 335])),
      S('M25.5 55.4L17.8 49M31.5 47.5L26.6 40M68.5 47.5L73.4 40M74.5 55.4L82.2 49', 'light', 1.4, 'p', { op: 0.5 }),
    ],
    palette: {
      light: tones('#F8EDD2 #DDA22F #C98D1C #F6DA8C #C9A15E #C9A15E #9A7426 #2E1F05 #FFFFFF #8A5C08 #8A5C08'),
      dark: tones('#3A2E14 #E8B246 #CC9528 #F6DA8C #C9A15E #C9A15E #A4823C #2E1F05 #FFFFFF #1A1306 #E8B246'),
    },
  },

  // 9 ── Maple — a straight-edged five-lobed leaf, autumn orange (never red: red reads as error).
  maple: {
    pivot: [50, 93],
    face: { x: 50, y: 49, gap: 8.8 },
    layers: [
      S('M50 78V93', 'stem', 4.5),
      L(poly('50,8 57.5,26 80,18 73,40 92,50 71,60 78,76 56,70 50,80 44,70 22,76 29,60 8,50 27,40 20,18 42.5,26')),
      S('M50 66V77', 'light', 1.6, 'p', { op: 0.55 }),
    ],
    palette: {
      light: tones('#FBE9DC #E07E3E #C2632A #F6BE8E #D8A869 #D8A869 #8E4A20 #2A1003 #FFFFFF #8C3E10 #8C3E10'),
      dark: tones('#3A2216 #EA8B4E #CC6E33 #F6BE8E #D8A869 #D8A869 #995C36 #2A1003 #FFFFFF #1A0D06 #EA8B4E'),
    },
  },

  // 10 ── Echeveria — a rosette seen from above, the face on its pale heart.
  echeveria: {
    pivot: [50, 80],
    face: { x: 50, y: 50, gap: 8, scale: 0.9, tone: 'light' },
    layers: [
      L(lensRing(50, 50, 8, 14, 47, 27, 22.5), 'shade'),
      L(lensRing(50, 50, 8, 10, 37, 23), 'body', 'gap', { rim: false }),
      L(circ(50, 50, 20), 'light', 'gap', { rim: false }),
      L(dotRing(50, 50, 8, 43.5, 2.4, 22.5), 'accent', 'p', { op: 0.9 }),
    ],
    palette: {
      light: tones('#E9F0F4 #86A9BD #6A8FA5 #C9DCE6 #E392A6 #E392A6 #6A8FA5 #102330 #FFFFFF #3E6074 #3E6074'),
      dark: tones('#1D2B33 #91B3C7 #7395AA #C2D8E4 #E392A6 #E392A6 #7395AA #102330 #FFFFFF #0B1216 #91B3C7'),
    },
  },

  // 11 ── 仙仙 Cactus (operator; id `opuntia`) — a pill with two raised arms and a blossom.
  opuntia: {
    pivot: [50, 91],
    face: { x: 50, y: 46, gap: 8, scale: 0.9 },
    parts: { l: { at: [35, 64], fold: -24 }, r: { at: [65, 64], fold: 24 } },
    layers: [
      L('M35 70H29A9 9 0 0 1 20 61V52A5.5 5.5 0 0 1 31 52V59H35Z', 'body', 'gap', { part: 'l' }),
      L('M65 70H71A9 9 0 0 0 80 61V52A5.5 5.5 0 0 0 69 52V59H65Z', 'body', 'gap', { part: 'r' }),
      L(capsule(50, 34, 50, 74, 17)),
      S('M43.5 70V85M56.5 70V85', 'shade', 2, 'p', { op: 0.6 }),
      L(circ(44.5, 19, 5.2) + circ(55.5, 19, 5.2) + circ(50, 13, 5.2), 'accent', 'ap'),
      L(circ(50, 18.4, 2.8), 'accent2', 'ap', { rim: false }),
      L(circ(50, 18, 7.5), 'accent', 'g'),
    ],
    palette: {
      light: tones('#EAF2E6 #78A35E #5E874A #D5E8C8 #E2786A #F2C14E #5E874A #0E1D09 #FFFFFF #3E6230 #3E6230'),
      dark: tones('#1F3119 #8AB86F #6E9A57 #D5E8C8 #EB8778 #F2C14E #6E9A57 #0E1D09 #FFFFFF #0A1208 #8AB86F'),
    },
  },

  // 12 ── Lotus — a pointed bloom on its pad; the side petals close at night.
  lotus: {
    pivot: [50, 86],
    face: { x: 50, y: 51, gap: 8.6, tone: 'light' },
    parts: { l: { at: [48, 79], fold: 16 }, r: { at: [52, 79], fold: -16 } },
    layers: [
      L(ell(50, 84, 37, 8), 'accent2'),
      L(lens(46, 80, 11, 58, 20), 'shade', 'ap', { part: 'l' }),
      L(lens(54, 80, 89, 58, 20), 'shade', 'ap', { part: 'r' }),
      L(lens(48, 80, 21, 33, 26), 'body', 'gap', { part: 'l' }),
      L(lens(52, 80, 79, 33, 26), 'body', 'gap', { part: 'r' }),
      L(lens(50, 81, 50, 14, 38), 'light'),
    ],
    palette: {
      light: tones('#FBEAF0 #E58AA9 #C8698C #F4B6CB #F5CF5A #5A9446 #5A9446 #3A0F22 #FFFFFF #9C3A62 #9C3A62'),
      dark: tones('#3A1C28 #EA96B3 #CB7294 #F6BCD0 #F5CF5A #66A052 #66A052 #3A0F22 #FFFFFF #1A0B11 #EA96B3'),
    },
  },

  // 13 ── Eucalyptus — round leaves in pairs up a red stem; the face on the big bottom leaf.
  eucalyptus: {
    pivot: [50, 92],
    face: { x: 50, y: 64, gap: 10 },
    layers: [
      S('M50 92V11', 'stem', 3.4),
      L(circ(43.5, 16, 6.5) + circ(56.5, 16, 6.5), 'shade', 'ap'),
      L(circ(37.5, 34, 11) + circ(62.5, 34, 11), 'shade'),
      L(circ(50, 65, 27)),
    ],
    palette: {
      light: tones('#E7F1EF #7DAAA4 #5F8E87 #D8EAE6 #B4654E #B4654E #A3563F #0C2220 #FFFFFF #3D6A64 #3D6A64'),
      dark: tones('#1A2C2A #89B5AF #68948D #D8EAE6 #B4654E #B4654E #C0705A #0C2220 #FFFFFF #0A1413 #89B5AF'),
    },
  },

  // 14 ── Lavender — a spike of stacked circles; purple anchors colour-blind rosters.
  lavender: {
    pivot: [50, 93],
    face: { x: 50, y: 67, gap: 8.8 },
    parts: { l: { at: [48, 89], fold: -20 }, r: { at: [52, 89], fold: 20 } },
    layers: [
      S('M50 93V84', 'stem', 4.5),
      L(lens(48, 90, 29, 76, 9), 'stem', 'ap', { part: 'l' }),
      L(lens(52, 90, 71, 76, 9), 'stem', 'ap', { part: 'r' }),
      L(circ(50, 12.5, 8.5) + circ(50, 27, 12.5) + circ(50, 45.5, 16.5), 'shade'),
      L(circ(50, 67, 20.5)),
      L(dots(pts('46,24 54,30 45,42 56,47 50,12'), 1.7), 'light', 'p', { op: 0.8 }),
    ],
    palette: {
      light: tones('#EFEAF7 #9177C7 #7A5FB4 #D0C0F0 #C9B6EC #C9B6EC #7F9878 #140A28 #FFFFFF #4F3586 #4F3586'),
      dark: tones('#2A2238 #A088D2 #8A70C0 #D4C6F1 #CDBDEE #CDBDEE #8FA888 #140A28 #FFFFFF #110C19 #A088D2'),
    },
  },

  // 15 ── Sunflower — rays round a dark seed face; the only light-eyed preset.
  // Glyph = merged scalloped ring (separate rays break into dots at 16px).
  sunflower: {
    pivot: [50, 80],
    face: { x: 50, y: 50, gap: 8.2, tone: 'accent' },
    layers: [
      L(lensRing(50, 50, 12, 17, 47, 15, 15), 'shade', 'p'),
      L(lensRing(50, 50, 12, 17, 47, 15), 'body', 'ap'),
      L(scallop(50, 50, 46.5, 39, 12), 'body', 'g'),
      L(circ(50, 50, 23), 'accent', 'ap', { rim: false }),
      L(circ(50, 50, 25), 'accent', 'g', { rim: false }),
      L(fibSeeds(50, 50, 20, 40), 'accent2', 'p', { op: 0.7 }),
    ],
    palette: {
      light: tones('#FCF1CF #E9A820 #D6920E #FBE39A #5A3A1C #7C522B #4E7D2E #FBE8B5 #5A3A1C #9A6508 #9A6508'),
      dark: tones('#3A2F12 #F4BD38 #D8991C #FBE39A #5A3A1C #7C522B #608A43 #FBE8B5 #5A3A1C #191305 #F4BD38'),
    },
  },

  // 16 ── 蒲蒲 Dandelion (researcher) — a big sunny head inside a clock of thick seed spokes.
  dandelion: {
    pivot: [50, 92],
    face: { x: 50, y: 46, gap: 9 },
    layers: [
      S('M50 70V92', 'stem', 5.5),
      S(spokes(50, 46, 12, 27, 35.5, 15), 'shade', 3.6, 'ap'),
      L(dotRing(50, 46, 12, 39, 4.3, 15), 'shade', 'ap'),
      S(spokes(50, 46, 12, 26, 40, 15), 'shade', 6.5, 'g'),
      L(circ(50, 46, 26)),
    ],
    palette: {
      light: tones('#FCF3D8 #E8AE2A #C99520 #FBE7A1 #F2C443 #F2C443 #7E9A55 #2A2006 #FFFFFF #8F6A0E #8F6A0E'),
      dark: tones('#3A3014 #F4CB55 #D9AA3C #FBE7A1 #F4CB55 #F4CB55 #8FAE66 #2A2006 #FFFFFF #1A1406 #F4CB55'),
    },
  },
} satisfies Record<PlantId, PlantPresetDef>) as Readonly<Record<PlantId, PlantPresetDef>>;

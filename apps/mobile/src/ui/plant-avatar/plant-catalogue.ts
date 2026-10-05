// VENDORED from packages/ui/src/components/plant-avatar/plant-catalogue.ts — do not edit here.
// Edit the canonical file, re-copy it verbatim (only the PlantId import below differs) and run
// the parity test: npx vitest run --project unit apps/mobile/src/ui/plant-avatar (see apps/mobile/AGENTS.md).

/**
 * Plant-avatar catalogue — geometry + baked palettes for the fifteen species.
 *
 * Geometry lives on a 100×100 viewBox (disc = circle r50). Each preset has:
 *   pivot   where the plant grows from; state poses rotate / scale about it
 *   face    eye anchor (x, y), centre half-gap, optional eye scale, squeeze (eyes that
 *           move together when paired parts fold) and the tone the eyes sit on
 *   parts   paired organs that fold about their own base (l / r)
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
  circ,
  dots,
  ell,
  fibSeeds,
  mirror,
  pts,
  ringD,
  scallop,
  sm,
  smooth,
  smx,
  sym,
  xf,
  type Pt,
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

// Sprout: two cotyledons in a V on a teal stem (the logo sprout). Both eyes sit at the
// junction where the leaves overlap, so the pair reads as one face with two leaves above
// it (one eye per cotyledon reads as goggles at 16–24px).
const SPROUT_R = pts('50,47* 55,37 62,27 71,19 81,15 89,18 92,26 90,38 84,50 75,61 63,70 50,75*');
const SPROUT_HALF_R: Pt[] = [...SPROUT_R, [48, 74, 1], [48.5, 56, 1]]; // inner edge overlaps 2u under the left half
const SPROUT_HALF_L = mirror([...SPROUT_R, [52, 74, 1], [51.5, 56, 1]]);

const IVY = sym(
  pts('50,10 57,13 61,21 62,31 63,37* 72,32 83,31 90,37 90,45 84,52 74,57 72,61* 76,68 72,77 62,81 50,76*'),
);

const SAGE_T = { rot: -16, cx: 50, cy: 52 };
const SAGE = xf(sym(pts('50,6* 60,9 68,17 73,30 75,47 72,63 66,77 58,86 50,89*')), SAGE_T);

const BASIL_R = pts('50,7* 62,14 73,27 80,45 79,63 71,78 60,87 50,89*');

const CLOVER_LEAF = '50,50* 39,44 32,34 32,23 38,15 45,14 50,19* 55,14 62,15 68,23 68,34 61,44';
const cloverAt = (rot: number) => ({ rot, cx: 50, cy: 50, dy: 1 });

const MONSTERA = sym(
  pts('50,9 61,10 70,14 74,17* 61,34* 64,35* 82,24* 87,33 89,43* 66,52* 67,56* 89,55* 86,66 78,76 66,82 57,81 50,75*'),
);
const MONSTERA_G = sym(
  pts('50,9 62,10 72,15 76,19* 60,36* 66,38* 85,29* 89,40 89,50* 68,56* 69,62* 87,64* 81,74 70,81 58,81 50,75*'),
);

const GINKGO = sym(pts('50,33* 54,22 61,16 72,14 84,18 91,26* 80,45 64,59 50,66*'));

const MAPLE = sym(
  pts('50,7* 57,15 59,24 61,35* 70,27 81,24 91,26* 87,37 80,46 73,52* 80,58 86,66* 76,70 66,71 58,74 50,79*'),
);
const MAPLE_G = sym(
  pts('50,8 57,15 60,25 62,36* 71,29 82,26 90,29 87,39 80,47 74,53* 80,59 84,67 75,71 65,72 57,75 50,79*'),
);

const ECH_PETAL = pts('50,50* 37,39 37,23 50,9* 63,23 63,39');
const ECH_TIP = pts('44,18 50,9* 56,18 50,15.5');

const OPUNTIA_T = { rot: 6, cx: 50, cy: 88 };

const LOTUS_SIDE_L = pts('49,75* 36,72 23,63 15,50 12,34* 24,39 35,48 43,60');
const LOTUS_BACK_L = pts('48,76* 33,77 17,72 7,62* 20,58 34,62');

const LAV: readonly [number, number, number][] = [
  [50, 70, 19.5],
  [50, 53, 21],
  [50, 36, 18],
  [50, 22, 14],
  [50, 11.5, 9],
];
const LAV_G: readonly [number, number, number][] = [
  [50, 68, 23],
  [50, 49, 23],
  [50, 31, 19],
  [50, 16, 12.5],
];

const SUN_PETAL = pts('50,50* 44,34 45,18 50,7* 55,18 56,34');

// ─── presets ────────────────────────────────────────────────────────────────
// Contrast floors (spec §7): eyes vs every tone drawn under them ≥ 4.5:1 in both themes and every
// state (error desaturates, sleep dims) — two-tone halves included, sampled from the real output;
// light rim vs #FFFFFF / #F1F7ED / own disc ≥ 3:1; dark body vs #1A231B / #0F1510 / own disc ≥ 3:1.
// `face.tone` names the tone the eyes are centred on (body unless set).

export const PLANT_PRESETS = Object.freeze({
  // 1 ── Sprout — seedling cotyledons; the built-in Sprouty. Teal stem = the logo tile colour.
  sprout: {
    pivot: [50, 90],
    face: { x: 50, y: 59, gap: 13.6, scale: 1.08, squeeze: 0.42 },
    parts: { l: { at: [50, 74], fold: 20 }, r: { at: [50, 74], fold: -20 } },
    layers: [
      S('M50 87V72', 'stem', 8),
      L(smooth(SPROUT_HALF_L), 'body', 'gap', { part: 'l' }),
      L(smooth(SPROUT_HALF_R), 'shade', 'gap', { part: 'r' }),
      S('M47 70C40 56 30 42 14 30', 'light', 2, 'p', { part: 'l', op: 0.7 }),
      S('M53 70C60 56 70 42 86 30', 'light', 2, 'p', { part: 'r', op: 0.55 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E1F2EB', body: '#5DAE45', shade: '#4E9C3A', light: '#CDEBAE', accent: '#B08D57', accent2: '#B08D57', stem: '#0D9488', ink: '#0A1F12', catch: '#FFFFFF', rim: '#2C6A2B' },
      dark: { disc: '#163A32', body: '#6CBE52', shade: '#5BAA45', light: '#CDEBAE', accent: '#B08D57', accent2: '#B08D57', stem: '#2BB3A5', ink: '#0A1F12', catch: '#FFFFFF', rim: '#0B1A12' },
    },
  },

  // 2 ── Ivy (Hedera helix) — juvenile three-lobed leaf, blunt lobes, cordate base. Darkest template green.
  ivy: {
    pivot: [50, 92],
    face: { x: 50, y: 50, gap: 11.5 },
    layers: [
      S('M50 89V74', 'stem', 5),
      L(smooth(IVY)),
      S('M50 74V22M50 70L82 40M50 70L18 40M50 72L66 74M50 72L34 74', 'light', 1.8, 'p', { op: 0.7 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E3EEE6', body: '#468C5A', shade: '#357547', light: '#CBE3C1', accent: '#3A2F4F', accent2: '#3A2F4F', stem: '#2F6340', ink: '#04100A', catch: '#FFFFFF', rim: '#1D4429' },
      dark: { disc: '#19321F', body: '#5AA06C', shade: '#468A58', light: '#CBE3C1', accent: '#3A2F4F', accent2: '#3A2F4F', stem: '#4A7A57', ink: '#04100A', catch: '#FFFFFF', rim: '#08130B' },
    },
  },

  // 3 ── Sage (Salvia officinalis) — oblong, blunt, tilted; silver edge + midrib. Palest template.
  sage: {
    pivot: [50, 90],
    face: { x: 49, y: 50, gap: 11.5 },
    layers: [
      S(smooth(xf(pts('50,86 50,94'), SAGE_T), false), 'stem', 5),
      L(smooth(SAGE)),
      L(smx('44,11* 35,20 28,37 27,56 32,73* 31,56 32,38 38,22', SAGE_T), 'light', 'ap', { op: 0.95 }),
      S(smooth(xf(pts('50,84 50,64'), SAGE_T), false), 'shade', 2.2, 'a', { op: 0.75 }),
      S(smooth(xf(pts('50,84 50,16'), SAGE_T), false), 'shade', 1.6, 'p', { op: 0.6 }),
      L(dots(xf(pts('62,30 64,64 38,70 58,74 42,32 66,46'), SAGE_T), 1.6), 'shade', 'p', { op: 0.45 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#EEF2E9', body: '#A2B392', shade: '#8A9C7B', light: '#F3F6EC', accent: '#8B7BC4', accent2: '#8B7BC4', stem: '#7D8F6E', ink: '#141C10', catch: '#FFFFFF', rim: '#4E5E44' },
      dark: { disc: '#252F20', body: '#9AB680', shade: '#82A06A', light: '#E8F1DC', accent: '#8B7BC4', accent2: '#8B7BC4', stem: '#8DA37D', ink: '#141C10', catch: '#FFFFFF', rim: '#0D120B' },
    },
  },

  // 4 ── Basil (Ocimum basilicum) — glossy pointed ovate, two-tone midrib crease. Saturated mid green.
  // The right eye sits on the shade half: shade is lifted so ink holds 4.5:1 through error's
  // desaturation (light) and sleep's dimming (dark); body is lifted with it so the crease keeps
  // ≈ 1.25:1 (sprout's).
  basil: {
    pivot: [50, 92],
    face: { x: 50, y: 54, gap: 12 },
    layers: [
      S('M50 93V86', 'stem', 5),
      L(smooth(sym(BASIL_R))),
      L(smooth(BASIL_R), 'shade', 'ap', { rim: false }),
      S('M50 14V84', 'light', 1.6, 'p', { op: 0.8 }),
      L(sm('31,30 40,19 46,15 38,28 33,43 30,41'), 'light', 'p', { op: 0.75 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E3F2E3', body: '#44AB42', shade: '#37983A', light: '#ABE290', accent: '#F4F1EA', accent2: '#F4F1EA', stem: '#2A6A2E', ink: '#06180A', catch: '#FFFFFF', rim: '#1E5E22' },
      dark: { disc: '#173419', body: '#56BC53', shade: '#44A745', light: '#ABE290', accent: '#F4F1EA', accent2: '#F4F1EA', stem: '#3F7943', ink: '#06180A', catch: '#FFFFFF', rim: '#07140A' },
    },
  },

  // 5 ── Fern (fiddlehead, circinate vernation) — crozier around a pale young-growth face.
  fern: {
    pivot: [58, 94],
    face: { x: 45.5, y: 39, gap: 10.2, scale: 0.94, tone: 'light' },
    layers: [
      L(circ(45, 40, 21), 'light', 'ap'),
      L(circ(45, 40, 23), 'light', 'g'),
      S(
        sm(
          '60,90 61,76 63,64 66.7,52.5 70,40 62.7,22.3 45,15 27.3,22.3 20,40 23.3,52.5 34.5,58.2 43.6,55.9 47.8,50.6',
          false,
        ),
        'body',
        12,
        'ap',
      ),
      S(
        sm('60,90 61,77 63,66 67.8,53.4 71.4,40 63.7,21.3 45,13.6 26.3,21.3 18.6,40 22.4,54.2 34.5,60 44,58', false),
        'body',
        11,
        'g',
      ),
      S(sm('66,64 70,50 70,36 63,24', false), 'shade', 2.2, 'p', { op: 0.5 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#EDF4E2', body: '#78AE3C', shade: '#5F9330', light: '#DDEFB2', accent: '#B98A5E', accent2: '#B98A5E', stem: '#5F9330', ink: '#13230A', catch: '#FFFFFF', rim: '#3B6219' },
      dark: { disc: '#22331A', body: '#86BC4A', shade: '#6EA03C', light: '#D2E89F', accent: '#B98A5E', accent2: '#B98A5E', stem: '#6EA03C', ink: '#13230A', catch: '#FFFFFF', rim: '#0C1407' },
    },
  },

  // 6 ── Clover (Trifolium repens) — three notched leaflets around a hub. Blue-green.
  clover: {
    pivot: [50, 92],
    face: { x: 50, y: 52, gap: 11 },
    layers: [
      S('M52 60C55 72 59 80 63 88', 'stem', 5),
      L(smx(CLOVER_LEAF, cloverAt(0))),
      L(smx(CLOVER_LEAF, cloverAt(120))),
      L(smx(CLOVER_LEAF, cloverAt(240))),
      L(circ(50, 51, 13)),
      ...[0, 120, 240].map((r) =>
        L(smx('38,25 50,33* 62,25 61,29 50,38* 39,29', cloverAt(r)), 'light', 'p', { op: 0.4 }),
      ),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E2F0EA', body: '#33946A', shade: '#267A55', light: '#D2EDDD', accent: '#F3EEF2', accent2: '#F3EEF2', stem: '#267A55', ink: '#03130B', catch: '#FFFFFF', rim: '#17503A' },
      dark: { disc: '#163327', body: '#45A87C', shade: '#378C66', light: '#D2EDDD', accent: '#F3EEF2', accent2: '#F3EEF2', stem: '#3F9068', ink: '#03130B', catch: '#FFFFFF', rim: '#06120C' },
    },
  },

  // 7 ── Monstera (Monstera deliciosa) — split heart; the splits are the tell (no holes near the face).
  monstera: {
    pivot: [50, 94],
    face: { x: 50, y: 49, gap: 11 },
    layers: [
      S('M50 90V76', 'stem', 5),
      L(smooth(MONSTERA), 'body', 'ap'),
      L(smooth(MONSTERA_G), 'body', 'g'),
      S('M50 74V16', 'light', 1.8, 'p', { op: 0.55 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E2EEE7', body: '#33905C', shade: '#277549', light: '#A9D9A8', accent: '#EFE6C8', accent2: '#EFE6C8', stem: '#236E45', ink: '#020D06', catch: '#FFFFFF', rim: '#134A2B' },
      dark: { disc: '#143324', body: '#3FA06A', shade: '#328455', light: '#A9D9A8', accent: '#EFE6C8', accent2: '#EFE6C8', stem: '#3A7A57', ink: '#020D06', catch: '#FFFFFF', rim: '#06120B' },
    },
  },

  // 8 ── Ginkgo (Ginkgo biloba) — bilobed fan in autumn gold.
  ginkgo: {
    pivot: [50, 94],
    face: { x: 50, y: 40, gap: 12.5 },
    layers: [
      S('M50 82V62', 'stem', 4.5, 'ga'),
      S('M50 89V62', 'stem', 4.2, 'p'),
      L(smooth(GINKGO)),
      L(sm('50,66* 64,59 80,45 91,26* 89,37 78,52 62,63'), 'shade', 'ap', { rim: false }),
      S(
        'M50 64L28 22M50 64L38 18M50 64L44 26M50 64L72 22M50 64L62 18M50 64L56 26M50 64L18 28M50 64L82 28',
        'light',
        1.2,
        'p',
        { op: 0.55 },
      ),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#F8EDD2', body: '#E5AA2C', shade: '#CB8E15', light: '#F8DE8E', accent: '#C9A15E', accent2: '#C9A15E', stem: '#9A7426', ink: '#2E1F05', catch: '#FFFFFF', rim: '#8A5C08' },
      dark: { disc: '#3A2E14', body: '#E8B23A', shade: '#CC9322', light: '#F8DE8E', accent: '#C9A15E', accent2: '#C9A15E', stem: '#A4823C', ink: '#2E1F05', catch: '#FFFFFF', rim: '#1A1306' },
    },
  },

  // 9 ── Maple (Acer, autumn) — five lobes, autumn orange (never red: red reads as error).
  maple: {
    pivot: [50, 94],
    face: { x: 50, y: 50, gap: 10.5 },
    layers: [
      S('M50 90V76', 'stem', 4.5),
      L(smooth(MAPLE), 'body', 'ap'),
      L(smooth(MAPLE_G), 'body', 'g'),
      S('M50 76V20M50 72L86 30M50 72L14 30M50 74L80 64M50 74L20 64', 'light', 1.6, 'p', { op: 0.55 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#FBE9DC', body: '#E47B37', shade: '#C6611F', light: '#F8C08F', accent: '#D8A869', accent2: '#D8A869', stem: '#8E4A20', ink: '#2A1003', catch: '#FFFFFF', rim: '#8C3E10' },
      dark: { disc: '#3A2216', body: '#EA874A', shade: '#C86A2C', light: '#F8C08F', accent: '#D8A869', accent2: '#D8A869', stem: '#995C36', ink: '#2A1003', catch: '#FFFFFF', rim: '#1A0D06' },
    },
  },

  // 10 ── Echeveria (rosette succulent) — seen from above, broad spoon leaves, pale heart. Powder blue.
  echeveria: {
    pivot: [50, 80],
    face: { x: 50, y: 51, gap: 9.4, scale: 0.9, tone: 'light' },
    layers: [
      L(ringD(ECH_PETAL, 7), 'shade', 'ap'),
      L(ringD(ECH_TIP, 7), 'accent', 'p', { op: 0.9 }),
      L(ringD(ECH_PETAL, 7), 'body', 'g'),
      L(ringD(ECH_PETAL, 7, 360 / 14, 0.8), 'body', 'ap', { rim: false }),
      L(circ(50, 50, 18.5), 'light', 'ap', { rim: false }),
      L(circ(50, 50, 21.5), 'light', 'g', { rim: false }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E9F0F4', body: '#7FA3B8', shade: '#5F8399', light: '#BCD5E2', accent: '#E392A6', accent2: '#E392A6', stem: '#5F8399', ink: '#102330', catch: '#FFFFFF', rim: '#3E6074' },
      dark: { disc: '#1D2B33', body: '#8BAFC4', shade: '#698A9F', light: '#BAD4E1', accent: '#E392A6', accent2: '#E392A6', stem: '#6F8FA3', ink: '#102330', catch: '#FFFFFF', rim: '#0B1216' },
    },
  },

  // 11 ── Prickly pear (Opuntia cladode) — paddle with a magenta fruit (right of centre: survives stacks).
  opuntia: {
    pivot: [50, 90],
    face: { x: 51, y: 52, gap: 11 },
    layers: [
      L(smooth(xf(sym(pts('50,13 63,14 73,23 79,38 79,55 73,71 62,84 50,90*')), OPUNTIA_T))),
      L(smx('57,16 66,22 73,35 75,53 71,71 62,84 67,67 69,49 65,30', OPUNTIA_T), 'shade', 'ap', { op: 0.9 }),
      L(ell(73, 16, 8.5, 9.5), 'accent'),
      L(ell(73, 8.5, 4, 2.4), 'accent2', 'ap'),
      L(dots(pts('35,30 64,30 31,66 70,70 50,81 50,23'), 1.9), 'light', 'p', { op: 0.95 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#EBF2E8', body: '#6FA25A', shade: '#578A44', light: '#F3EBCF', accent: '#C8427E', accent2: '#9C2E5E', stem: '#578A44', ink: '#0E1D09', catch: '#FFFFFF', rim: '#36602A' },
      dark: { disc: '#1F3119', body: '#7CB066', shade: '#61914F', light: '#F3EBCF', accent: '#D24E88', accent2: '#A8386A', stem: '#689657', ink: '#0E1D09', catch: '#FFFFFF', rim: '#0A1208' },
    },
  },

  // 12 ── Lotus (Nelumbo nucifera) — pink bloom on a pad; side petals close at night.
  lotus: {
    pivot: [50, 86],
    face: { x: 50, y: 47, gap: 10, tone: 'light' },
    parts: { l: { at: [49, 75], fold: 16 }, r: { at: [51, 75], fold: -16 } },
    layers: [
      L(sm('18,80 34,75 50,74 66,75 82,80 70,86 50,88 30,86'), 'accent2'),
      L(smooth(LOTUS_BACK_L), 'shade', 'ap', { part: 'l' }),
      L(smooth(mirror(LOTUS_BACK_L)), 'shade', 'ap', { part: 'r' }),
      L(smooth(LOTUS_SIDE_L), 'body', 'gap', { part: 'l' }),
      L(smooth(mirror(LOTUS_SIDE_L)), 'body', 'gap', { part: 'r' }),
      L(smooth(sym(pts('50,11* 58,18 65,30 69,45 67,59 60,69 50,73*'))), 'light'),
      S('M50 20V30M44 66C42 58 41 50 42 42M56 66C58 58 59 50 58 42', 'body', 1.4, 'p', { op: 0.5 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#FBEAF0', body: '#E57FA4', shade: '#C85E86', light: '#F4AEC7', accent: '#F5CF5A', accent2: '#4F8B3B', stem: '#4F8B3B', ink: '#3A0F22', catch: '#FFFFFF', rim: '#9C3A62' },
      dark: { disc: '#3A1C28', body: '#EA8DAE', shade: '#CB688D', light: '#F6B5CC', accent: '#F5CF5A', accent2: '#5C9B47', stem: '#61974F', ink: '#3A0F22', catch: '#FFFFFF', rim: '#1A0B11' },
    },
  },

  // 13 ── Eucalyptus (E. cinerea, silver dollar) — round leaves clasping a red stem; face on the big lower pair.
  eucalyptus: {
    pivot: [50, 90],
    face: { x: 50, y: 61, gap: 12.5 },
    layers: [
      S('M50 92V9', 'stem', 3.4),
      L(sm('50,13* 55,10 60,12 61,17 57,21 50,20* 43,21 39,17 40,12 45,10'), 'shade', 'ap'),
      L(sm('50,28* 58,23 67,24 72,31 68,39 59,42 50,40* 41,42 32,39 28,31 33,24 42,23'), 'shade'),
      L(sm('50,45* 60,41 74,42 84,50 86,62 80,73 67,79 56,80 50,78* 44,80 33,79 20,73 14,62 16,50 26,42 40,41')),
      L(sm('21,62* 21,54 27,48 36,45 29,51 25,57'), 'light', 'p', { op: 0.6 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#E7F1EF', body: '#7AA8A2', shade: '#5E8C86', light: '#D8EAE6', accent: '#B4654E', accent2: '#B4654E', stem: '#A3563F', ink: '#0C2220', catch: '#FFFFFF', rim: '#3D6A64' },
      dark: { disc: '#1A2C2A', body: '#86B4AE', shade: '#66918B', light: '#D8EAE6', accent: '#B4654E', accent2: '#B4654E', stem: '#C0705A', ink: '#0C2220', catch: '#FFFFFF', rim: '#0A1413' },
    },
  },

  // 14 ── Lavender (Lavandula angustifolia) — scalloped flower spike; purple anchors colour-blind rosters.
  lavender: {
    pivot: [50, 94],
    face: { x: 50, y: 55, gap: 10 },
    layers: [
      S('M50 93V84', 'stem', 4.5),
      L(sm('49,91* 37,86 25,77 19,66* 32,71 44,81'), 'stem', 'ap'),
      L(sm('51,91* 63,86 75,77 81,66* 68,71 56,81'), 'stem', 'ap'),
      ...LAV.map(([x, y, r]) => L(circ(x, y, r), 'body', 'ap')),
      ...LAV_G.map(([x, y, r]) => L(circ(x, y, r), 'body', 'g')),
      L(
        pts('38,34 62,34 43,21 57,21 35,74 65,74 50,10 50,82')
          .map(([x, y]) => ell(x, y, 2.4, 1.6))
          .join(''),
        'light',
        'p',
        { op: 0.8 },
      ),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#EFEAF7', body: '#9073C6', shade: '#7558AD', light: '#C9B6EC', accent: '#C9B6EC', accent2: '#C9B6EC', stem: '#7F9878', ink: '#140A28', catch: '#FFFFFF', rim: '#4F3586' },
      dark: { disc: '#2A2238', body: '#9D82D0', shade: '#8167B8', light: '#CDBDEE', accent: '#CDBDEE', accent2: '#CDBDEE', stem: '#8FA888', ink: '#140A28', catch: '#FFFFFF', rim: '#110C19' },
    },
  },

  // 15 ── Sunflower (Helianthus annuus) — rays round a dark seed face; the only light-eyed preset.
  // Glyph = merged scalloped ring (separate rays break into dots at 16px).
  sunflower: {
    pivot: [50, 80],
    face: { x: 50, y: 50, gap: 9.5, tone: 'accent' },
    layers: [
      L(ringD(SUN_PETAL, 12, 15, 0.95), 'shade', 'p'),
      L(ringD(SUN_PETAL, 12), 'body', 'p'),
      L(scallop(50, 50, 47, 33, 12, 0, true), 'body', 'a'),
      L(scallop(50, 50, 46.5, 39, 12), 'body', 'g'),
      L(circ(50, 50, 22), 'accent', 'ap', { rim: false }),
      L(circ(50, 50, 24.5), 'accent', 'g', { rim: false }),
      L(fibSeeds(50, 50, 20, 60), 'accent2', 'p', { op: 0.75 }),
      S(circ(50, 50, 21.5), 'accent2', 2, 'ap', { op: 0.9 }),
    ],
    // prettier-ignore
    palette: {
      light: { disc: '#FCF1CF', body: '#F2B71F', shade: '#D6920E', light: '#FBE39A', accent: '#563519', accent2: '#7C522B', stem: '#4E7D2E', ink: '#FBE8B5', catch: '#563519', rim: '#9A6508' },
      dark: { disc: '#3A2F12', body: '#F5BE2E', shade: '#D8991C', light: '#FBE39A', accent: '#563519', accent2: '#7C522B', stem: '#608A43', ink: '#FBE8B5', catch: '#563519', rim: '#191305' },
    },
  },
} satisfies Record<PlantId, PlantPresetDef>) as Readonly<Record<PlantId, PlantPresetDef>>;

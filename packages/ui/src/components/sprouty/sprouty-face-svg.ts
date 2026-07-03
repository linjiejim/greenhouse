/**
 * Sprouty face — flat SVG expression builder (string → innerHTML).
 *
 * A lightweight, resolution-independent flat mascot — the single Sprouty used
 * across the product (identity avatars *and* agent-state / emotional moments).
 * Supports per-agent customization: color presets, leaf styles, and accessories.
 * Pure SVG driven by CSS animation (injected once via ensureSproutyFaceStyles),
 * reduced-motion aware. Faithful port of design/sprouty-redesign/sprouty-preview.html.
 *
 * Identity anchors: round belly-bearing body, two leaves rooted at the stem
 * tip, blush, gentle features, stubby limbs — "憨厚可靠".
 */

import { COLOR_PRESETS, type SproutyState } from './sprouty-constants.js';

export type SproutyFaceExpr =
  | 'idle'
  | 'thinking'
  | 'responding'
  | 'done'
  | 'error'
  | 'sleep'
  | 'love'
  | 'thumb'
  | 'surprise';

export const SPROUTY_FACE_EXPRESSIONS: SproutyFaceExpr[] = [
  'idle',
  'thinking',
  'responding',
  'done',
  'error',
  'sleep',
  'love',
  'thumb',
  'surprise',
];

/** Agent lifecycle state → the face that best fits it. */
export const FACE_STATE_MAP: Record<SproutyState, SproutyFaceExpr> = {
  idle: 'idle',
  thinking: 'thinking',
  responding: 'responding',
  done: 'done',
  error: 'error',
};

// ─── palette (forest / brand, tuned to the sheet) ────────
const C = {
  body: '#a4d65e',
  belly: '#edf6cf',
  leaf: '#8fce5e',
  vein: '#4f8f2e',
  ol: '#33501f',
  eye: '#22302a',
  blush: '#f3a6ac',
  heart: '#ff6f8f',
  spark: '#ffd24a',
  zzz: '#7f97ad',
  tear: '#7fc7e8',
  mouth: '#c14a63',
  tongue: '#e07a92',
};
const EYEY = 105,
  LX = 81,
  RX = 119,
  MY = 120,
  BROW = 89;

// ─── color theming ───────────────────────────────────────
function hx(v: number): string {
  return Math.max(0, Math.min(255, Math.round(v)))
    .toString(16)
    .padStart(2, '0');
}
function mix(a: string, b: string, t: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return (
    '#' +
    hx(ch(a, 0) + (ch(b, 0) - ch(a, 0)) * t) +
    hx(ch(a, 1) + (ch(b, 1) - ch(a, 1)) * t) +
    hx(ch(a, 2) + (ch(b, 2) - ch(a, 2)) * t)
  );
}
/**
 * Remap the 5 base body/leaf hexes to a named color preset (COLOR_PRESETS).
 * Face colors (eyes, blush, mouth) stay constant so every color reads on-brand.
 * Returns null for the default forest palette (no remap needed).
 */
function themeRemap(color?: string): Record<string, string> | null {
  if (!color || color === 'forest') return null;
  const preset = COLOR_PRESETS[color];
  if (!preset) return null;
  return {
    [C.body]: preset.body,
    [C.belly]: mix(preset.body, '#ffffff', 0.74),
    [C.leaf]: preset.leaf,
    [C.vein]: preset.leafDark,
    [C.ol]: mix(preset.bodyDark, '#000000', 0.42),
  };
}

type Motion = 'breathe' | 'breatheSlow' | 'hop' | 'shake' | 'thinkbob';
const EXPR: Record<SproutyFaceExpr, { motion: Motion; tilt?: string }> = {
  idle: { motion: 'breathe' },
  thinking: { motion: 'thinkbob' },
  responding: { motion: 'breathe' },
  done: { motion: 'hop' },
  error: { motion: 'breathe', tilt: 'rotate(-4 100 152)' },
  sleep: { motion: 'breatheSlow', tilt: 'rotate(-8 100 152) translate(0 3)' },
  love: { motion: 'breathe' },
  thumb: { motion: 'breathe' },
  surprise: { motion: 'shake' },
};

// ─── geometry helpers ────────────────────────────────────
function heartPath(x: number, y: number, s: number): string {
  return `M${x} ${y + s * 0.35} C${x - s * 0.55} ${y - s * 0.45} ${x - s * 1.2} ${y + s * 0.15} ${x} ${y + s * 1.1} C${x + s * 1.2} ${y + s * 0.15} ${x + s * 0.55} ${y - s * 0.45} ${x} ${y + s * 0.35} Z`;
}
function leafFrom(bx: number, by: number, deg: number, L: number, W: number): string {
  const th = (deg * Math.PI) / 180;
  const dx = Math.sin(th),
    dy = -Math.cos(th); // base → tip direction
  const px = Math.cos(th),
    py = Math.sin(th); // width axis (perpendicular)
  const r = (v: number) => Math.round(v * 10) / 10;
  const tx = r(bx + L * dx),
    ty = r(by + L * dy);
  const mx = bx + 0.52 * L * dx,
    my = by + 0.52 * L * dy;
  const c1x = r(mx + (W / 2) * px),
    c1y = r(my + (W / 2) * py);
  const c2x = r(mx - (W / 2) * px),
    c2y = r(my - (W / 2) * py);
  return (
    `<path d="M${r(bx)} ${r(by)} Q${c1x} ${c1y} ${tx} ${ty} Q${c2x} ${c2y} ${r(bx)} ${r(by)} Z" fill="${C.leaf}" stroke="${C.ol}" stroke-width="2.6" stroke-linejoin="round"/>` +
    `<path d="M${r(bx)} ${r(by)} L${tx} ${ty}" fill="none" stroke="${C.vein}" stroke-width="1.8" stroke-linecap="round"/>`
  );
}
function sprout(leafStyle?: string): string {
  // Stem tip at ~(100,50); both leaf blades root there so they visibly touch the stem.
  const big = leafStyle === 'big',
    mini = leafStyle === 'mini',
    dbl = leafStyle === 'double';
  const L = big ? 33 : mini ? 21 : 27;
  const W = big ? 18 : mini ? 11 : 15;
  // Double: an extra lower pair splayed wider, drawn behind the main pair.
  const extra = dbl ? leafFrom(96, 60, -68, 20, 11) + leafFrom(104, 60, 68, 20, 11) : '';
  return (
    `<g class="sf-leaves">` +
    `<path d="M100 67 C99 59 99 54 100 50" fill="none" stroke="${C.ol}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M100 67 C99 59 99 54 100 50" fill="none" stroke="${C.leaf}" stroke-width="3" stroke-linecap="round"/>` +
    extra +
    leafFrom(99, 52, -40, L, W) +
    leafFrom(101, 52, 40, L, W) +
    `</g>`
  );
}
function feet(): string {
  return (
    `<ellipse cx="84" cy="166" rx="12" ry="8" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>` +
    `<ellipse cx="116" cy="166" rx="12" ry="8" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`
  );
}
function body(): string {
  return `<ellipse cx="100" cy="116" rx="58" ry="54" fill="${C.body}" stroke="${C.ol}" stroke-width="4"/>`;
}
function belly(): string {
  return `<ellipse cx="100" cy="149" rx="31" ry="19" fill="${C.belly}"/>`;
}

// ─── arms ────────────────────────────────────────────────
function restArmL(): string {
  return `<ellipse cx="48" cy="132" rx="9" ry="12" transform="rotate(16 48 132)" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`;
}
function restArmR(): string {
  return `<ellipse cx="152" cy="132" rx="9" ry="12" transform="rotate(-16 152 132)" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`;
}
function handsUp(): string {
  return (
    `<ellipse cx="56" cy="121" rx="10" ry="12" transform="rotate(-20 56 121)" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>` +
    `<ellipse cx="144" cy="121" rx="10" ry="12" transform="rotate(20 144 121)" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`
  );
}
function errorHand(): string {
  return `<ellipse cx="57" cy="121" rx="9" ry="11" transform="rotate(-16 57 121)" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`;
}
function waveArm(anim: boolean): string {
  const g =
    `<path d="M56 124 Q45 111 44 100" fill="none" stroke="${C.ol}" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="M56 124 Q45 111 44 100" fill="none" stroke="${C.body}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="43" cy="99" r="9.5" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`;
  return anim ? `<g class="sf-waveArm">${g}</g>` : g;
}
function thinkArm(): string {
  // Hand resting under the chin (pondering), nudged left.
  const p = 'M60 132 Q71 133 81 129';
  return (
    `<path d="${p}" fill="none" stroke="${C.ol}" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="${p}" fill="none" stroke="${C.body}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="82" cy="128" r="8" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`
  );
}
function thumbArm(anim: boolean): string {
  // Raised rounded fist (no finger) — bobs up/down to cheer.
  const g =
    `<path d="M56 124 Q47 111 46 100" fill="none" stroke="${C.ol}" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="M56 124 Q47 111 46 100" fill="none" stroke="${C.body}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="45" cy="99" r="10" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`;
  return anim ? `<g class="sf-thumbArm">${g}</g>` : g;
}

// ─── eyes / brows / mouths ───────────────────────────────
interface EyeOpts {
  blink?: boolean;
  look?: 'up';
  teary?: boolean;
}
function eye(cx: number, o: EyeOpts): string {
  const dy = o.look === 'up' ? -1.5 : 0;
  const hlr = o.teary ? 3.4 : 2.8;
  const inner =
    `<ellipse cx="${cx}" cy="${EYEY + dy}" rx="8.2" ry="9.6" fill="${C.eye}"/>` +
    `<circle cx="${cx - 2.8}" cy="${EYEY - 4 + dy}" r="${hlr}" fill="#fff"/>` +
    (o.teary ? `<circle cx="${cx + 3}" cy="${EYEY + 2 + dy}" r="1.6" fill="#fff" opacity=".8"/>` : '');
  return o.blink ? `<g class="sf-eye">${inner}</g>` : inner;
}
function happyEye(cx: number): string {
  return `<path d="M${cx - 9} ${EYEY + 3} Q${cx} ${EYEY - 6} ${cx + 9} ${EYEY + 3}" fill="none" stroke="${C.ol}" stroke-width="3" stroke-linecap="round"/>`;
}
function sleepEye(cx: number): string {
  return `<path d="M${cx - 8} ${EYEY - 1} Q${cx} ${EYEY + 6} ${cx + 8} ${EYEY - 1}" fill="none" stroke="${C.ol}" stroke-width="2.6" stroke-linecap="round"/>`;
}
function winkEye(cx: number): string {
  return `<path d="M${cx - 9} ${EYEY + 2} Q${cx} ${EYEY - 7} ${cx + 9} ${EYEY + 2}" fill="none" stroke="${C.ol}" stroke-width="3" stroke-linecap="round"/>`;
}
function wideEye(cx: number): string {
  return (
    `<ellipse cx="${cx}" cy="${EYEY}" rx="8.4" ry="10" fill="#fff" stroke="${C.ol}" stroke-width="2.6"/>` +
    `<ellipse cx="${cx}" cy="${EYEY + 1.5}" rx="3.4" ry="3.8" fill="${C.eye}"/>`
  );
}
function heartEye(cx: number): string {
  return `<g class="sf-beat"><path fill="${C.heart}" d="${heartPath(cx, EYEY + 1, 8.5)}"/></g>`;
}
function brows(style: 'worried' | 'raised'): string {
  if (style === 'worried')
    return (
      `<path d="M${LX - 9} ${BROW + 1} Q${LX - 1} ${BROW - 4} ${LX + 8} ${BROW - 4}" fill="none" stroke="${C.ol}" stroke-width="2.4" stroke-linecap="round"/>` +
      `<path d="M${RX + 9} ${BROW + 1} Q${RX + 1} ${BROW - 4} ${RX - 8} ${BROW - 4}" fill="none" stroke="${C.ol}" stroke-width="2.4" stroke-linecap="round"/>`
    );
  return (
    `<path d="M${LX - 8} ${BROW - 4} Q${LX} ${BROW - 9} ${LX + 8} ${BROW - 4}" fill="none" stroke="${C.ol}" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M${RX - 8} ${BROW - 4} Q${RX} ${BROW - 9} ${RX + 8} ${BROW - 4}" fill="none" stroke="${C.ol}" stroke-width="2.4" stroke-linecap="round"/>`
  );
}
function blush(strong?: boolean): string {
  const rx = strong ? 9 : 8,
    ry = strong ? 6 : 5.2;
  return `<ellipse cx="65" cy="117" rx="${rx}" ry="${ry}" fill="${C.blush}"/><ellipse cx="135" cy="117" rx="${rx}" ry="${ry}" fill="${C.blush}"/>`;
}
function mouthSmile(): string {
  return `<path d="M89 ${MY} Q100 ${MY + 9} 111 ${MY}" fill="none" stroke="${C.ol}" stroke-width="2.6" stroke-linecap="round"/>`;
}
function mouthOpen(): string {
  return `<path d="M91 ${MY - 1} Q100 ${MY + 11} 109 ${MY - 1} Q100 ${MY + 4} 91 ${MY - 1} Z" fill="${C.mouth}" stroke="${C.ol}" stroke-width="2.2" stroke-linejoin="round"/>`;
}
function mouthLaugh(): string {
  return `<path d="M86 ${MY - 2} Q100 ${MY + 2} 114 ${MY - 2} Q112 ${MY + 16} 100 ${MY + 17} Q88 ${MY + 16} 86 ${MY - 2} Z" fill="${C.mouth}" stroke="${C.ol}" stroke-width="2.4" stroke-linejoin="round"/><path d="M92 ${MY + 9} Q100 ${MY + 17} 108 ${MY + 9} Z" fill="${C.tongue}"/>`;
}
function mouthThink(): string {
  // Gentle, content pondering mouth (not a frown).
  return `<path d="M92 ${MY} Q100 ${MY + 6} 108 ${MY}" fill="none" stroke="${C.ol}" stroke-width="2.6" stroke-linecap="round"/>`;
}
function mouthWavy(): string {
  return `<path d="M91 ${MY + 1} Q95 ${MY - 3} 99 ${MY + 1} Q104 ${MY + 5} 109 ${MY + 1}" fill="none" stroke="${C.ol}" stroke-width="2.6" stroke-linecap="round"/>`;
}
function mouthO(): string {
  return `<ellipse cx="100" cy="${MY + 2}" rx="6" ry="7.5" fill="${C.mouth}" stroke="${C.ol}" stroke-width="2.4"/>`;
}
function mouthSleep(): string {
  return `<ellipse cx="100" cy="${MY + 1}" rx="5" ry="4" fill="none" stroke="${C.ol}" stroke-width="2.2"/>`;
}

// ─── floating effects ────────────────────────────────────
function star(x: number, y: number, r: number, d: number): string {
  return `<path class="sf-fx-i" style="animation:sf-twinkle 1.6s ${d}s infinite" d="M${x} ${y - r} L${x + r * 0.3} ${y - r * 0.3} L${x + r} ${y} L${x + r * 0.3} ${y + r * 0.3} L${x} ${y + r} L${x - r * 0.3} ${y + r * 0.3} L${x - r} ${y} L${x - r * 0.3} ${y - r * 0.3} Z" fill="${C.spark}"/>`;
}
function fxFor(expr: SproutyFaceExpr): string {
  switch (expr) {
    case 'done':
      return star(42, 74, 7, 0) + star(158, 70, 6, 0.5) + star(150, 150, 5, 0.9) + star(46, 148, 4, 1.3);
    case 'error':
      return `<path class="sf-fx-i" style="animation:sf-tear 1.7s 0s infinite" d="M140 92 Q145 98 140 103 Q135 98 140 92 Z" fill="${C.tear}"/>`;
    case 'sleep':
      return (
        `<text class="sf-fx-i" style="animation:sf-drift 2.4s 0s infinite" x="136" y="96" font-size="14" font-weight="700" fill="${C.zzz}" font-family="sans-serif">z</text>` +
        `<text class="sf-fx-i" style="animation:sf-drift 2.4s .6s infinite" x="149" y="82" font-size="18" font-weight="700" fill="${C.zzz}" font-family="sans-serif">z</text>` +
        `<text class="sf-fx-i" style="animation:sf-drift 2.4s 1.2s infinite" x="163" y="66" font-size="22" font-weight="700" fill="${C.zzz}" font-family="sans-serif">Z</text>`
      );
    case 'thinking':
      return (
        `<circle class="sf-fx-i" style="animation:sf-twinkle 2s 0s infinite" cx="60" cy="80" r="3.5" fill="none" stroke="${C.ol}" stroke-width="2.4"/>` +
        `<circle class="sf-fx-i" style="animation:sf-twinkle 2s .45s infinite" cx="49" cy="65" r="5" fill="none" stroke="${C.ol}" stroke-width="2.6"/>`
      );
    case 'love':
      return (
        `<path class="sf-fx-i" style="animation:sf-floatUp 2.4s 0s infinite" d="${heartPath(150, 98, 7)}" fill="${C.heart}"/>` +
        `<path class="sf-fx-i" style="animation:sf-floatUp 2.4s 1s infinite" d="${heartPath(52, 102, 5)}" fill="#ff8aa4"/>`
      );
    case 'surprise':
      return (
        `<line class="sf-fx-i" style="animation:sf-pop .9s 0s infinite" x1="63" y1="60" x2="55" y2="50" stroke="${C.ol}" stroke-width="3.2" stroke-linecap="round"/>` +
        `<line class="sf-fx-i" style="animation:sf-pop .9s .12s infinite" x1="100" y1="46" x2="100" y2="34" stroke="${C.ol}" stroke-width="3.2" stroke-linecap="round"/>` +
        `<line class="sf-fx-i" style="animation:sf-pop .9s .24s infinite" x1="137" y1="60" x2="145" y2="50" stroke="${C.ol}" stroke-width="3.2" stroke-linecap="round"/>`
      );
    default:
      return '';
  }
}

// ─── compose ─────────────────────────────────────────────
function face(expr: SproutyFaceExpr): string {
  switch (expr) {
    case 'thinking':
      return eye(LX, { look: 'up' }) + eye(RX, { look: 'up' }) + blush() + mouthThink();
    case 'responding':
      return eye(LX, { blink: true }) + eye(RX, { blink: true }) + blush() + mouthOpen();
    case 'done':
      return happyEye(LX) + happyEye(RX) + blush(true) + mouthLaugh();
    case 'error':
      return (
        brows('worried') +
        eye(LX, { look: 'up', teary: true }) +
        eye(RX, { look: 'up', teary: true }) +
        blush(true) +
        mouthWavy()
      );
    case 'sleep':
      return sleepEye(LX) + sleepEye(RX) + blush() + mouthSleep();
    case 'love':
      return heartEye(LX) + heartEye(RX) + blush(true) + mouthOpen();
    case 'thumb':
      return eye(LX, {}) + winkEye(RX) + blush() + mouthOpen();
    case 'surprise':
      return brows('raised') + wideEye(LX) + wideEye(RX) + blush() + mouthO();
    case 'idle':
    default:
      return eye(LX, { blink: true }) + eye(RX, { blink: true }) + blush() + mouthSmile();
  }
}
function behindArms(expr: SproutyFaceExpr): string {
  if (expr === 'idle' || expr === 'sleep') return restArmL() + restArmR();
  if (expr === 'responding' || expr === 'thinking' || expr === 'thumb' || expr === 'error') return restArmR();
  return '';
}
function frontArms(expr: SproutyFaceExpr, anim: boolean): string {
  switch (expr) {
    case 'responding':
      return waveArm(anim);
    case 'thinking':
      return thinkArm();
    case 'thumb':
      return thumbArm(anim);
    case 'error':
      return errorHand();
    case 'done':
    case 'love':
    case 'surprise':
      return handsUp();
    default:
      return '';
  }
}

// ─── accessories (flat; layered held → hat → glasses) ────
// Own colors, deliberately outside the 5 themed hexes so the color remap
// leaves them untouched. Hats sit on the forehead so the sprout still shows.
const AO = '#39423a'; // neutral accessory outline

function accCap(): string {
  return (
    `<path d="M71 84 A29 22 0 0 1 129 84 Z" fill="#4a8ccc" stroke="${AO}" stroke-width="2.4" stroke-linejoin="round"/>` +
    `<ellipse cx="113" cy="85" rx="20" ry="6" transform="rotate(6 113 85)" fill="#3f79b0" stroke="${AO}" stroke-width="2.4"/>` +
    `<circle cx="100" cy="63" r="3" fill="#3f79b0" stroke="${AO}" stroke-width="1.4"/>`
  );
}
function accCrown(): string {
  return (
    `<path d="M74 85 L74 73 L85 79 L92 65 L100 76 L108 65 L115 79 L126 73 L126 85 Z" fill="#f5c542" stroke="#c8992a" stroke-width="2.2" stroke-linejoin="round"/>` +
    `<circle cx="100" cy="82" r="2.4" fill="#e8556f"/><circle cx="86" cy="83" r="2" fill="#5aa0e0"/><circle cx="114" cy="83" r="2" fill="#5aa0e0"/>`
  );
}
function accGraduation(): string {
  return (
    `<path d="M100 55 L133 67 L100 79 L67 67 Z" fill="#33333f" stroke="#171720" stroke-width="1.6" stroke-linejoin="round"/>` +
    `<circle cx="100" cy="67" r="2.4" fill="#f5c542"/>` +
    `<path d="M100 67 L126 74 L126 88" fill="none" stroke="#f5c542" stroke-width="2" stroke-linecap="round"/>` +
    `<circle cx="126" cy="90" r="3" fill="#f5c542"/>`
  );
}
function accHeadset(): string {
  return (
    `<path d="M63 100 Q63 57 100 57 Q137 57 137 100" fill="none" stroke="#4a4a4a" stroke-width="5" stroke-linecap="round"/>` +
    `<rect x="56" y="98" width="13" height="18" rx="5" fill="#565656" stroke="${AO}" stroke-width="2"/>` +
    `<rect x="131" y="98" width="13" height="18" rx="5" fill="#565656" stroke="${AO}" stroke-width="2"/>` +
    `<path d="M62 116 Q60 130 74 132" fill="none" stroke="#4a4a4a" stroke-width="2.5" stroke-linecap="round"/>` +
    `<circle cx="75" cy="132" r="3.2" fill="#6a6a6a" stroke="${AO}" stroke-width="1.4"/>`
  );
}
function accRound(): string {
  return (
    `<circle cx="81" cy="105" r="13" fill="#dbeafe" fill-opacity="0.18" stroke="#5b4a34" stroke-width="2.6"/>` +
    `<circle cx="119" cy="105" r="13" fill="#dbeafe" fill-opacity="0.18" stroke="#5b4a34" stroke-width="2.6"/>` +
    `<path d="M94 104 Q100 100 106 104" fill="none" stroke="#5b4a34" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M68 104 L60 101" stroke="#5b4a34" stroke-width="2.4" stroke-linecap="round"/>` +
    `<path d="M132 104 L140 101" stroke="#5b4a34" stroke-width="2.4" stroke-linecap="round"/>`
  );
}
function accSun(): string {
  return (
    `<rect x="67" y="96" width="27" height="17" rx="6" fill="#26303a" stroke="#12181e" stroke-width="2"/>` +
    `<rect x="106" y="96" width="27" height="17" rx="6" fill="#26303a" stroke="#12181e" stroke-width="2"/>` +
    `<path d="M94 100 Q100 98 106 100" fill="none" stroke="#12181e" stroke-width="2.6" stroke-linecap="round"/>` +
    `<path d="M71 101 L86 101" stroke="#4a5560" stroke-width="1.6" stroke-linecap="round" opacity="0.7"/>`
  );
}
function accCoffee(): string {
  return (
    `<rect x="157" y="133" width="16" height="15" rx="3" fill="#f2e8d2" stroke="#8a6e50" stroke-width="2"/>` +
    `<rect x="159" y="135" width="12" height="7" rx="1.5" fill="#6b3e26"/>` +
    `<path d="M173 137 Q180 138 178 144 Q177 146 173 145" fill="none" stroke="#8a6e50" stroke-width="2"/>` +
    `<path d="M162 130 Q160 126 163 123" fill="none" stroke="#cfcfcf" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/>` +
    `<path d="M168 130 Q170 126 167 123" fill="none" stroke="#cfcfcf" stroke-width="1.6" stroke-linecap="round" opacity="0.8"/>`
  );
}
function accWrench(): string {
  return (
    `<g transform="rotate(-28 165 140)"><rect x="162" y="132" width="6" height="20" rx="3" fill="#9aa2ad" stroke="${AO}" stroke-width="1.6"/>` +
    `<path d="M159 132 L161 124 L165 129 L170 129 L173 124 L171 132 Z" fill="#b6bcc6" stroke="${AO}" stroke-width="1.6" stroke-linejoin="round"/></g>`
  );
}
function accMagnifier(): string {
  return (
    `<circle cx="162" cy="135" r="9" fill="#bfe0ff" fill-opacity="0.3" stroke="#5b4a34" stroke-width="3"/>` +
    `<circle cx="159" cy="132" r="2.4" fill="#ffffff" opacity="0.7"/>` +
    `<path d="M169 142 L177 150" stroke="#8a6e50" stroke-width="3.4" stroke-linecap="round"/>`
  );
}
function accPencil(): string {
  return (
    `<g transform="rotate(38 165 139)"><rect x="162" y="125" width="6" height="20" rx="1" fill="#f5c542" stroke="#c8992a" stroke-width="1.4"/>` +
    `<path d="M162 145 L168 145 L165 151 Z" fill="#f0d8b0" stroke="#c8992a" stroke-width="1.2" stroke-linejoin="round"/>` +
    `<path d="M164 149 L166 149 L165 151.5 Z" fill="#333"/>` +
    `<rect x="162" y="121" width="6" height="4" rx="1" fill="#e86080"/></g>`
  );
}
function accClipboard(): string {
  return (
    `<rect x="156" y="128" width="19" height="24" rx="2.5" fill="#c4956a" stroke="#8a6e50" stroke-width="2"/>` +
    `<rect x="159" y="132" width="13" height="17" rx="1" fill="#ffffff"/>` +
    `<rect x="162" y="126" width="7" height="5" rx="1.5" fill="#8a8a8a" stroke="${AO}" stroke-width="1.2"/>` +
    `<path d="M162 137 H169 M162 141 H169 M162 145 H166" stroke="#cfcfcf" stroke-width="1.4" stroke-linecap="round"/>`
  );
}
function accChart(): string {
  return (
    `<rect x="155" y="128" width="22" height="22" rx="2.5" fill="#f6f6f4" stroke="#cfcfcf" stroke-width="1.6"/>` +
    `<rect x="159" y="140" width="3.6" height="7" fill="#5eb8d6"/>` +
    `<rect x="164" y="136" width="3.6" height="11" fill="#7cc142"/>` +
    `<rect x="169" y="133" width="3.6" height="14" fill="#d6a45e"/>` +
    `<path d="M158 131 V147 H174" fill="none" stroke="#b8b8b8" stroke-width="1.3"/>`
  );
}

const ACCESSORY_FNS: Record<string, () => string> = {
  crown: accCrown,
  cap: accCap,
  graduation: accGraduation,
  headset: accHeadset,
  'round-glasses': accRound,
  sunglasses: accSun,
  coffee: accCoffee,
  wrench: accWrench,
  magnifier: accMagnifier,
  pencil: accPencil,
  clipboard: accClipboard,
  chart: accChart,
};
const HELD_IDS = ['coffee', 'wrench', 'magnifier', 'pencil', 'clipboard', 'chart'];
const HAT_IDS = ['crown', 'cap', 'graduation', 'headset'];
const GLASS_IDS = ['round-glasses', 'sunglasses'];

function renderAccessories(ids?: string[]): string {
  if (!ids || !ids.length) return '';
  const has = (id: string) => ids.includes(id);
  let out = '';
  for (const id of HELD_IDS) if (has(id)) out += ACCESSORY_FNS[id]();
  for (const id of HAT_IDS) if (has(id)) out += ACCESSORY_FNS[id]();
  for (const id of GLASS_IDS) if (has(id)) out += ACCESSORY_FNS[id]();
  return out;
}

// ─── build ───────────────────────────────────────────────
export interface SproutyFaceOptions {
  animate?: boolean;
  /** Color preset name from COLOR_PRESETS (undefined/'forest' = default). */
  color?: string;
  /** Accessory ids (see ACCESSORIES): hats, glasses, held items. */
  accessories?: string[];
  /** 'normal' | 'big' | 'mini' | 'double'. */
  leafStyle?: string;
}

/** Build the full inline-SVG markup for one expression + optional customization. */
export function buildSproutyFaceSvg(expr: SproutyFaceExpr, opts: SproutyFaceOptions = {}): string {
  const { animate = true, color, accessories, leafStyle } = opts;
  const cfg = EXPR[expr] || EXPR.idle;
  const inner =
    sprout(leafStyle) +
    feet() +
    behindArms(expr) +
    body() +
    belly() +
    face(expr) +
    frontArms(expr, animate) +
    renderAccessories(accessories);
  const fx = fxFor(expr);
  const motion = animate ? ` sf-m-${cfg.motion}` : '';
  const wrapOpen = cfg.tilt ? `<g transform="${cfg.tilt}">` : '<g>';
  let svg =
    `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" width="100%" height="100%" style="overflow:visible" focusable="false" aria-hidden="true">` +
    `${wrapOpen}<g class="sf-char${motion}">${inner}</g><g class="sf-fx">${fx}</g></g></svg>`;
  const remap = themeRemap(color);
  if (remap) {
    const re = new RegExp(Object.keys(remap).join('|'), 'g');
    svg = svg.replace(re, (m) => remap[m] ?? m);
  }
  return svg;
}

// ─── animation styles (injected once) ────────────────────
const SPROUTY_FACE_CSS = `
.sf-root{display:inline-flex;flex-shrink:0;line-height:0}
.sf-root svg{display:block;width:100%;height:100%}
.sf-char{transform-box:fill-box;transform-origin:50% 95%}
.sf-m-breathe{animation:sf-breathe 3.4s ease-in-out infinite}
.sf-m-breatheSlow{animation:sf-breatheSlow 4.6s ease-in-out infinite}
.sf-m-hop{animation:sf-hop 1.3s ease-in-out infinite}
.sf-m-shake{animation:sf-shake .5s ease-in-out infinite}
.sf-m-thinkbob{animation:sf-thinkbob 3.8s ease-in-out infinite}
.sf-leaves{transform-box:fill-box;transform-origin:50% 100%;animation:sf-sway 3.6s ease-in-out infinite}
.sf-eye{transform-box:fill-box;transform-origin:center;animation:sf-blink 4.6s infinite}
.sf-waveArm{transform-box:fill-box;transform-origin:100% 100%;animation:sf-wave 1.5s ease-in-out infinite}
.sf-thumbArm{transform-box:fill-box;transform-origin:50% 100%;animation:sf-thumbbob 1.4s ease-in-out infinite}
.sf-beat{transform-box:fill-box;transform-origin:center;animation:sf-beat 1s ease-in-out infinite}
.sf-fx-i{transform-box:fill-box;transform-origin:center}
@keyframes sf-breathe{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-1.5px) scale(1.012,.988)}}
@keyframes sf-breatheSlow{0%,100%{transform:translateY(0) scale(1,1)}50%{transform:translateY(-2px) scale(1.008,.99)}}
@keyframes sf-hop{0%,60%,100%{transform:translateY(0) scale(1,1)}20%{transform:translateY(-12px) scale(.97,1.04)}42%{transform:translateY(0) scale(1.04,.96)}}
@keyframes sf-shake{0%,100%{transform:translateX(0) rotate(0)}20%{transform:translateX(-2.5px) rotate(-1.6deg)}60%{transform:translateX(2.5px) rotate(1.6deg)}}
@keyframes sf-thinkbob{0%,100%{transform:rotate(0)}50%{transform:rotate(-3.2deg)}}
@keyframes sf-sway{0%,100%{transform:rotate(-4deg)}50%{transform:rotate(4deg)}}
@keyframes sf-blink{0%,92%,100%{transform:scaleY(1)}96%{transform:scaleY(.1)}}
@keyframes sf-wave{0%,100%{transform:rotate(3deg)}25%{transform:rotate(-14deg)}50%{transform:rotate(7deg)}75%{transform:rotate(-14deg)}}
@keyframes sf-thumbbob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3px)}}
@keyframes sf-beat{0%,100%{transform:scale(1)}50%{transform:scale(1.18)}}
@keyframes sf-floatUp{0%{opacity:0;transform:translateY(5px) scale(.6)}25%{opacity:1}100%{opacity:0;transform:translateY(-16px) scale(1)}}
@keyframes sf-drift{0%{opacity:0;transform:translate(0,5px) scale(.7)}25%{opacity:1}100%{opacity:0;transform:translate(8px,-15px) scale(1.1)}}
@keyframes sf-twinkle{0%,100%{opacity:.2;transform:scale(.7)}50%{opacity:1;transform:scale(1)}}
@keyframes sf-tear{0%{opacity:0;transform:translateY(-2px)}20%{opacity:1}100%{opacity:0;transform:translateY(12px)}}
@keyframes sf-pop{0%{opacity:0;transform:scale(.4)}40%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.15)}}
@media (prefers-reduced-motion: reduce){.sf-root svg *{animation:none!important}}
`;

let stylesInjected = false;
/** Inject the SproutyFace animation stylesheet once per document. SSR-safe. */
export function ensureSproutyFaceStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const el = document.createElement('style');
  el.setAttribute('data-sprouty-face', '');
  el.textContent = SPROUTY_FACE_CSS;
  document.head.appendChild(el);
}

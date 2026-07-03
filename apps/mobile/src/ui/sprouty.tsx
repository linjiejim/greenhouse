/**
 * SproutyFace for React Native — vendored, trimmed port of
 * packages/ui/src/components/sprouty/sprouty-face-svg.ts (canonical source;
 * keep geometry in sync when the web mascot changes).
 *
 * Differences from web: no CSS animations (SvgXml can't run them) — a gentle
 * Reanimated breathing wrapper stands in; the floating-fx layer (stars/tears/
 * zzz) is stripped rather than frozen (a static tear reads as broken); no
 * accessories / color presets (mobile always uses the forest brand palette).
 */

import React, { useEffect } from 'react';
import Animated, { useSharedValue, useAnimatedStyle, withRepeat, withTiming, Easing } from 'react-native-reanimated';
import { SvgXml } from 'react-native-svg';

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

// ─── palette (forest / brand, same as web) ───────────────
const C = {
  body: '#a4d65e',
  belly: '#edf6cf',
  leaf: '#8fce5e',
  vein: '#4f8f2e',
  ol: '#33501f',
  eye: '#22302a',
  blush: '#f3a6ac',
  heart: '#ff6f8f',
  mouth: '#c14a63',
  tongue: '#e07a92',
};
const EYEY = 105,
  LX = 81,
  RX = 119,
  MY = 120,
  BROW = 89;

const TILT: Partial<Record<SproutyFaceExpr, string>> = {
  error: 'rotate(-4 100 152)',
  sleep: 'rotate(-8 100 152) translate(0 3)',
};

// ─── geometry helpers (verbatim from web, minus class/anim attrs) ──
function heartPath(x: number, y: number, s: number): string {
  return `M${x} ${y + s * 0.35} C${x - s * 0.55} ${y - s * 0.45} ${x - s * 1.2} ${y + s * 0.15} ${x} ${y + s * 1.1} C${x + s * 1.2} ${y + s * 0.15} ${x + s * 0.55} ${y - s * 0.45} ${x} ${y + s * 0.35} Z`;
}
function leafFrom(bx: number, by: number, deg: number, L: number, W: number): string {
  const th = (deg * Math.PI) / 180;
  const dx = Math.sin(th),
    dy = -Math.cos(th);
  const px = Math.cos(th),
    py = Math.sin(th);
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
function sprout(): string {
  return (
    `<path d="M100 67 C99 59 99 54 100 50" fill="none" stroke="${C.ol}" stroke-width="6" stroke-linecap="round"/>` +
    `<path d="M100 67 C99 59 99 54 100 50" fill="none" stroke="${C.leaf}" stroke-width="3" stroke-linecap="round"/>` +
    leafFrom(99, 52, -40, 27, 15) +
    leafFrom(101, 52, 40, 27, 15)
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
function waveArm(): string {
  return (
    `<path d="M56 124 Q45 111 44 100" fill="none" stroke="${C.ol}" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="M56 124 Q45 111 44 100" fill="none" stroke="${C.body}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="43" cy="99" r="9.5" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`
  );
}
function thinkArm(): string {
  const p = 'M60 132 Q71 133 81 129';
  return (
    `<path d="${p}" fill="none" stroke="${C.ol}" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="${p}" fill="none" stroke="${C.body}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="82" cy="128" r="8" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`
  );
}
function thumbArm(): string {
  return (
    `<path d="M56 124 Q47 111 46 100" fill="none" stroke="${C.ol}" stroke-width="14" stroke-linecap="round"/>` +
    `<path d="M56 124 Q47 111 46 100" fill="none" stroke="${C.body}" stroke-width="9" stroke-linecap="round"/>` +
    `<circle cx="45" cy="99" r="10" fill="${C.body}" stroke="${C.ol}" stroke-width="3.2"/>`
  );
}

interface EyeOpts {
  look?: 'up';
  teary?: boolean;
}
function eye(cx: number, o: EyeOpts): string {
  const dy = o.look === 'up' ? -1.5 : 0;
  const hlr = o.teary ? 3.4 : 2.8;
  return (
    `<ellipse cx="${cx}" cy="${EYEY + dy}" rx="8.2" ry="9.6" fill="${C.eye}"/>` +
    `<circle cx="${cx - 2.8}" cy="${EYEY - 4 + dy}" r="${hlr}" fill="#fff"/>` +
    (o.teary ? `<circle cx="${cx + 3}" cy="${EYEY + 2 + dy}" r="1.6" fill="#fff" opacity=".8"/>` : '')
  );
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
  return `<path fill="${C.heart}" d="${heartPath(cx, EYEY + 1, 8.5)}"/>`;
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

function face(expr: SproutyFaceExpr): string {
  switch (expr) {
    case 'thinking':
      return eye(LX, { look: 'up' }) + eye(RX, { look: 'up' }) + blush() + mouthThink();
    case 'responding':
      return eye(LX, {}) + eye(RX, {}) + blush() + mouthOpen();
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
      return eye(LX, {}) + eye(RX, {}) + blush() + mouthSmile();
  }
}
function behindArms(expr: SproutyFaceExpr): string {
  if (expr === 'idle' || expr === 'sleep') return restArmL() + restArmR();
  if (expr === 'responding' || expr === 'thinking' || expr === 'thumb' || expr === 'error') return restArmR();
  return '';
}
function frontArms(expr: SproutyFaceExpr): string {
  switch (expr) {
    case 'responding':
      return waveArm();
    case 'thinking':
      return thinkArm();
    case 'thumb':
      return thumbArm();
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

/** Build static SVG markup for one expression (no CSS classes, no fx layer). */
export function buildSproutySvg(expr: SproutyFaceExpr): string {
  const inner = sprout() + feet() + behindArms(expr) + body() + belly() + face(expr) + frontArms(expr);
  const tilt = TILT[expr];
  const wrapOpen = tilt ? `<g transform="${tilt}">` : '<g>';
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">${wrapOpen}${inner}</g></svg>`;
}

const svgCache = new Map<SproutyFaceExpr, string>();
function svgFor(expr: SproutyFaceExpr): string {
  let s = svgCache.get(expr);
  if (!s) {
    s = buildSproutySvg(expr);
    svgCache.set(expr, s);
  }
  return s;
}

/** Sprouty mascot. `breathe` adds a gentle idle motion (default on). */
export function SproutyFace({
  expr = 'idle',
  size = 96,
  breathe = true,
}: {
  expr?: SproutyFaceExpr;
  size?: number;
  breathe?: boolean;
}) {
  const phase = useSharedValue(0);

  useEffect(() => {
    if (!breathe) return;
    phase.value = 0;
    phase.value = withRepeat(withTiming(1, { duration: 1700, easing: Easing.inOut(Easing.quad) }), -1, true);
  }, [breathe, phase]);

  const style = useAnimatedStyle(() => ({
    transform: breathe
      ? [{ translateY: phase.value * -2 }, { scaleX: 1 + phase.value * 0.012 }, { scaleY: 1 - phase.value * 0.012 }]
      : [],
  }));

  return (
    <Animated.View style={[{ width: size, height: size }, style]}>
      <SvgXml xml={svgFor(expr)} width="100%" height="100%" />
    </Animated.View>
  );
}

/**
 * SproutyAvatar — Canvas-based avatar faithfully ported from rounded-sprouty.html.
 *
 * All 11 original expressions preserved. Uses requestAnimationFrame for smooth animation.
 * Agent states map to the most appropriate expression.
 *
 * v2: Accessories rendering (hats, glasses, held items), leaf styles, specialist presets.
 */

import React, { useRef, useEffect, useMemo } from 'react';
import {
  SPROUTY_SIZES,
  COLOR_PRESETS,
  type SproutySize,
  type SproutyState,
  type SproutyVariant,
  type LeafStyle,
} from './sprouty-constants';

// ─── Expression type ─────────────────────────────────────

export type SproutyExpression =
  | 'idle'
  | 'bounce'
  | 'wink'
  | 'happy'
  | 'sleep'
  | 'thirsty'
  | 'water'
  | 'grow'
  | 'hot'
  | 'cold'
  | 'victory';

interface ExprOpts {
  eyeStyle: string;
  mouthStyle: string;
  blush: boolean;
  leafAnim: string;
  bodyAnim: string;
  squash?: boolean;
  sparkle?: boolean;
  hearts?: boolean;
  zzz?: boolean;
  sweat?: boolean;
  bodyColor?: string;
  waterDrop?: boolean;
  bigLeaf?: boolean;
  faceRed?: boolean;
  snow?: boolean;
  flower?: boolean;
}

// ─── All 11 original expressions ─────────────────────────

const EXPRESSIONS: Record<SproutyExpression, ExprOpts> = {
  idle: { eyeStyle: 'normal', mouthStyle: 'smile', blush: true, leafAnim: 'gentle', bodyAnim: 'breathe' },
  bounce: { eyeStyle: 'normal', mouthStyle: 'open', blush: true, leafAnim: 'bounce', bodyAnim: 'bounce', squash: true },
  wink: { eyeStyle: 'wink', mouthStyle: 'cat', blush: true, leafAnim: 'gentle', bodyAnim: 'breathe', sparkle: true },
  happy: {
    eyeStyle: 'happy',
    mouthStyle: 'bigSmile',
    blush: true,
    leafAnim: 'bounce',
    bodyAnim: 'bounce',
    sparkle: true,
    hearts: true,
  },
  sleep: {
    eyeStyle: 'closed',
    mouthStyle: 'sleep',
    blush: true,
    leafAnim: 'droop',
    bodyAnim: 'breatheSlow',
    zzz: true,
  },
  thirsty: {
    eyeStyle: 'sad',
    mouthStyle: 'wavy',
    blush: false,
    leafAnim: 'droop',
    bodyAnim: 'breathe',
    sweat: true,
    bodyColor: 'yellow',
  },
  water: {
    eyeStyle: 'happy',
    mouthStyle: 'bigSmile',
    blush: true,
    leafAnim: 'bounce',
    bodyAnim: 'bounce',
    waterDrop: true,
  },
  grow: {
    eyeStyle: 'star',
    mouthStyle: 'open',
    blush: true,
    leafAnim: 'grow',
    bodyAnim: 'bounce',
    sparkle: true,
    bigLeaf: true,
  },
  hot: {
    eyeStyle: 'dizzy',
    mouthStyle: 'tongue',
    blush: false,
    leafAnim: 'wilt',
    bodyAnim: 'breathe',
    sweat: true,
    faceRed: true,
  },
  cold: {
    eyeStyle: 'squint',
    mouthStyle: 'wavy',
    blush: false,
    leafAnim: 'droop',
    bodyAnim: 'shiver',
    snow: true,
    bodyColor: 'blue',
  },
  victory: {
    eyeStyle: 'happy',
    mouthStyle: 'bigSmile',
    blush: true,
    leafAnim: 'bounce',
    bodyAnim: 'bounce',
    sparkle: true,
    hearts: true,
    flower: true,
  },
};

// ─── Agent state → expression mapping ────────────────────

const STATE_MAP: Record<SproutyState, SproutyExpression> = {
  idle: 'idle',
  thinking: 'wink',
  responding: 'bounce',
  done: 'happy',
  error: 'thirsty',
};

// ─── Color override for custom profiles ──────────────────

interface ColorSet {
  body: [string, string, string, string]; // [main, med, dark, highlight]
  leaf: [string, string, string]; // [main, dark, light]
  outline: string;
}

function resolveColorSet(color?: string, _variant?: SproutyVariant): ColorSet | null {
  if (!color || color === 'forest') return null; // use default
  const p = COLOR_PRESETS[color];
  if (!p) return null;
  return {
    body: [p.body, adjustBr(p.body, -0.1), p.bodyDark, p.bodyHighlight],
    leaf: [p.leaf, p.leafDark, p.leafLight],
    outline: adjustBr(p.bodyDark, -0.3),
  };
}

function adjustBr(hex: string, f: number): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const a = (v: number) => Math.min(255, Math.max(0, Math.round(v + v * f)));
  return `#${a(r).toString(16).padStart(2, '0')}${a(g).toString(16).padStart(2, '0')}${a(b).toString(16).padStart(2, '0')}`;
}

// ═══════════════════════════════════════════════════════════
//  Canvas drawing engine — faithful port from rounded-sprouty
// ═══════════════════════════════════════════════════════════

const PI = Math.PI,
  TAU = PI * 2;

function ellipse(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  fill?: string | CanvasGradient | null,
  stroke?: string | null,
  lw?: number,
) {
  ctx.beginPath();
  ctx.ellipse(cx, cy, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, TAU);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill();
  }
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw || 2;
    ctx.stroke();
  }
}

function bezierCurve(ctx: CanvasRenderingContext2D, pts: number[][], color: string, lw?: number) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lw || 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  if (pts.length === 3) ctx.quadraticCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1]);
  else if (pts.length === 4) ctx.bezierCurveTo(pts[1][0], pts[1][1], pts[2][0], pts[2][1], pts[3][0], pts[3][1]);
  else for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.stroke();
}

function heartShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, sz: number, color: string, opa: number) {
  ctx.save();
  ctx.globalAlpha = opa || 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy + sz * 0.4);
  ctx.bezierCurveTo(cx - sz * 0.5, cy - sz * 0.2, cx - sz, cy + sz * 0.1, cx, cy + sz);
  ctx.bezierCurveTo(cx + sz, cy + sz * 0.1, cx + sz * 0.5, cy - sz * 0.2, cx, cy + sz * 0.4);
  ctx.fill();
  ctx.restore();
}

function star4(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, opa: number) {
  ctx.save();
  ctx.globalAlpha = opa || 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i * PI) / 4 - PI / 2,
      rr = i % 2 === 0 ? r : r * 0.38;
    if (i === 0) ctx.moveTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    else ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function leafShape(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  angle: number,
  fill: string,
  stroke: string | null,
) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, -h / 2);
  ctx.quadraticCurveTo(w / 2, 0, 0, h / 2);
  ctx.quadraticCurveTo(-w / 2, 0, 0, -h / 2);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.restore();
}

function dropShape(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, opa: number) {
  ctx.save();
  ctx.globalAlpha = opa || 1;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(cx, cy - r * 1.4);
  ctx.quadraticCurveTo(cx + r, cy, cx, cy + r * 0.5);
  ctx.quadraticCurveTo(cx - r, cy, cx, cy - r * 1.4);
  ctx.fill();
  ctx.restore();
}

// ═══════════════════════════════════════════════════════════
//  Accessory drawing functions
// ═══════════════════════════════════════════════════════════

function drawCrown(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  const w = 28 * s,
    h = 18 * s;
  const top = cy - h;
  ctx.save();
  ctx.fillStyle = '#f8d848';
  ctx.strokeStyle = '#c8a828';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy);
  ctx.lineTo(cx - w / 2, top + h * 0.4);
  ctx.lineTo(cx - w * 0.25, top + h * 0.6);
  ctx.lineTo(cx, top);
  ctx.lineTo(cx + w * 0.25, top + h * 0.6);
  ctx.lineTo(cx + w / 2, top + h * 0.4);
  ctx.lineTo(cx + w / 2, cy);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Gems
  ellipse(ctx, cx, top + h * 0.6, 2.5 * s, 2.5 * s, '#e84060', null);
  ellipse(ctx, cx - w * 0.25, top + h * 0.7, 2 * s, 2 * s, '#60a0e8', null);
  ellipse(ctx, cx + w * 0.25, top + h * 0.7, 2 * s, 2 * s, '#60a0e8', null);
  ctx.restore();
}

function drawCap(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  // Cap body
  ctx.fillStyle = '#4488cc';
  ctx.strokeStyle = '#336699';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.ellipse(cx, cy - 2 * s, 26 * s, 14 * s, 0, PI, 0);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Brim
  ctx.fillStyle = '#336699';
  ctx.beginPath();
  ctx.ellipse(cx + 12 * s, cy - 1 * s, 20 * s, 5 * s, 0.15, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = '#2a5580';
  ctx.stroke();
  // Button on top
  ellipse(ctx, cx, cy - 15 * s, 3 * s, 3 * s, '#5599dd', '#336699', 1 * s);
  ctx.restore();
}

function drawGraduationCap(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  // Flat board (diamond shape)
  ctx.fillStyle = '#2a2a2a';
  ctx.strokeStyle = '#1a1a1a';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 14 * s);
  ctx.lineTo(cx + 30 * s, cy - 4 * s);
  ctx.lineTo(cx, cy + 4 * s);
  ctx.lineTo(cx - 30 * s, cy - 4 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  // Base block
  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.ellipse(cx, cy + 1 * s, 18 * s, 8 * s, 0, PI, 0);
  ctx.closePath();
  ctx.fill();
  // Tassel
  ctx.strokeStyle = '#f8d848';
  ctx.lineWidth = 2 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx, cy - 4 * s);
  ctx.lineTo(cx + 22 * s, cy + 6 * s);
  ctx.lineTo(cx + 22 * s, cy + 16 * s);
  ctx.stroke();
  // Tassel end
  ellipse(ctx, cx + 22 * s, cy + 17 * s, 3 * s, 3 * s, '#f8d848', null);
  ctx.restore();
}

function drawHeadset(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, outline: string) {
  ctx.save();
  // Headband arc
  ctx.strokeStyle = '#444';
  ctx.lineWidth = 3.5 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(cx, cy + 8 * s, 30 * s, PI + 0.3, -0.3);
  ctx.stroke();
  // Left ear cup
  ctx.fillStyle = '#555';
  ctx.strokeStyle = outline;
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, cx - 35 * s, cy + 2 * s, 12 * s, 16 * s, 4 * s);
  ctx.fill();
  ctx.stroke();
  // Right ear cup
  roundRect(ctx, cx + 23 * s, cy + 2 * s, 12 * s, 16 * s, 4 * s);
  ctx.fill();
  ctx.stroke();
  // Mic boom
  ctx.strokeStyle = '#666';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.moveTo(cx - 30 * s, cy + 14 * s);
  ctx.quadraticCurveTo(cx - 28 * s, cy + 28 * s, cx - 16 * s, cy + 30 * s);
  ctx.stroke();
  // Mic head
  ellipse(ctx, cx - 15 * s, cy + 30 * s, 4 * s, 4 * s, '#777', '#555', 1 * s);
  ctx.restore();
}

function drawRoundGlasses(ctx: CanvasRenderingContext2D, lex: number, rex: number, ey: number, s: number) {
  ctx.save();
  ctx.strokeStyle = '#5D4037';
  ctx.lineWidth = 2 * s;
  // Left lens
  ctx.beginPath();
  ctx.arc(lex, ey, 14 * s, 0, TAU);
  ctx.stroke();
  // Right lens
  ctx.beginPath();
  ctx.arc(rex, ey, 14 * s, 0, TAU);
  ctx.stroke();
  // Bridge
  ctx.beginPath();
  ctx.moveTo(lex + 14 * s, ey - 2 * s);
  ctx.quadraticCurveTo((lex + rex) / 2, ey - 6 * s, rex - 14 * s, ey - 2 * s);
  ctx.stroke();
  // Lens tint (very subtle)
  ellipse(ctx, lex, ey, 13 * s, 13 * s, 'rgba(200,220,255,0.12)', null);
  ellipse(ctx, rex, ey, 13 * s, 13 * s, 'rgba(200,220,255,0.12)', null);
  ctx.restore();
}

function drawSunglasses(ctx: CanvasRenderingContext2D, lex: number, rex: number, ey: number, s: number) {
  ctx.save();
  // Left lens
  ctx.fillStyle = 'rgba(30,30,60,0.85)';
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 2.5 * s;
  roundRect(ctx, lex - 16 * s, ey - 10 * s, 32 * s, 20 * s, 6 * s);
  ctx.fill();
  ctx.stroke();
  // Right lens
  roundRect(ctx, rex - 16 * s, ey - 10 * s, 32 * s, 20 * s, 6 * s);
  ctx.fill();
  ctx.stroke();
  // Bridge
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.moveTo(lex + 16 * s, ey - 3 * s);
  ctx.quadraticCurveTo((lex + rex) / 2, ey - 7 * s, rex - 16 * s, ey - 3 * s);
  ctx.stroke();
  // Glare
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1.5 * s;
  ctx.beginPath();
  ctx.moveTo(lex - 8 * s, ey - 6 * s);
  ctx.lineTo(lex + 2 * s, ey - 6 * s);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(rex - 8 * s, ey - 6 * s);
  ctx.lineTo(rex + 2 * s, ey - 6 * s);
  ctx.stroke();
  ctx.restore();
}

function drawCoffee(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, t: number) {
  ctx.save();
  // Cup
  ctx.fillStyle = '#f0e6d0';
  ctx.strokeStyle = '#8a6e50';
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, cx - 8 * s, cy - 6 * s, 16 * s, 16 * s, 3 * s);
  ctx.fill();
  ctx.stroke();
  // Coffee inside
  ctx.fillStyle = '#6b3e26';
  roundRect(ctx, cx - 6 * s, cy - 3 * s, 12 * s, 10 * s, 2 * s);
  ctx.fill();
  // Handle
  ctx.strokeStyle = '#8a6e50';
  ctx.lineWidth = 2 * s;
  ctx.beginPath();
  ctx.arc(cx + 12 * s, cy + 2 * s, 5 * s, -PI / 2, PI / 2);
  ctx.stroke();
  // Steam
  for (let i = 0; i < 2; i++) {
    const st = (t * 0.8 + i * 1.2) % 2;
    const sopa = st < 0.3 ? st / 0.3 : st > 1.4 ? (2 - st) / 0.6 : 0.5;
    const sx = cx + (i - 0.5) * 6 * s;
    const sy = cy - 8 * s - st * 10 * s;
    ctx.strokeStyle = `rgba(180,180,180,${sopa})`;
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(sx + 3 * s * Math.sin(st * PI), sy - 5 * s, sx, sy - 10 * s);
    ctx.stroke();
  }
  ctx.restore();
}

function drawWrench(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.4);
  // Handle
  ctx.fillStyle = '#888';
  ctx.strokeStyle = '#555';
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, -3 * s, -2 * s, 6 * s, 22 * s, 2 * s);
  ctx.fill();
  ctx.stroke();
  // Head
  ctx.fillStyle = '#aaa';
  ctx.beginPath();
  ctx.moveTo(-6 * s, -2 * s);
  ctx.lineTo(-8 * s, -10 * s);
  ctx.lineTo(-3 * s, -6 * s);
  ctx.lineTo(3 * s, -6 * s);
  ctx.lineTo(8 * s, -10 * s);
  ctx.lineTo(6 * s, -2 * s);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawMagnifier(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(0.4);
  // Glass
  ctx.strokeStyle = '#5D4037';
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.arc(0, -5 * s, 9 * s, 0, TAU);
  ctx.stroke();
  // Lens tint
  ellipse(ctx, 0, -5 * s, 8 * s, 8 * s, 'rgba(200,230,255,0.25)', null);
  // Glare
  ellipse(ctx, -3 * s, -8 * s, 2.5 * s, 2.5 * s, 'rgba(255,255,255,0.4)', null);
  // Handle
  ctx.strokeStyle = '#8a6e50';
  ctx.lineWidth = 3.5 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(6 * s, 2 * s);
  ctx.lineTo(14 * s, 12 * s);
  ctx.stroke();
  ctx.restore();
}

function drawPencil(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(-0.3);
  // Body
  ctx.fillStyle = '#f8d848';
  ctx.strokeStyle = '#c8a020';
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, -3 * s, -14 * s, 6 * s, 22 * s, 1 * s);
  ctx.fill();
  ctx.stroke();
  // Tip
  ctx.fillStyle = '#f0d8b0';
  ctx.beginPath();
  ctx.moveTo(-3 * s, 8 * s);
  ctx.lineTo(3 * s, 8 * s);
  ctx.lineTo(0, 14 * s);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#c8a020';
  ctx.stroke();
  // Lead
  ctx.fillStyle = '#333';
  ctx.beginPath();
  ctx.moveTo(-1 * s, 12 * s);
  ctx.lineTo(1 * s, 12 * s);
  ctx.lineTo(0, 15 * s);
  ctx.closePath();
  ctx.fill();
  // Eraser
  ctx.fillStyle = '#e86080';
  roundRect(ctx, -3 * s, -17 * s, 6 * s, 4 * s, 1 * s);
  ctx.fill();
  // Metal band
  ctx.fillStyle = '#bbb';
  roundRect(ctx, -3.5 * s, -14 * s, 7 * s, 2 * s, 0.5 * s);
  ctx.fill();
  ctx.restore();
}

function drawClipboard(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number) {
  ctx.save();
  // Board
  ctx.fillStyle = '#c4956a';
  ctx.strokeStyle = '#8a6e50';
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, cx - 10 * s, cy - 12 * s, 20 * s, 26 * s, 3 * s);
  ctx.fill();
  ctx.stroke();
  // Paper
  ctx.fillStyle = '#fff';
  roundRect(ctx, cx - 7 * s, cy - 6 * s, 14 * s, 18 * s, 1 * s);
  ctx.fill();
  // Clip
  ctx.fillStyle = '#888';
  roundRect(ctx, cx - 5 * s, cy - 14 * s, 10 * s, 6 * s, 2 * s);
  ctx.fill();
  ctx.strokeStyle = '#666';
  ctx.stroke();
  // Text lines
  ctx.fillStyle = '#ccc';
  for (let i = 0; i < 4; i++) {
    const lw = i === 3 ? 6 : 10;
    roundRect(ctx, cx - 5 * s, cy - 2 * s + i * 4 * s, lw * s, 1.5 * s, 0.5 * s);
    ctx.fill();
  }
  ctx.restore();
}

function drawChart(ctx: CanvasRenderingContext2D, cx: number, cy: number, s: number, t: number) {
  ctx.save();
  // Background
  ctx.fillStyle = '#f5f5f5';
  ctx.strokeStyle = '#ccc';
  ctx.lineWidth = 1.5 * s;
  roundRect(ctx, cx - 10 * s, cy - 10 * s, 20 * s, 20 * s, 2 * s);
  ctx.fill();
  ctx.stroke();
  // Bars
  const heights = [8, 14, 10, 16];
  const colors = ['#5eb8d6', '#a4d65e', '#d6a45e', '#a45ed6'];
  const bw = 3.5 * s;
  for (let i = 0; i < 4; i++) {
    const bh = heights[i] * s * (0.8 + Math.sin(t * 2 + i) * 0.2);
    const bx = cx - 8 * s + i * 4.5 * s;
    const by = cy + 8 * s - bh;
    ctx.fillStyle = colors[i];
    roundRect(ctx, bx, by, bw, bh, 1 * s);
    ctx.fill();
  }
  // Axes
  ctx.strokeStyle = '#999';
  ctx.lineWidth = 1 * s;
  ctx.beginPath();
  ctx.moveTo(cx - 9 * s, cy - 8 * s);
  ctx.lineTo(cx - 9 * s, cy + 8 * s);
  ctx.lineTo(cx + 9 * s, cy + 8 * s);
  ctx.stroke();
  ctx.restore();
}

// ─── roundRect helper ────────────────────────────────────

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Main draw (ported exactly, transparent bg) ──────────

function drawSprouty(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  opts: ExprOpts,
  cs?: ColorSet | null,
  accessories?: string[],
  leafStyleOpt?: LeafStyle,
) {
  const cx = W / 2,
    cy = H * 0.54,
    s = W / 240;
  ctx.clearRect(0, 0, W, H);

  // Colors (default or override)
  const CC = {
    body1: cs ? cs.body[0] : '#a4d65e',
    body2: cs ? cs.body[1] : '#8abe48',
    body3: cs ? cs.body[2] : '#6a9e30',
    body4: cs ? cs.body[3] : '#c4ee78',
    outline: cs ? cs.outline : '#2a4a18',
    leaf1: cs ? cs.leaf[0] : '#6abf4b',
    leaf2: cs ? cs.leaf[1] : '#4a8f2b',
    leaf3: cs ? cs.leaf[2] : '#8adf6b',
    eyeW: '#ffffff',
    eyeB: '#1a1a2a',
    blush: '#f0a0a0',
    heart: '#e84060',
    water: '#60a0e8',
    spark: '#f8e858',
    zzz: '#8090a0',
    snow: '#c0d8f0',
    sweat: '#80b8e8',
  };

  // Anim values
  let ox = 0,
    oy = 0,
    sx = 1,
    sy = 1;
  if (opts.bodyAnim === 'bounce') {
    oy = Math.abs(Math.sin(t * 4)) * -16 * s;
    sx = 1 + Math.sin(t * 4 + PI) * 0.06;
    sy = 1 - Math.sin(t * 4 + PI) * 0.06;
  } else if (opts.bodyAnim === 'breathe') {
    oy = Math.sin(t * 2) * 4 * s;
    sx = 1 + Math.sin(t * 1.8) * 0.025;
    sy = 1 - Math.sin(t * 1.8) * 0.025;
  } else if (opts.bodyAnim === 'breatheSlow') {
    oy = Math.sin(t) * 6 * s;
  } else if (opts.bodyAnim === 'shiver') {
    ox = (Math.random() - 0.5) * 6 * s;
    oy = (Math.random() - 0.5) * 3 * s;
  }
  if (opts.squash) {
    sx = 1 + Math.sin(t * 4) * 0.1;
    sy = 1 - Math.sin(t * 4) * 0.1;
  }
  const bcx = cx + ox,
    bcy = cy + oy;
  const brx = 48 * s * sx,
    bry = 52 * s * sy;

  // Body colors (expression overrides)
  let bMain = CC.body1,
    bDark = CC.body3,
    bHi = CC.body4,
    bMed = CC.body2;
  if (opts.bodyColor === 'yellow') {
    bMain = '#c8c858';
    bDark = '#989830';
    bHi = '#e8e878';
    bMed = '#b0b048';
  } else if (opts.bodyColor === 'blue') {
    bMain = '#88b8c8';
    bDark = '#608898';
    bHi = '#a8d8e8';
    bMed = '#78a8b8';
  }

  // Resolve leaf style
  const leafScale = leafStyleOpt === 'big' || opts.bigLeaf ? 1.4 : leafStyleOpt === 'mini' ? 0.7 : 1;
  const drawDoubleLeaf = leafStyleOpt === 'double';

  // ── Leaf ──
  let lDroop = 0,
    lWave = Math.sin(t * 2) * 8 * s;
  if (opts.leafAnim === 'droop') {
    lDroop = 15 * s;
    lWave = 0;
  } else if (opts.leafAnim === 'wilt') {
    lDroop = 22 * s;
    lWave = 0;
  } else if (opts.leafAnim === 'bounce') {
    lWave = Math.sin(t * 5) * 12 * s;
  } else if (opts.leafAnim === 'grow') {
    lWave = Math.sin(t * 3) * 8 * s;
  }

  ctx.save();
  ctx.translate(bcx, bcy - bry + 4 * s);
  ctx.rotate((((lDroop + lWave) * PI) / 180) * 0.15);

  ctx.strokeStyle = CC.leaf2;
  ctx.lineWidth = 4 * s;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(-2 * s + lWave * 0.2, -18 * s + lDroop * 0.3, 2 * s + lWave * 0.15, -32 * s + lDroop);
  ctx.stroke();

  const lf = leafScale;
  leafShape(
    ctx,
    -12 * s * lf,
    -22 * s + lDroop * 0.4,
    20 * s * lf,
    12 * s * lf,
    -0.5 + lWave * 0.01,
    CC.leaf1,
    CC.leaf2,
  );
  leafShape(ctx, -10 * s * lf, -22 * s + lDroop * 0.4, 14 * s * lf, 7 * s * lf, -0.5 + lWave * 0.01, CC.leaf3, null);
  leafShape(ctx, 14 * s * lf, -26 * s + lDroop * 0.5, 20 * s * lf, 12 * s * lf, 0.4 - lWave * 0.01, CC.leaf1, CC.leaf2);
  leafShape(ctx, 12 * s * lf, -26 * s + lDroop * 0.5, 14 * s * lf, 7 * s * lf, 0.4 - lWave * 0.01, CC.leaf3, null);
  ellipse(ctx, 2 * s, -34 * s + lDroop, 5 * s * lf, 6 * s * lf, CC.leaf1, CC.leaf2, 1.5);

  // Double leaf: extra pair on opposite side
  if (drawDoubleLeaf) {
    leafShape(ctx, 16 * s, -18 * s + lDroop * 0.3, 18 * s, 10 * s, 0.6 - lWave * 0.01, CC.leaf1, CC.leaf2);
    leafShape(ctx, -18 * s, -28 * s + lDroop * 0.6, 18 * s, 10 * s, -0.6 + lWave * 0.01, CC.leaf1, CC.leaf2);
  }

  if (opts.flower) {
    const bloom = 0.6 + Math.sin(t * 2) * 0.4;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * TAU - PI / 2;
      ellipse(
        ctx,
        2 * s + Math.cos(a) * 8 * s,
        -34 * s + lDroop + Math.sin(a) * 8 * s,
        6 * s,
        8 * s,
        `rgba(240,160,176,${bloom})`,
        null,
      );
    }
    ellipse(ctx, 2 * s, -34 * s + lDroop, 5 * s, 5 * s, '#f8e858', null);
  }
  ctx.restore();

  // ── Shadow ──
  ellipse(ctx, bcx, bcy + bry - 2 * s, brx * 0.8, 8 * s, 'rgba(0,0,0,0.15)', null);

  // ── Body ──
  if (opts.sparkle && opts.hearts) {
    const gopa = 0.06 + Math.sin(t * 2) * 0.03;
    ellipse(ctx, bcx, bcy, brx * 1.25, bry * 1.25, `rgba(248,232,88,${gopa})`, null);
  }

  ctx.save();
  ctx.translate(bcx, bcy);
  ctx.scale(sx, sy);
  ctx.translate(-bcx, -bcy);
  const bodyGrad = ctx.createRadialGradient(bcx - brx * 0.25, bcy - bry * 0.3, 0, bcx, bcy, brx * 1.1);
  bodyGrad.addColorStop(0, bHi);
  bodyGrad.addColorStop(0.45, bMain);
  bodyGrad.addColorStop(0.8, bMed);
  bodyGrad.addColorStop(1, bDark);
  ellipse(ctx, bcx, bcy, brx, bry, bodyGrad, CC.outline, 3 * s);
  ellipse(ctx, bcx - brx * 0.22, bcy - bry * 0.28, brx * 0.35, bry * 0.3, 'rgba(255,255,255,0.18)', null);
  ellipse(ctx, bcx - brx * 0.45, bcy + bry * 0.85, 10 * s, 6 * s, bDark, CC.outline, 2 * s);
  ellipse(ctx, bcx + brx * 0.45, bcy + bry * 0.85, 10 * s, 6 * s, bDark, CC.outline, 2 * s);
  ctx.restore();

  // ── Face ──
  const eyeY = bcy - 8 * s + oy * 0.2;
  const lex = bcx - 20 * s + ox * 0.3,
    rex = bcx + 20 * s + ox * 0.3;
  const ew = 13 * s,
    eh = 15 * s,
    pw = 6 * s,
    ph = 7 * s;

  // Check if glasses should replace eye rendering
  const hasGlasses = accessories?.includes('round-glasses') || accessories?.includes('sunglasses');

  function drawEye(ex: number, ey: number, isRight: boolean) {
    if (opts.eyeStyle === 'normal') {
      ellipse(ctx, ex, ey, ew, eh, CC.eyeW, '#5D4037', 2 * s);
      ellipse(ctx, ex + 2 * s, ey + 2 * s, pw, ph + 1 * s, CC.eyeB, null);
      ellipse(ctx, ex - 2 * s, ey - 3 * s, 3.5 * s, 3.5 * s, '#fff', null);
      ellipse(ctx, ex + 3 * s, ey + 2 * s, 1.8 * s, 1.8 * s, 'rgba(255,255,255,0.5)', null);
    } else if (opts.eyeStyle === 'happy') {
      bezierCurve(
        ctx,
        [
          [ex - ew, ey],
          [ex, ey - eh * 0.55],
          [ex + ew, ey],
        ],
        CC.eyeB,
        3 * s,
      );
    } else if (opts.eyeStyle === 'closed') {
      bezierCurve(
        ctx,
        [
          [ex - ew * 0.8, ey],
          [ex + ew * 0.8, ey],
        ],
        CC.eyeB,
        3 * s,
      );
    } else if (opts.eyeStyle === 'wink') {
      if (!isRight) {
        ellipse(ctx, ex, ey, ew, eh, CC.eyeW, '#5D4037', 2 * s);
        ellipse(ctx, ex + 2 * s, ey + 2 * s, pw, ph, CC.eyeB, null);
        ellipse(ctx, ex - 2 * s, ey - 3 * s, 3.5 * s, 3.5 * s, '#fff', null);
      } else {
        bezierCurve(
          ctx,
          [
            [ex - ew, ey],
            [ex, ey - eh * 0.5],
            [ex + ew, ey],
          ],
          CC.eyeB,
          3 * s,
        );
      }
    } else if (opts.eyeStyle === 'sad') {
      ellipse(ctx, ex, ey, ew, eh * 1.1, CC.eyeW, '#5D4037', 2 * s);
      ellipse(ctx, ex, ey + 3 * s, pw + 2 * s, ph + 2 * s, CC.eyeB, null);
      ellipse(ctx, ex - 2 * s, ey - 3 * s, 3 * s, 3 * s, '#fff', null);
      const dir = isRight ? 1 : -1;
      bezierCurve(
        ctx,
        [
          [ex - 8 * s * dir, ey - eh - 3 * s],
          [ex + 6 * s * dir, ey - eh - 8 * s],
        ],
        CC.eyeB,
        2.5 * s,
      );
    } else if (opts.eyeStyle === 'star') {
      ellipse(ctx, ex, ey, ew, eh, CC.eyeW, '#5D4037', 2 * s);
      const glow = 0.7 + Math.sin(t * 6) * 0.3;
      star4(ctx, ex, ey, ph * 0.9, CC.spark, glow);
      ellipse(ctx, ex, ey, 2.5 * s, 2.5 * s, CC.eyeB, null);
    } else if (opts.eyeStyle === 'dizzy') {
      const xr = 8 * s;
      bezierCurve(
        ctx,
        [
          [ex - xr, ey - xr],
          [ex + xr, ey + xr],
        ],
        CC.eyeB,
        3 * s,
      );
      bezierCurve(
        ctx,
        [
          [ex - xr, ey + xr],
          [ex + xr, ey - xr],
        ],
        CC.eyeB,
        3 * s,
      );
    } else if (opts.eyeStyle === 'squint') {
      ellipse(ctx, ex, ey, ew * 0.9, eh * 0.3, CC.eyeW, '#5D4037', 2 * s);
      ellipse(ctx, ex, ey, pw * 0.6, ph * 0.2, CC.eyeB, null);
    }
  }
  drawEye(lex, eyeY, false);
  drawEye(rex, eyeY, true);

  // ── Glasses (drawn over eyes) ──
  if (accessories?.includes('round-glasses')) {
    drawRoundGlasses(ctx, lex, rex, eyeY, s);
  } else if (accessories?.includes('sunglasses')) {
    drawSunglasses(ctx, lex, rex, eyeY, s);
  }

  // Blush
  if (opts.blush && !hasGlasses) {
    ellipse(ctx, lex - 14 * s, eyeY + 14 * s, 10 * s, 6 * s, CC.blush, null);
    ctx.globalAlpha = 1;
    ellipse(ctx, rex + 14 * s, eyeY + 14 * s, 10 * s, 6 * s, CC.blush, null);
  } else if (opts.blush && hasGlasses) {
    // Blush slightly lower with glasses
    ellipse(ctx, lex - 14 * s, eyeY + 18 * s, 8 * s, 5 * s, CC.blush, null);
    ctx.globalAlpha = 1;
    ellipse(ctx, rex + 14 * s, eyeY + 18 * s, 8 * s, 5 * s, CC.blush, null);
  }
  if (opts.faceRed) {
    const ropa = 0.5 + Math.sin(t * 3) * 0.15;
    ellipse(ctx, lex - 16 * s, eyeY + 14 * s, 14 * s, 9 * s, `rgba(200,80,50,${ropa})`, null);
    ellipse(ctx, rex + 16 * s, eyeY + 14 * s, 14 * s, 9 * s, `rgba(200,80,50,${ropa})`, null);
  }

  // Mouth
  const my = bcy + 18 * s + oy * 0.3;
  const mw = 16 * s;
  if (opts.mouthStyle === 'smile') {
    bezierCurve(
      ctx,
      [
        [bcx - mw, my],
        [bcx, my + 8 * s],
        [bcx + mw, my],
      ],
      CC.eyeB,
      2.5 * s,
    );
  } else if (opts.mouthStyle === 'bigSmile') {
    ctx.beginPath();
    ctx.moveTo(bcx - mw * 1.1, my);
    ctx.quadraticCurveTo(bcx, my + 14 * s, bcx + mw * 1.1, my);
    ctx.strokeStyle = CC.eyeB;
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';
    ctx.stroke();
    ctx.quadraticCurveTo(bcx, my + 10 * s, bcx - mw * 1.1, my);
    ctx.fillStyle = '#c04040';
    ctx.fill();
  } else if (opts.mouthStyle === 'open') {
    ellipse(ctx, bcx, my, 8 * s, 9 * s, CC.eyeB, null);
    ellipse(ctx, bcx, my, 6 * s, 7 * s, '#c04040', null);
  } else if (opts.mouthStyle === 'cat') {
    bezierCurve(
      ctx,
      [
        [bcx - 6 * s, my + 4 * s],
        [bcx - 2 * s, my],
        [bcx, my + 4 * s],
      ],
      CC.eyeB,
      2.5 * s,
    );
    bezierCurve(
      ctx,
      [
        [bcx, my + 4 * s],
        [bcx + 2 * s, my],
        [bcx + 6 * s, my + 4 * s],
      ],
      CC.eyeB,
      2.5 * s,
    );
  } else if (opts.mouthStyle === 'sleep') {
    ellipse(ctx, bcx, my, 6 * s, 5 * s, null, CC.eyeB, 2 * s);
  } else if (opts.mouthStyle === 'wavy') {
    const pts: number[][] = [];
    for (let i = 0; i <= 8; i++) pts.push([bcx - mw + i * ((mw * 2) / 8), my + Math.sin(i * 1.5) * 4 * s]);
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = CC.eyeB;
    ctx.lineWidth = 2.5 * s;
    ctx.lineCap = 'round';
    ctx.stroke();
  } else if (opts.mouthStyle === 'tongue') {
    ellipse(ctx, bcx, my, 10 * s, 9 * s, CC.eyeB, null);
    ellipse(ctx, bcx, my + 4 * s, 7 * s, 7 * s, '#e06060', null);
  }

  // ── Hat accessories (drawn above everything else on the body) ──
  const hatY = bcy - bry + 4 * s + oy;
  if (accessories?.includes('crown')) {
    drawCrown(ctx, bcx, hatY - 4 * s, s);
  }
  if (accessories?.includes('cap')) {
    drawCap(ctx, bcx, hatY - 2 * s, s);
  }
  if (accessories?.includes('graduation')) {
    drawGraduationCap(ctx, bcx, hatY - 6 * s, s);
  }
  if (accessories?.includes('headset')) {
    drawHeadset(ctx, bcx, bcy - bry * 0.6 + oy, s, CC.outline);
  }

  // ── Held items (drawn beside the feet) ──
  const heldY = bcy + bry * 0.5 + oy;
  const heldRx = bcx + brx * 0.7;
  const heldLx = bcx - brx * 0.7;
  if (accessories?.includes('coffee')) {
    drawCoffee(ctx, heldRx + 8 * s, heldY, s, t);
  }
  if (accessories?.includes('wrench')) {
    drawWrench(ctx, heldLx - 10 * s, heldY - 4 * s, s);
  }
  if (accessories?.includes('magnifier')) {
    drawMagnifier(ctx, heldRx + 10 * s, heldY - 6 * s, s);
  }
  if (accessories?.includes('pencil')) {
    drawPencil(ctx, heldRx + 10 * s, heldY - 8 * s, s);
  }
  if (accessories?.includes('clipboard')) {
    drawClipboard(ctx, heldLx - 12 * s, heldY - 6 * s, s);
  }
  if (accessories?.includes('chart')) {
    drawChart(ctx, heldRx + 12 * s, heldY - 2 * s, s, t);
  }

  // ── Effects ──
  if (opts.sparkle) {
    for (let i = 0; i < 5; i++) {
      const st = (t * 1.5 + i * 1.2) % 3;
      if (st > 2.5) continue;
      const a = (i / 5) * TAU + t * 0.5,
        d = (65 + Math.sin(st) * 16) * s;
      const sx2 = bcx + Math.cos(a) * d,
        sy2 = bcy - 10 * s + Math.sin(a) * d * 0.65;
      const sopa = st < 0.2 ? st / 0.2 : st > 2 ? 3 - st : 1;
      star4(ctx, sx2, sy2, (4 + st * 2) * s, CC.spark, sopa * 0.9);
    }
  }
  if (opts.hearts) {
    for (let i = 0; i < 3; i++) {
      const ht = (t * 0.7 + i * 1.2) % 3;
      const side = i % 2 === 0 ? -1 : 1;
      const hx2 = bcx + side * (40 + ht * 10) * s,
        hy2 = bcy - (35 + ht * 25) * s;
      const hopa = ht < 0.2 ? ht / 0.2 : ht > 2 ? 3 - ht : 1;
      if (hy2 > 10) heartShape(ctx, hx2, hy2, (8 + ht * 2) * s, CC.heart, hopa * 0.85);
    }
  }
  if (opts.zzz) {
    const fonts = [18, 14, 11];
    ['Z', 'z', 'z'].forEach((ch, i) => {
      const zt = (t * 0.5 + i * 0.6) % 3;
      const zopa = zt < 0.3 ? zt / 0.3 : zt > 2 ? 3 - zt : 1;
      const zx2 = bcx + (35 + i * 14) * s - zt * 8 * s,
        zy2 = bcy - (40 + zt * 18 + i * 18) * s;
      if (zy2 > 5) {
        ctx.save();
        ctx.globalAlpha = zopa * 0.7;
        ctx.font = `${fonts[i] * s}px sans-serif`;
        ctx.fillStyle = CC.zzz;
        ctx.textAlign = 'center';
        ctx.fillText(ch, zx2, zy2);
        ctx.restore();
      }
    });
  }
  if (opts.sweat) {
    const swt = (t * 1.2) % 2;
    const sopa = swt < 0.2 ? swt / 0.2 : swt > 1.4 ? (2 - swt) / 0.6 : 1;
    dropShape(ctx, bcx + 42 * s, eyeY - 12 * s + swt * 30 * s, 5 * s, CC.sweat, sopa * 0.8);
  }
  if (opts.snow) {
    ctx.font = `${14 * s}px sans-serif`;
    ctx.textAlign = 'center';
    for (let i = 0; i < 7; i++) {
      const ft = (t * 0.35 + i * 0.65) % 3;
      const fopa = ft < 0.3 ? ft / 0.3 : ft > 2.2 ? (3 - ft) / 0.8 : 1;
      const fx = bcx + (-60 + i * 20) * s + Math.sin(t + i) * 8 * s;
      const fy = 20 * s + ft * 55 * s;
      ctx.save();
      ctx.globalAlpha = fopa * 0.6;
      ctx.fillStyle = CC.snow;
      ctx.fillText('❄', fx, fy);
      ctx.restore();
    }
  }
  if (opts.waterDrop) {
    for (let i = 0; i < 4; i++) {
      const wt = (t * 0.8 + i * 1) % 2.5;
      const wopa = wt < 0.2 ? wt / 0.2 : wt > 1.8 ? (2.5 - wt) / 0.7 : 1;
      const wx = bcx + (i - 1.5) * 25 * s,
        wy = bcy - 70 * s + wt * 40 * s;
      if (wy < bcy - bry) dropShape(ctx, wx, wy, 5 * s, CC.water, wopa * 0.7);
    }
  }
}

// ═══════════════════════════════════════════════════════════
//  React component
// ═══════════════════════════════════════════════════════════

export interface SproutyAvatarProps {
  /** Direct expression (overrides state) */
  expression?: SproutyExpression;
  /** Agent state — mapped to expression */
  state?: SproutyState;
  variant?: SproutyVariant;
  /** Color preset name from COLOR_PRESETS */
  color?: string;
  /** Accessory IDs to render */
  accessories?: string[];
  /** Leaf style */
  leafStyle?: LeafStyle;
  size?: SproutySize;
  animate?: boolean;
  className?: string;
}

export function SproutyAvatar({
  expression,
  state = 'idle',
  variant = 'default',
  color,
  accessories,
  leafStyle,
  size = 'md',
  animate = true,
  className = '',
}: SproutyAvatarProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef(0);
  const timeRef = useRef(0);

  const px = SPROUTY_SIZES[size];
  const canvasSize = px * 2; // 2x for retina sharpness

  const opts = useMemo<ExprOpts>(() => {
    if (expression) return EXPRESSIONS[expression] || EXPRESSIONS.idle;
    return EXPRESSIONS[STATE_MAP[state] || 'idle'];
  }, [expression, state]);

  // Apply variant tweaks
  const finalOpts = useMemo<ExprOpts>(() => {
    if (variant === 'team') return { ...opts, flower: true };
    return opts;
  }, [opts, variant]);

  const colorSet = useMemo(() => resolveColorSet(color, variant), [color, variant]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let running = true;

    function frame() {
      if (!running || !ctx) return;
      timeRef.current += 1 / 30;
      drawSprouty(ctx, canvasSize, canvasSize, timeRef.current, finalOpts, colorSet, accessories, leafStyle);
      if (animate) {
        animRef.current = requestAnimationFrame(frame);
      }
    }

    frame();

    return () => {
      running = false;
      cancelAnimationFrame(animRef.current);
    };
  }, [canvasSize, finalOpts, colorSet, animate, accessories, leafStyle]);

  return (
    <div
      className={`inline-flex items-center justify-center flex-shrink-0 ${className}`}
      style={{ width: px, height: px }}
    >
      <canvas ref={canvasRef} width={canvasSize} height={canvasSize} style={{ width: px, height: px }} />
    </div>
  );
}

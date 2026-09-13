import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getThemeDefinition } from './theme.js';

/**
 * Contrast guardrail for the appearance tokens.
 *
 * These assertions exist because the light palette silently regressed once: the
 * "selected" tokens were drawn from the same brand wash the neutral surfaces are
 * made of, so `--t-primary-subtle` ended up byte-identical to `--t-surface` and a
 * selected chip differed from its unselected neighbour by 1.01:1. Nothing failed —
 * not lint, not typecheck, not a render test — because every one of those files was
 * "correctly" using the semantic token. Only a human squinting at the Schedule
 * picker caught it.
 *
 * So the test deliberately asserts *relationships between adjacent colours*, not
 * token identity. Two tokens being byte-identical is fine when they never touch;
 * what matters is whether a user can tell selected from unselected where they do.
 */

const CSS = readFileSync(new URL('../app.css', import.meta.url), 'utf8');

/** Pull one `--name: value;` declaration out of a specific rule block. */
function readBlock(selector: string): Map<string, string> {
  const start = CSS.indexOf(selector);
  if (start < 0) throw new Error(`theme block not found: ${selector}`);
  const open = CSS.indexOf('{', start);
  // Token blocks contain no nested braces, so the first `}` closes them.
  const close = CSS.indexOf('\n}', open);
  const body = CSS.slice(open + 1, close);
  const out = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out.set(name, value.trim());
  return out;
}

const light = readBlock('/* ─── Light (default) ─── */\n:root');
const dark = readBlock('/* ─── Dark ─── */\n.dark-theme');

/** Resolve a token to `[r,g,b,a]`, following `rgb(var(--primary-N) / a)` indirection. */
function rgba(block: Map<string, string>, token: string): [number, number, number, number] {
  const raw = block.get(token);
  if (!raw) throw new Error(`missing token ${token}`);
  const hex = raw.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const ref = raw.match(/^rgb\(var\((--[\w-]+)\)(?:\s*\/\s*([\d.]+))?\)$/);
  if (!ref) throw new Error(`unsupported token form for ${token}: ${raw}`);
  // The brand ramp lives in the light block only; both themes reference it.
  const ramp = (light.get(ref[1]) ?? dark.get(ref[1]))!.split(/\s+/).map(Number);
  return [ramp[0], ramp[1], ramp[2], ref[2] ? Number(ref[2]) : 1];
}

/** Composite a possibly-translucent token over an opaque backdrop. */
function flatten(fg: [number, number, number, number], bg: [number, number, number, number]) {
  return fg.map((v, i) => v * fg[3] + bg[i] * (1 - fg[3])).slice(0, 3) as [number, number, number];
}

const channel = (c: number) => {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ([r, g, b]: [number, number, number]) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** CIE L* — perceived lightness. Contrast ratio is blind to small steps near white. */
const lightness = (rgb: [number, number, number]) => {
  const y = luminance(rgb);
  return y > 0.008856 ? 116 * Math.cbrt(y) - 16 : 903.3 * y;
};

const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function theme(block: Map<string, string>) {
  const canvas = rgba(block, '--t-surface-canvas');
  const solid = (token: string) => flatten(rgba(block, token), canvas);
  return { solid, canvas: flatten(canvas, canvas) };
}

/** Every neutral surface a selected control can plausibly sit on or next to. */
const NEUTRAL_SURFACES = [
  '--t-surface-canvas',
  '--t-surface-card',
  '--t-surface-sunken',
  '--t-surface',
  '--t-surface-chrome',
  '--t-surface-muted',
] as const;

describe.each([
  ['light', light],
  ['dark', dark],
])('%s appearance tokens', (name, block) => {
  const { solid } = theme(block);

  it('keeps the selected label readable at tag/chip sizes', () => {
    const label = solid('--t-primary-fg-strong');
    for (const fill of ['--t-primary-subtle', '--t-primary-subtle-hover'] as const) {
      expect(ratio(label, solid(fill)), `--t-primary-fg-strong on ${fill} in ${name}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('shows a focus indicator against the page', () => {
    expect(ratio(solid('--t-focus-ring'), solid('--t-surface-canvas'))).toBeGreaterThanOrEqual(3);
  });
});

/*
 * The two themes express selection through different mechanisms, so they get
 * different invariants — asserting one bar for both would be a lie in one direction
 * or the other. Light uses opaque tints that have to carve a step out of a 4 L*
 * band of near-white surfaces. Dark uses translucent green over near-black, where
 * the same overlay reads strongly and the surrounding surface does half the work.
 */
describe('light selection state', () => {
  const { solid } = theme(light);

  it('keeps the selected fill perceptibly off every neutral surface', () => {
    // The reported bug measured 0.6 L* against the sunken track the chips sit on —
    // and 0.0 against `--t-surface`, which it was byte-identical to. 3 L* is roughly
    // where a side-by-side step stops being deniable.
    const selected = lightness(solid('--t-primary-subtle'));
    for (const surface of NEUTRAL_SURFACES) {
      const delta = Math.abs(selected - lightness(solid(surface)));
      expect(delta, `--t-primary-subtle vs ${surface}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('carries selected state on the edge, which is what WCAG 1.4.11 measures', () => {
    // No light fill reaches 3:1 against a white-ish neighbour and still takes dark
    // green text (the best candidate tops out near 1.26:1), so the edge is the
    // load-bearing indicator and has to clear 3:1 on every adjacency it has.
    const edge = solid('--t-primary-edge');
    const adjacencies = [
      '--t-primary-subtle',
      '--t-primary-subtle-hover',
      '--t-surface-canvas',
      '--t-surface-sunken',
    ] as const;
    for (const against of adjacencies) {
      expect(ratio(edge, solid(against)), `--t-primary-edge vs ${against}`).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps the prose wash lighter than the selection fill', () => {
    // Inline code and @-mentions opt out of the state-strength fill so running text
    // is not half-highlighted. If they ever converge, prose gets the loud treatment.
    expect(lightness(solid('--t-primary-wash'))).toBeGreaterThan(lightness(solid('--t-primary-subtle')));
  });
});

describe('dark selection state', () => {
  const canvas = rgba(dark, '--t-surface-canvas');
  const overlay = rgba(dark, '--t-primary-subtle');

  it('lifts the selected chip off the track it sits on', () => {
    // A selected chip paints its overlay over the dialog (`surface-raised`) while its
    // unselected sibling shows the bare `surface-sunken` track. That pairing is what
    // the user actually compares, and it measures 1.30:1 today.
    const selected = flatten(overlay, rgba(dark, '--t-surface-raised'));
    expect(ratio(selected, flatten(rgba(dark, '--t-surface-sunken'), canvas))).toBeGreaterThanOrEqual(1.25);
  });

  it('uses a translucent overlay, not a fixed tint', () => {
    // Dark's whole escape from the light-mode bug is that the fill composites over
    // whatever it lands on. Freezing it to an opaque hex would reintroduce the
    // "selected looks like the surface" failure on some surfaces and not others.
    expect(overlay[3]).toBeLessThan(1);
  });

  // Not asserted, deliberately: dark's `--t-primary-edge` is only 1.18:1 against its
  // own fill. It is a weaker cue than light's, and dark was left untouched by the
  // 2026-08-25 pass because the reported defect was light-only. Raising it is a
  // separate visual-design call, not something this guardrail should imply was done.
});

describe('token source parity', () => {
  // app.css is the pre-JS default; lib/theme.ts writes inline styles at runtime and
  // wins. They duplicate the same hexes with nothing keeping them in sync, so a
  // divergence shows up as a colour flash on first paint — invisible in review.
  it.each([
    ['light', light],
    ['dark', dark],
  ])('%s app.css matches lib/theme.ts', (key, block) => {
    const surface = getThemeDefinition(key as 'light' | 'dark').surface;
    const pairs: Array<[string, string]> = [
      ['--t-surface-canvas', surface.canvas],
      ['--t-surface-chrome', surface.chrome],
      ['--t-surface', surface.surface],
      ['--t-surface-card', surface.surfaceCard],
      ['--t-surface-raised', surface.surfaceRaised],
      ['--t-surface-muted', surface.surfaceMuted],
      ['--t-surface-sunken', surface.surfaceSunken],
      ['--t-fg', surface.fg],
      ['--t-fg-secondary', surface.fgSecondary],
      ['--t-fg-muted', surface.fgMuted],
      ['--t-fg-faint', surface.fgFaint],
      ['--t-edge', surface.edge],
      ['--t-edge-strong', surface.edgeStrong],
    ];
    for (const [token, expected] of pairs) {
      expect(block.get(token)?.toLowerCase(), token).toBe(expected.toLowerCase());
    }
  });
});

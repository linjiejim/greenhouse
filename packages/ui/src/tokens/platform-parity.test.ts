/**
 * Web and mobile resolve the same value for every shared role. Reads what each platform actually
 * loads — the generated CSS the web imports and the palette the app builds from its generated copy —
 * so a hand edit on either side, or app.css redefining a token, fails here.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { darkHex, lightHex, type HexPalette } from '../../../../apps/client/src/theme/palette';
import { flatten } from './contrast';
import { WEB_CSS_PATH } from './render';
import type { ThemeMode } from './tokens';

const ROOT = resolve(__dirname, '../../../..');
const CSS = readFileSync(resolve(ROOT, WEB_CSS_PATH), 'utf8');
const APP_CSS = readFileSync(resolve(ROOT, 'apps/web/src/app.css'), 'utf8');

function declarations(selector: string, nth = 0): Map<string, string> {
  let start = -1;
  for (let i = 0; i <= nth; i++) start = CSS.indexOf(`\n${selector} {`, start + 1);
  if (start < 0) throw new Error(`block not found: ${selector}`);
  const body = CSS.slice(CSS.indexOf('{', start) + 1, CSS.indexOf('\n}', start));
  return new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name!, value!.trim()]));
}

const ramp = declarations(':root', 0);
const modes: Record<ThemeMode, Map<string, string>> = {
  light: declarations(':root', 1),
  dark: declarations('.dark-theme'),
};

/** A web variable as a comparable colour: ramp references resolved, translucent values kept as rgba. */
function web(mode: ThemeMode, name: string): string {
  const raw = modes[mode].get(name);
  if (!raw) throw new Error(`missing ${name} (${mode})`);
  const ref = /^rgb\(var\((--primary-\d+)\)(?:\s*\/\s*([\d.]+))?\)$/.exec(raw);
  if (!ref) return normalize(raw);
  const [r, g, b] = ramp.get(ref[1]!)!.split(/\s+/).map(Number);
  return ref[2] ? normalize(`rgba(${r}, ${g}, ${b}, ${ref[2]})`) : normalize(`rgb(${r}, ${g}, ${b})`);
}

function normalize(value: string): string {
  if (value.startsWith('rgba')) return value.replace(/\s+/g, '');
  return flatten(value);
}

// Mobile key → web variable, for every role both platforms draw.
const SHARED: Array<[keyof HexPalette, string]> = [
  ['accent', '--t-accent'],
  ['onAccent', '--t-on-accent'],
  ['accentFill', '--t-primary-subtle'],
  ['accentText', '--t-primary-fg'],
  ['link', '--t-primary-fg'],
  ['mark', '--t-brand-mark'],
  ['seed', '--t-brand-seed'],
  ['label', '--t-fg'],
  ['secondaryLabel', '--t-fg-secondary'],
  ['tertiaryLabel', '--t-fg-muted'],
  ['placeholder', '--t-fg-muted'],
  ['secondaryBackground', '--t-surface-chrome'],
  ['red', '--t-danger'],
  ['redFill', '--t-danger-subtle'],
  ['orange', '--t-warning'],
  ['orangeFill', '--t-warning-subtle'],
  ['green', '--t-success'],
  ['greenFill', '--t-success-subtle'],
  ['blue', '--t-info'],
  ['blueFill', '--t-info-subtle'],
];

// Light surfaces are the same family on both platforms; dark mobile keeps the iOS system base.
const LIGHT_ONLY: Array<[keyof HexPalette, string]> = [
  ['background', '--t-surface'],
  ['groupedBackground', '--t-surface-chrome'],
  ['secondaryGroupedBackground', '--t-surface-raised'],
];

describe('web ↔ mobile token parity', () => {
  for (const [mode, palette] of [
    ['light', lightHex],
    ['dark', darkHex],
  ] as const) {
    for (const [key, variable] of [...SHARED, ...(mode === 'light' ? LIGHT_ONLY : [])]) {
      it(`${mode}: mobile ${key} = web ${variable}`, () => {
        expect(normalize(palette[key])).toBe(web(mode, variable));
      });
    }
  }

  it('dark grouped cells on mobile are the web chrome layer', () => {
    expect(normalize(darkHex.secondaryGroupedBackground)).toBe(web('dark', '--t-surface-chrome'));
  });

  it('app.css defines no token values of its own (they come from tokens.css)', () => {
    const own = [...APP_CSS.matchAll(/^\s*(--t-[\w-]+|--primary-\d+):/gm)].map((m) => m[1]);
    expect(own).toEqual([]);
  });
});

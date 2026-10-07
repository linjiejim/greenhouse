/**
 * RN PlantAvatar rules (plant-avatar-native.ts). Runs in the ROOT vitest unit project (the mobile
 * app has no test runner; these helpers are React-free on purpose).
 */

import { describe, expect, it } from 'vitest';
import { IDLE_CYCLES, forSvgXml, motionFor, pivotOrigin } from './plant-avatar-native';
import { buildPlantAvatarSvg } from './plant-avatar-svg';
import { PLANT_PRESETS } from './plant-catalogue';
import { PLANT_IDS } from './plant-ids';

describe('motionFor (spec §6 animation budget on mobile)', () => {
  it('nods only while thinking and breathes only at hero size', () => {
    expect(motionFor('thinking', 44)).toBe('nod');
    expect(motionFor('idle', 84)).toBe('breathe');
    expect(motionFor(undefined, 84)).toBe('breathe');
    expect(motionFor('idle', 79)).toBeNull();
    expect(motionFor('idle', 32)).toBeNull();
  });

  it('keeps every other state on its static pose, aliases included', () => {
    for (const s of ['error', 'done', 'waiting', 'sleep', 'speaking', 'working', 'needs_you', 'paused'] as const) {
      expect(motionFor(s, 120), s).toBeNull();
      expect(motionFor(s, 120, true), s).toBeNull();
    }
    expect(motionFor('unread', 84)).toBe('breathe'); // unread idles
  });

  it('lets lists opt out and small idle avatars opt in', () => {
    expect(motionFor('thinking', 44, false)).toBeNull();
    expect(motionFor('idle', 120, false)).toBeNull();
    expect(motionFor('idle', 32, true)).toBe('breathe');
  });

  it('caps ambient breathing', () => {
    expect(IDLE_CYCLES).toBe(3);
  });
});

describe('pivotOrigin', () => {
  it('lands on the species pivot exactly where the builder draws it', () => {
    for (const plant of PLANT_IDS) {
      for (const size of [24, 44, 84]) {
        const svg = buildPlantAvatarSvg({ plant, size });
        const m = /<g transform="translate\(50 50\) scale\(([\d.]+)\) translate\((-?[\d.]+) (-?[\d.]+)\)">/.exec(svg);
        expect(m, `${plant}@${size}`).not.toBeNull();
        const [s, tx, ty] = m!.slice(1).map(Number) as [number, number, number];
        const [px, py] = PLANT_PRESETS[plant].pivot;
        const [ox, oy, oz] = pivotOrigin(plant, size);
        // the builder rounds its scale to 3 decimals and its offsets to 1
        expect(ox).toBeCloseTo(((50 + s * (px + tx)) * size) / 100, 1);
        expect(oy).toBeCloseTo(((50 + s * (py + ty)) * size) / 100, 1);
        expect(oz).toBe(0);
      }
    }
  });
});

describe('forSvgXml', () => {
  it('drops the web-only root hooks SvgXml would forward as props, and nothing else', () => {
    const svg = buildPlantAvatarSvg({ plant: 'sprout', state: 'thinking', size: 44, theme: 'dark' });
    const out = forSvgXml(svg);
    const root = /^<svg[^>]*>/.exec(out)![0];
    expect(root).toBe('<svg viewBox="0 0 100 100" width="44" height="44" xmlns="http://www.w3.org/2000/svg">');
    expect(out.slice(root.length)).toBe(svg.slice(/^<svg[^>]*>/.exec(svg)![0].length));
    expect(out).not.toMatch(/\bclass=|aria-|focusable=/);
  });
});

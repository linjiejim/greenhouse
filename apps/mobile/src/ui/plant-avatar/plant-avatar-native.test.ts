/**
 * RN PlantAvatar rules (plant-avatar-native.ts). Runs in the ROOT vitest unit project (the mobile
 * app has no test runner; these helpers are React-free on purpose).
 */

import { describe, expect, it } from 'vitest';
import {
  BLINK_MS,
  FLOAT_RISE_MS,
  FLOAT_SETTLE_MS,
  floatDelay,
  floatLift,
  floatRest,
  faceShift,
  forSvgXml,
  blinksIn,
  glancesIn,
  lifeRandom,
  mouthBeat,
  nextBlink,
  nextGlance,
  motionFor,
  motionSeed,
  pivotOrigin,
} from './plant-avatar-native';
import { buildPlantAvatarSvg } from './plant-avatar-svg';
import { PLANT_PRESETS } from './plant-catalogue';
import { PLANT_IDS } from './plant-ids';

describe('motionFor (the motion budget on mobile)', () => {
  it('plays each state its own motion when asked to animate', () => {
    expect(motionFor('idle', 26, true)).toBe('float');
    expect(motionFor('thinking', 26, true)).toBe('nod');
    expect(motionFor('speaking', 26, true)).toBe('talk');
    expect(motionFor('waiting', 26, true)).toBe('lean');
    expect(motionFor('done', 26, true)).toBe('perk');
    expect(motionFor('error', 26, true)).toBe('droop');
    expect(motionFor('hello', 64, true)).toBe('hop');
    expect(motionFor('sleep', 80, true)).toBeNull(); // asleep holds still
  });

  it('maps product aliases through their state', () => {
    expect(motionFor('working', 26, true)).toBe('talk');
    expect(motionFor('needs_you', 26, true)).toBe('lean');
    expect(motionFor('archived', 26, true)).toBeNull();
    expect(motionFor('unread', 26, true)).toBe('float');
  });

  it('keeps the old default when unset: thinking nods, idle floats only at hero size', () => {
    expect(motionFor('thinking', 44)).toBe('nod');
    expect(motionFor('idle', 84)).toBe('float');
    expect(motionFor(undefined, 84)).toBe('float');
    expect(motionFor('idle', 79)).toBeNull();
    for (const s of ['error', 'done', 'waiting', 'sleep', 'speaking', 'hello'] as const) {
      expect(motionFor(s, 120), s).toBeNull();
    }
  });

  it('never moves a list avatar', () => {
    for (const s of ['idle', 'thinking', 'speaking', 'waiting', 'done', 'error', 'hello', 'sleep'] as const) {
      expect(motionFor(s, 32, false), s).toBeNull();
    }
  });
});

describe('the idle float', () => {
  it('rises a point or so at list sizes and never more than 3pt', () => {
    expect(floatLift(18)).toBe(1);
    expect(floatLift(26)).toBeCloseTo(1.17, 2);
    expect(floatLift(64)).toBeCloseTo(2.88, 2);
    expect(floatLift(120)).toBe(3);
  });

  it('rests longer than it moves, so the screen is mostly still', () => {
    const seed = motionSeed('bot_abc');
    for (let n = 0; n < 20; n += 1) {
      const rest = floatRest(seed, n);
      expect(rest).toBeGreaterThanOrEqual(2200);
      expect(rest).toBeLessThanOrEqual(5200);
    }
    expect(FLOAT_RISE_MS + FLOAT_SETTLE_MS).toBeLessThan(4000);
  });

  it('offsets every Bot differently and the same Bot the same way', () => {
    expect(motionSeed('bot_a')).toBe(motionSeed('bot_a'));
    const delays = ['bot_a', 'bot_b', 'bot_c', 'bot_d'].map((id) => floatDelay(motionSeed(id)));
    expect(new Set(delays).size).toBe(4);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(400);
      expect(d).toBeLessThanOrEqual(2400);
    }
    expect(motionSeed(undefined)).toBe(0.5);
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

describe('the face\'s own life', () => {
  it('blinks with open eyes only, and glances only at rest or thinking', () => {
    expect(['float', 'nod', 'talk', 'lean'].every((m) => blinksIn(m as never))).toBe(true);
    expect(['perk', 'droop', 'hop'].some((m) => blinksIn(m as never))).toBe(false);
    expect(glancesIn('float') && glancesIn('nod')).toBe(true);
    expect(glancesIn('talk') || glancesIn('lean') || glancesIn('droop')).toBe(false);
  });

  it('keeps blinks natural: short, every few seconds, the odd double', () => {
    expect(BLINK_MS).toBeGreaterThanOrEqual(100);
    expect(BLINK_MS).toBeLessThanOrEqual(150);
    const rand = lifeRandom(motionSeed('bot_x'));
    const blinks = Array.from({ length: 400 }, () => nextBlink(rand));
    expect(blinks.every((b) => b.wait >= 2400 && b.wait <= 6000)).toBe(true);
    const doubles = blinks.filter((b) => b.double).length;
    expect(doubles).toBeGreaterThan(40);
    expect(doubles).toBeLessThan(130);
  });

  it('gives each Bot its own rhythm, repeatably', () => {
    const a = lifeRandom(motionSeed('bot_a'));
    const a2 = lifeRandom(motionSeed('bot_a'));
    const b = lifeRandom(motionSeed('bot_b'));
    const seqA = [a(), a(), a()];
    expect([a2(), a2(), a2()]).toEqual(seqA);
    expect([b(), b(), b()]).not.toEqual(seqA);
  });

  it('turns the face about a point at list sizes, never more than 2.5pt', () => {
    expect(faceShift(22)).toBeCloseTo(0.99, 2);
    expect(faceShift(26)).toBeCloseTo(1.16, 2);
    expect(faceShift(120)).toBe(2.5);
    const g = nextGlance(lifeRandom(0.3));
    expect(g.wait).toBeGreaterThanOrEqual(5000);
    expect(Math.abs(g.side)).toBe(1);
  });

  it('talks in uneven beats with the odd pause', () => {
    const rand = lifeRandom(0.7);
    const beats = Array.from({ length: 300 }, () => mouthBeat(rand));
    expect(beats.every((b) => b.open >= 110 && b.open <= 230)).toBe(true);
    expect(beats.some((b) => b.closed >= 320)).toBe(true);
    expect(beats.filter((b) => b.closed >= 320).length).toBeLessThan(70);
  });
});

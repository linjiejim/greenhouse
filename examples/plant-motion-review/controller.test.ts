import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { MotionController, PERSONALITIES, spring } from './v2/controller.js';
const states = ['idle', 'thinking', 'speaking', 'done', 'error', 'waiting', 'sleep', 'hello'] as const;
const species = Object.keys(PERSONALITIES) as (keyof typeof PERSONALITIES)[];
function advance(m: MotionController, seconds: number) {
  for (let t = 0; t < seconds; t += 1 / 120) m.advance(1 / 120);
}
describe('accepted V1', () => {
  it('is byte-for-byte the accepted standalone artifact', () => {
    expect(
      createHash('sha256')
        .update(readFileSync(new URL('./v1.html', import.meta.url)))
        .digest('hex'),
    ).toBe('7e287235630086b8db2fd53c8c3021a8f8d277e1cc424414f82b66201eda7005');
  });
});
describe('interruptible V2 motion', () => {
  it.each(species)('%s bounds all eight states and arbitrary interruption sequences', (plant) => {
    const m = new MotionController(plant);
    for (let cycle = 0; cycle < 2; cycle++)
      for (const state of states) {
        m.setState(state);
        for (let frame = 0; frame < 90; frame++) {
          const v = m.advance(frame % 7 === 0 ? 0.03 : 1 / 60);
          expect(Object.values(v).every(Number.isFinite)).toBe(true);
          expect(Math.abs(v.rot)).toBeLessThanOrEqual(3.2);
          expect(v.sx).toBeGreaterThanOrEqual(0.989);
          expect(v.sy).toBeGreaterThan(0.985);
          expect(v.sy).toBeLessThan(1.016);
        }
      }
  });
  it('preserves position and velocity when retargeted; latest revision wins', () => {
    const m = new MotionController('sprout');
    m.setState('hello');
    advance(m, 0.31);
    const v = { ...m.values },
      velocity = { ...m.velocities };
    m.setState('error');
    expect(m.values).toEqual(v);
    expect(m.velocities).toEqual(velocity);
    for (const state of states) m.setState(state);
    m.setState('speaking');
    const revision = m.revision;
    advance(m, 5);
    expect(m.state).toBe('speaking');
    expect(m.revision).toBe(revision);
  });
  it('does not replay or queue a repeated state', () => {
    const m = new MotionController('sprout');
    m.setState('hello');
    advance(m, 0.5);
    const age = m.age,
      rev = m.revision;
    for (let i = 0; i < 100; i++) expect(m.setState('hello')).toBe(false);
    expect(m.age).toBe(age);
    expect(m.revision).toBe(rev);
  });
  it('never manufactures completion from thinking', () => {
    const m = new MotionController('ivy', { state: 'thinking' });
    advance(m, 30);
    expect(m.state).toBe('thinking');
    expect(m.values.curve).toBe(0);
  });
  it('opens eyes before the first syllable on waking', () => {
    const m = new MotionController('sprout', { state: 'sleep' });
    m.setState('speaking');
    advance(m, 0.35);
    expect(m.values.eye).toBeGreaterThan(3);
    expect(m.values.mouth).toBeLessThan(0.5);
    advance(m, 0.3);
    expect(m.values.mouth).toBeGreaterThan(0.5);
  });
  it('settles sleep without residual talking after rapid interruptions', () => {
    const m = new MotionController('lavender');
    for (const state of ['hello', 'thinking', 'speaking', 'error', 'done', 'sleep'] as const) {
      m.setState(state);
      advance(m, 0.08);
    }
    advance(m, 2);
    expect(m.state).toBe('sleep');
    expect(m.values.mouth).toBeCloseTo(0.2, 4);
    expect(m.values.eye).toBeCloseTo(0.23, 4);
  });
  it.each(species)('%s is still for most of a 20-second idle observation', (plant) => {
    const m = new MotionController(plant);
    let still = 0;
    for (let i = 0; i < 1200; i++) {
      const v = m.advance(1 / 60);
      if (Math.abs(v.y) < 0.001 && Math.abs(v.sy - 1) < 0.00001) still++;
    }
    expect(still / 1200).toBeGreaterThan(0.65);
  });
  it('pause does not advance; reduced motion is immediate and stationary', () => {
    const m = new MotionController('lotus');
    m.setState('hello');
    advance(m, 0.2);
    const before = m.sample();
    expect(m.advance(0)).toEqual(before);
    m.setReduced(true);
    m.setState('sleep');
    const reduced = m.sample();
    advance(m, 5);
    expect(m.sample()).toEqual(reduced);
    expect(reduced.rot).toBe(0);
    expect(reduced.leaf).toBe(0);
    expect(reduced.sy).toBe(1);
  });
  it('analytic spring agrees across frame rates for a stationary target', () => {
    let a: [number, number] = [1, 3],
      b: [number, number] = [1, 3];
    for (let i = 0; i < 60; i++) a = spring(...a, 0, 12, 1 / 60);
    for (let i = 0; i < 120; i++) b = spring(...b, 0, 12, 1 / 120);
    expect(a[0]).toBeCloseTo(b[0], 10);
    expect(a[1]).toBeCloseTo(b[1], 10);
  });
  it('profiles have distinct gesture decisions, not only a changed period', () => {
    const cactus = new MotionController('opuntia'),
      ginkgo = new MotionController('ginkgo');
    cactus.setState('hello');
    ginkgo.setState('hello');
    advance(cactus, 0.55);
    advance(ginkgo, 0.55);
    expect(cactus.values.rot).toBe(0);
    expect(ginkgo.values.rot).toBeGreaterThan(0.2);
    const stone = new MotionController('echeveria');
    stone.setState('done');
    advance(stone, 0.5);
    expect(stone.values.rot).toBe(0);
    expect(stone.values.y).toBe(0);
  });
});

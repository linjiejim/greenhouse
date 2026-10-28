import { existsSync, readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { forSvgXml } from './plant-avatar-native';
import { buildPlantAvatarSvg } from './plant-avatar-svg';
import { createMotion, advanceMotion, setMotionState, setMotionReduced } from './plant-motion';
import { poseMatrix } from './plant-motion-shapes';
describe('native V2 motion', () => {
  // packages/ui carries the canonical copy once the 3.0 web lane lands it (spec B10); until then
  // the v2 sources these were copied from are the reference
  const canonical = new URL('../../../../../packages/ui/src/components/plant-avatar/plant-motion.ts', import.meta.url);
  it.skipIf(!existsSync(canonical))('vendors the controller and transform/path functions verbatim', () => {
    for (const file of ['plant-motion.ts', 'plant-motion-shapes.ts', 'plant-work.ts', 'use-plant-work.ts'])
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).toBe(
        readFileSync(
          new URL('../../../../../packages/ui/src/components/plant-avatar/' + file, import.meta.url),
          'utf8',
        ),
      );
  });
  it('retargets serializable UI-thread data with retained velocity', () => {
    const m = createMotion('sprout');
    setMotionState(m, 'hello');
    advanceMotion(m, 0.2);
    const before = structuredClone(m);
    setMotionState(m, 'thinking');
    expect(m.values).toEqual(before.values);
    expect(m.velocities).toEqual(before.velocities);
    const transferred = structuredClone(m);
    advanceMotion(transferred, 0.016);
    expect(transferred.state).toBe('thinking');
    setMotionReduced(transferred, true);
    expect(advanceMotion(transferred, 10)).toEqual(transferred.values);
    expect(poseMatrix(transferred.values, [50, 94])).toEqual([1, 0, -0, 1, 0, 0]);
  });
  it('drops only the web root hooks from static SVG', () => {
    const svg = buildPlantAvatarSvg({ plant: 'ivy', size: 44, state: 'thinking', theme: 'dark' });
    expect(forSvgXml(svg)).not.toMatch(/class=|aria-|focusable=/);
    expect(forSvgXml(svg).slice(forSvgXml(svg).indexOf('>'))).toBe(svg.slice(svg.indexOf('>')));
  });
});

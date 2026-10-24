import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STEP, scaleText, TEXT_STEPS, textStepOf } from './type-scale';

describe('in-app text size', () => {
  it('has five steps around the standard size', () => {
    expect(TEXT_STEPS).toEqual([0.9, 1, 1.1, 1.2, 1.35]);
    expect(TEXT_STEPS[DEFAULT_TEXT_STEP]).toBe(1);
  });

  it('reads a stored step index or an account multiplier', () => {
    expect(textStepOf('3')).toBe(3);
    expect(textStepOf(0)).toBe(0);
    expect(textStepOf(1.35)).toBe(4);
    expect(textStepOf(0.9)).toBe(0);
    expect(textStepOf('1.1')).toBe(2);
  });

  it('falls back to the standard size for anything else', () => {
    for (const value of [null, undefined, '', 'big', 7, -1, 1.5, Number.NaN, {}]) {
      expect(textStepOf(value)).toBe(DEFAULT_TEXT_STEP);
    }
  });

  it('scales size and line height to whole points', () => {
    expect(scaleText({ fontSize: 17, lineHeight: 22 }, 1.35)).toEqual({ fontSize: 23, lineHeight: 30 });
    const body = { fontSize: 17, lineHeight: 22, fontWeight: '400' };
    expect(scaleText(body, 1)).toBe(body);
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXT_STEP, scaleText, TEXT_STEP_NAMES, TEXT_STEPS, textStepOf } from './type-scale';

describe('in-app text size', () => {
  it('has seven steps around the standard size, two of them below 0.9', () => {
    expect(TEXT_STEPS).toEqual([0.8, 0.85, 0.9, 1, 1.1, 1.2, 1.35]);
    expect(TEXT_STEPS[DEFAULT_TEXT_STEP]).toBe(1);
    expect(TEXT_STEP_NAMES).toHaveLength(TEXT_STEPS.length);
    expect(TEXT_STEP_NAMES[DEFAULT_TEXT_STEP]).toBe('standard');
  });

  it('reads a multiplier from the account or the phone', () => {
    expect(textStepOf(0.8)).toBe(0);
    expect(textStepOf('0.85')).toBe(1);
    expect(textStepOf(0.9)).toBe(2);
    expect(textStepOf(1)).toBe(3);
    expect(textStepOf('1.1')).toBe(4);
    expect(textStepOf(1.35)).toBe(6);
  });

  it('falls back to the standard size for anything else', () => {
    for (const value of [null, undefined, '', 'big', 7, -1, 1.5, 0.75, Number.NaN, {}]) {
      expect(textStepOf(value)).toBe(DEFAULT_TEXT_STEP);
    }
  });

  it('scales size and line height to whole points', () => {
    expect(scaleText({ fontSize: 17, lineHeight: 22 }, 1.35)).toEqual({ fontSize: 23, lineHeight: 30 });
    expect(scaleText({ fontSize: 17, lineHeight: 22 }, 0.8)).toEqual({ fontSize: 14, lineHeight: 18 });
    const body = { fontSize: 17, lineHeight: 22, fontWeight: '400' };
    expect(scaleText(body, 1)).toBe(body);
  });
});

import { afterEach, describe, expect, it } from 'vitest';
import { BRAND_INTRO_MS, brandIntroClock, resetBrandIntroForTests } from './brand-intro';

afterEach(() => resetBrandIntroForTests());

describe('brand intro clock', () => {
  it('plays once per page load and hands its elapsed time to the next screen', () => {
    expect(brandIntroClock(1000)).toEqual({ animate: true, elapsed: 0 });
    // the login screen takes over mid-way: same clock, the animation continues
    expect(brandIntroClock(1400)).toEqual({ animate: true, elapsed: 400 });
    // after it has played the mark stays static
    expect(brandIntroClock(1000 + BRAND_INTRO_MS + 1)).toEqual({ animate: false, elapsed: 0 });
  });
});

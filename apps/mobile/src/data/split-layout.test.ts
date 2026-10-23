import { describe, expect, it } from 'vitest';
import { isSplitWidth, splitListWidth } from './split-layout';

describe('the split view', () => {
  it('splits on a regular-width iPad and a wide Android tablet only', () => {
    expect(isSplitWidth({ os: 'ios', isPad: true, width: 1024 })).toBe(true);
    expect(isSplitWidth({ os: 'ios', isPad: true, width: 694 })).toBe(false); // narrow Split View
    expect(isSplitWidth({ os: 'ios', isPad: true, width: 375 })).toBe(false); // Slide Over
    expect(isSplitWidth({ os: 'ios', isPad: false, width: 956 })).toBe(false); // iPhone in landscape
    expect(isSplitWidth({ os: 'android', isPad: false, width: 900 })).toBe(true);
    expect(isSplitWidth({ os: 'android', isPad: false, width: 600 })).toBe(false);
  });

  it('gives the list about a third of the width, within bounds', () => {
    expect(splitListWidth(1024)).toBe(369);
    expect(splitListWidth(1366)).toBe(420);
    expect(splitListWidth(700)).toBe(320);
  });
});

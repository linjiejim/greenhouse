/**
 * When the hub's lists show their item beside them. React-free (./split-layout.test.ts): an iPad
 * at regular width (700 points and up: full screen, or the larger side of Split View), or an
 * Android tablet 840 dp and wider (Material's expanded width). iPhones never split, even in
 * landscape; an iPad in a narrow Split View or Slide Over keeps the phone layout.
 */

export function isSplitWidth(screen: { os: string; isPad: boolean; width: number }): boolean {
  if (screen.os === 'ios') return screen.isPad && screen.width >= 700;
  if (screen.os === 'android') return screen.width >= 840;
  return false;
}

/** The list pane's width: about a third of the screen, between 320 and 420 points. */
export function splitListWidth(width: number): number {
  return Math.round(Math.min(420, Math.max(320, width * 0.36)));
}

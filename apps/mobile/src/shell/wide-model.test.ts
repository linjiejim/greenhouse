import { expect, it } from 'vitest';
import { wideLayout } from './wide-model';
it.each([
  [390, false, true, true],
  [759, false, true, true],
  [760, true, true, true],
  [1024, true, true, true],
  [1100, true, false, true],
  [1280, true, false, true],
  [1440, true, false, false],
])('layout at %i', (width, wide, collapseSecondary, floatInspector) =>
  expect(wideLayout(width as number)).toEqual({ wide, collapseSecondary, floatInspector }),
);

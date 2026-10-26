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

it('formats sidebar ages at the desktop density', async () => {
  const { conversationAge } = await import('./wide-model');
  const now = new Date('2026-10-27T12:00:00Z').getTime();
  expect(conversationAge('2026-10-27T11:57:00Z', now, 'zh')).toBe('3m');
  expect(conversationAge('2026-10-27T11:00:00Z', now, 'zh')).toBe('1h');
  expect(conversationAge('2026-10-26T12:00:00Z', now, 'zh')).toBe('1d');
  expect(conversationAge('2026-10-21T12:00:00Z', now, 'zh')).toBe('周三');
  expect(conversationAge('2026-10-18T12:00:00Z', now, 'zh')).toBe('10/18');
});

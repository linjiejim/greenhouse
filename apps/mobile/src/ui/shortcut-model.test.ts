import { expect, it } from 'vitest';
import { matchesShortcut } from './shortcut-model';
it('matches Cmd or Control exactly and rejects extra modifiers', () => {
  const event = { key: 'k', metaKey: true, ctrlKey: false, shiftKey: false, altKey: false };
  expect(matchesShortcut('mod+k', event)).toBe(true);
  expect(matchesShortcut('mod+k', { ...event, metaKey: false, ctrlKey: true })).toBe(true);
  expect(matchesShortcut('mod+k', { ...event, shiftKey: true })).toBe(false);
  expect(matchesShortcut('mod+Enter', { ...event, key: 'Enter' })).toBe(true);
});

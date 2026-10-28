import { expect, it } from 'vitest';
import { createPressRelay } from './press-relay';

it('runs the newest handler through a handler handed out earlier', () => {
  const relay = createPressRelay();
  const saved: string[] = [];
  relay.update([{ id: 'save', onPress: () => saved.push('in Q') }]);
  const held = relay.press('save');
  relay.update([{ id: 'save', onPress: () => saved.push('in Q3') }]);
  held();
  expect(saved).toEqual(['in Q3']);
  expect(relay.press('save')).toBe(held);
});

it('relays menu items and ignores buttons that are gone', () => {
  const relay = createPressRelay();
  const hits: string[] = [];
  relay.update([{ id: 'more', onPress: () => {}, menu: [{ id: 'pin', onPress: () => hits.push('pin') }] }]);
  relay.press('more', 'pin')();
  relay.update([]);
  relay.press('more', 'pin')();
  expect(hits).toEqual(['pin']);
});

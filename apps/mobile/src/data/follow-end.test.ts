import { describe, expect, it } from 'vitest';
import { atEnd, shouldFollowEnd } from './follow-end';

describe('staying pinned to the end of a conversation', () => {
  it('knows when the list is at its end', () => {
    expect(atEnd({ offsetY: 1000, viewportHeight: 800, contentHeight: 1800 })).toBe(true);
    expect(atEnd({ offsetY: 950, viewportHeight: 800, contentHeight: 1800 })).toBe(true);
    expect(atEnd({ offsetY: 400, viewportHeight: 800, contentHeight: 1800 })).toBe(false);
  });

  it('follows every later layout change while pinned: new tail, streaming, images, re-measurement', () => {
    const same = { head: '50', prevHead: '50', tail: '99', prevTail: '99' };
    expect(shouldFollowEnd({ pinned: true, ...same })).toBe(true); // an image loaded, a row re-measured
    expect(shouldFollowEnd({ pinned: true, ...same, tail: '100' })).toBe(true); // a new message or reply text
  });

  it('lets go once the member scrolled up', () => {
    expect(shouldFollowEnd({ pinned: false, head: '50', prevHead: '50', tail: '100', prevTail: '99' })).toBe(false);
  });

  it('never moves for older history coming in at the top', () => {
    expect(shouldFollowEnd({ pinned: true, head: '0', prevHead: '50', tail: '99', prevTail: '99' })).toBe(false);
    // older history and a new reply in the same change: the end moved, follow it
    expect(shouldFollowEnd({ pinned: true, head: '0', prevHead: '50', tail: '100', prevTail: '99' })).toBe(true);
  });
});

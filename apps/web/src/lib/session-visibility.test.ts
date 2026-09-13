import { describe, expect, it } from 'vitest';
import { collectVisibleSessionIds } from './session-visibility';

describe('conversation viewport visibility', () => {
  it('keeps a session visible when any full, overlay, or split viewport shows it', () => {
    const visible = collectVisibleSessionIds([
      { sessionId: 'full-session', visible: true },
      { sessionId: 'overlay-session', visible: false },
      { sessionId: 'split-session', visible: true },
      { sessionId: 'full-session', visible: true },
    ]);

    expect([...visible].sort()).toEqual(['full-session', 'split-session']);
  });

  it('ignores empty and hidden viewports', () => {
    expect(
      collectVisibleSessionIds([
        { sessionId: null, visible: true },
        { sessionId: 'hidden-session', visible: false },
      ]),
    ).toEqual(new Set());
  });
});

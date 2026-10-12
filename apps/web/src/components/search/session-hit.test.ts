import { describe, expect, it } from 'vitest';
import { sessionHitHash } from './session-hit';

describe('sessionHitHash', () => {
  it('opens an ordinary chat in the chat engine', () => {
    expect(sessionHitHash({ sessionId: 'abc' })).toBe('#/chat?session=abc');
  });

  it('opens an Agent chat in its own view', () => {
    expect(sessionHitHash({ sessionId: 'a/b', channel: 'bots' })).toBe('#/bots?c=a%2Fb');
  });
});

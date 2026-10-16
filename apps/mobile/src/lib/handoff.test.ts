import { describe, expect, it } from 'vitest';
import { clearHandoffs, getHandoff, putHandoff } from './handoff';
describe('private navigation payloads', () => {
  it('expires private previews when an identity changes', () => {
    const key = putHandoff('doc', { content: 'Private' });
    expect(getHandoff(key, 'doc')).toEqual({ content: 'Private' });
    clearHandoffs();
    expect(getHandoff(key, 'doc')).toBeUndefined();
  });
});

it('treats a key for another viewer as expired', () => {
  const key = putHandoff('doc', { content: 'Private' });
  expect(getHandoff(key, 'table')).toBeUndefined();
  expect(getHandoff(undefined, 'doc')).toBeUndefined();
});

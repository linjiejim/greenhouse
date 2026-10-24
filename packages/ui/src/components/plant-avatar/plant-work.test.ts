import { describe, it, expect } from 'vitest';
import { stateForWork } from './plant-work';
describe('product work expressions', () => {
  it('prioritizes an executing tool over already streamed text', () => {
    expect(stateForWork({ streaming: true, hasText: true, toolRunning: true })).toBe('thinking');
    expect(stateForWork({ streaming: true, hasText: true })).toBe('speaking');
    expect(stateForWork({ working: true })).toBe('thinking');
  });
  it('waits for consent, acknowledges the outcome and keeps quiet surfaces asleep', () => {
    expect(stateForWork({ working: true, waiting: true })).toBe('waiting');
    expect(stateForWork({ failed: true, completed: true })).toBe('error');
    expect(stateForWork({ completed: true })).toBe('done');
    expect(stateForWork({ sleeping: true, greeting: true })).toBe('sleep');
    expect(stateForWork({ greeting: true })).toBe('hello');
    expect(stateForWork({})).toBe('idle');
  });
});

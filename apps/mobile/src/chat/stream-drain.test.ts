/**
 * The drain pace (./stream-drain.ts), pinned: both reply engines type text out
 * with it, so a change here changes how every reply feels.
 */
import { describe, expect, it } from 'vitest';
import { nextReveal } from './stream-drain';

/** Run the drain to the end; every step it takes. */
function drain(buffer: string, ended: boolean, from = 0): number[] {
  const steps: number[] = [];
  let shown = from;
  for (let i = 0; i < 10_000; i++) {
    const next = nextReveal(buffer, shown, ended);
    if (next === shown) break;
    steps.push(next);
    shown = next;
  }
  return steps;
}

describe('nextReveal — pace', () => {
  it('bounds bursts even when the server sends the whole reply at once', () => {
    for (const ended of [false, true]) {
      const text = '天'.repeat(1000);
      const steps = [0, ...drain(text, ended)];
      for (let i = 1; i < steps.length; i++) expect(steps[i] - steps[i - 1]).toBeLessThanOrEqual(ended ? 6 : 3);
      expect(steps.at(-1)).toBe(text.length);
    }
  });

  it('never goes backwards and stops when there is no backlog', () => {
    expect(nextReveal('hello', 5, false)).toBe(5);
    expect(nextReveal('hello', 5, true)).toBe(5);
    expect(nextReveal('hi', 9, false)).toBe(9);
    expect(nextReveal('', 0, true)).toBe(0);
  });

  it('reaches the end of a closed stream, step by step', () => {
    const text = 'The quick brown fox — 敏捷的棕色狐狸 — jumps over the lazy dog. 😀';
    const steps = drain(text, true);
    expect(steps.at(-1)).toBe(text.length);
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeGreaterThan(steps[i - 1]);
  });
});

describe('nextReveal — readable increments', () => {
  it('finishes short Latin words without dumping a long word or identifier at once', () => {
    expect(nextReveal('Hello world', 0, false)).toBe(5);
    expect(nextReveal('a'.repeat(100), 0, false)).toBeLessThanOrEqual(6);
  });
  it('does not snap CJK forward to the next space', () => {
    expect(nextReveal('你好世界，今天天气很好', 0, false)).toBe(2);
  });
});

describe('nextReveal — surrogate pairs', () => {
  const smile = '😀'; // two UTF-16 units

  it('never splits an emoji in the middle of the buffer', () => {
    const text = `ab${smile}cd`;
    // pace 1 from "ab" lands between the two halves → it takes the whole emoji
    const next = nextReveal(text, 2, false);
    expect(next).toBe(4);
    expect(text.slice(0, next)).toBe(`ab${smile}`);
  });

  it('holds a high surrogate at the end of an open buffer (the pair was split across chunks)', () => {
    const split = `ab${smile[0]}`;
    expect(nextReveal(split, 2, false)).toBe(2);
    // the other half arrives → the emoji comes out whole
    expect(nextReveal(`ab${smile}`, 2, false)).toBe(4);
  });

  it('lets a dangling high surrogate out once the stream has ended', () => {
    const split = `ab${smile[0]}`;
    expect(nextReveal(split, 2, true)).toBe(3);
  });

  it('never leaves half a pair on screen while draining a run of emoji', () => {
    const text = smile.repeat(30);
    for (const step of drain(text, false)) expect(step % 2).toBe(0);
    for (const step of drain(text, true)) expect(step % 2).toBe(0);
  });
});

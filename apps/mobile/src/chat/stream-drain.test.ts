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
  it('reveals a share of the backlog per tick, clamped to 1–8 chars while live', () => {
    const cjk = '天'.repeat(200);
    expect(nextReveal(cjk, 0, false)).toBe(8); // ⌈200/10⌉ = 20 → capped at 8
    expect(nextReveal(cjk, 195, false)).toBe(196); // ⌈5/10⌉ = 1
    expect(nextReveal('天', 0, false)).toBe(1); // at least one char
  });

  it('flows faster once the wire has closed (3–40 chars per tick)', () => {
    const cjk = '天'.repeat(200);
    expect(nextReveal(cjk, 0, true)).toBe(40); // ⌈200/5⌉ = 40
    expect(nextReveal(cjk, 150, true)).toBe(160); // ⌈50/5⌉ = 10
    expect(nextReveal(cjk, 199, true)).toBe(200); // min 3, clamped to the end
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

describe('nextReveal — Latin words', () => {
  it('finishes the word in progress instead of cutting it', () => {
    // pace 3 lands inside "Hello": the word is revealed whole, the space is not
    expect(nextReveal('Hello wonderful world', 0, false)).toBe(5);
    // from "Hello " the next word comes out whole too
    expect('Hello wonderful world'.slice(0, nextReveal('Hello wonderful world', 6, false))).toBe('Hello wonderful');
  });

  it('counts accented letters, digits, apostrophes and hyphens as part of a word', () => {
    expect('Ça-déjà'.slice(0, nextReveal('Ça-déjà vu', 0, false))).toBe('Ça-déjà');
    expect("don't".slice(0, nextReveal("don't stop", 0, false))).toBe("don't");
    expect('v2026'.slice(0, nextReveal('v2026 is here', 0, false))).toBe('v2026');
  });

  it('extends a word at most 12 chars past the pace', () => {
    const long = 'a'.repeat(100);
    // pace ⌈100/10⌉ = 10 → capped at 8, then the word runs on for up to 12 more
    expect(nextReveal(long, 0, false)).toBe(8 + 12);
  });

  it('never cuts a word on a word boundary that is already there', () => {
    const text = 'ab cd';
    // pace 1 lands after "a" ("b" continues the word) → "ab"
    expect(nextReveal(text, 0, false)).toBe(2);
    // after "ab": the space is not a word char, so the next step is just the space
    expect(nextReveal(text, 2, false)).toBe(3);
  });
});

describe('nextReveal — CJK', () => {
  it('goes character by character, never snapping ahead to a "word"', () => {
    const text = '你好世界，今天天气很好'; // 11 chars, no spaces
    expect(nextReveal(text, 0, false)).toBe(2); // ⌈11/10⌉ = 2 — no extension
    expect(nextReveal(text, 2, false)).toBe(3); // ⌈9/10⌉ = 1
  });

  it('stops a Latin word at the CJK text that follows it', () => {
    expect(nextReveal('Greenhouse温室', 0, false)).toBe('Greenhouse'.length);
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

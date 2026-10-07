/**
 * The streaming "drain" pace — how much of a reply's buffered text the next
 * ~30fps tick reveals. Pure and React-free, shared by both reply engines: the
 * conversation (./use-conversation.ts, one reply per turn) and the Bots thread
 * (src/bots/thread/reveal.ts, one speaker at a time).
 *
 * Each tick reveals a small share of the backlog, a few characters at most,
 * so a reply unfolds like calm typing instead of slamming in whole chunks:
 * Latin words whole (bounded), CJK character by character (with no spaces to
 * stop at, snapping ran a dozen characters ahead and lines popped in whole),
 * and never half a surrogate pair. Once the wire has closed the rest flows
 * out faster.
 */

/** The drain's tick (ms) — ~30 commits per second at most. */
export const TICK_MS = 33;

/**
 * Reveal pace, per tick: backlog ÷ `share`, clamped to [min, max] chars —
 * live, the text trails the model by ~⅓ s at up to 240 chars/s; once the
 * wire has closed, the rest flows out faster.
 */
const DRAIN_LIVE = { share: 10, min: 1, max: 8 };
const DRAIN_END = { share: 5, min: 3, max: 40 };
/** Characters that continue a Latin word (revealed whole; CJK has no word gaps). */
const WORD_CHAR = /[A-Za-z0-9\u00C0-\u024F_'’-]/;
/** How far past the pace a Latin word in progress may be finished. */
const WORD_RUN = 12;

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/**
 * How many characters of `buffer` to show after the next tick, given `shown`
 * already on screen and whether the stream has `ended` (no more text coming).
 * Never goes backwards; returns `shown` when there is no backlog.
 */
export function nextReveal(buffer: string, shown: number, ended: boolean): number {
  const backlog = buffer.length - shown;
  if (backlog <= 0) return shown;
  // A small share of the backlog, then finish a Latin word in progress
  // (bounded). CJK isn't extended: with no spaces to stop at, snapping
  // ran a dozen characters ahead and lines popped in whole.
  const pace = ended ? DRAIN_END : DRAIN_LIVE;
  let next = shown + Math.min(pace.max, Math.max(pace.min, Math.ceil(backlog / pace.share)));
  if (next < buffer.length) {
    const cap = Math.min(buffer.length, next + WORD_RUN);
    while (next < cap && WORD_CHAR.test(buffer[next - 1]) && WORD_CHAR.test(buffer[next])) next++;
    if (isHighSurrogate(buffer.charCodeAt(next - 1))) next++; // never split a surrogate pair
  }
  next = Math.min(next, buffer.length);
  // A high surrogate at the very end of a still-open buffer means the
  // pair was split across network chunks — hold it until the other half.
  if (next === buffer.length && !ended && isHighSurrogate(buffer.charCodeAt(next - 1))) next--;
  return Math.max(shown, next);
}

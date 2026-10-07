/**
 * Typing out a Bots run — which part of each Bot's text is on screen.
 *
 * The pace is the conversation screen's drain (`nextReveal`,
 * src/chat/stream-drain.ts: Latin words whole, CJK character by character,
 * never half a surrogate pair, faster once the turn is over). What a Bots run
 * adds is a front: each ~33 ms tick advances only the FIRST segment that still
 * has text to show; later segments stay at 0 characters (still "thinking" on
 * screen) until it has caught up — two Bots never type at the same time, and
 * a reply is never overtaken by the next one. Replayed text (a re-attach) is
 * snapped to its end by the engine instead of typed out.
 *
 * Pure: `shown` is the per-segment count of characters on screen, owned by
 * the engine (./engine.ts); `presentSegments` turns the run's segments into
 * what the screen gets, reusing objects so memoised rows stay put.
 */

import type { BotStreamSegment } from '../../shared/bots-wire';
import { nextReveal } from '../../chat/stream-drain';

export { TICK_MS } from '../../chat/stream-drain';

/** Characters of each segment's text on screen (missing = 0). */
export type Shown = readonly number[];

const backlog = (segment: BotStreamSegment, shown: number) =>
  segment.status !== 'skipped' && shown < segment.text.length;

/** The segment being typed out: the first with text not yet on screen, -1 = none. */
export function revealFront(segments: readonly BotStreamSegment[], shown: Shown): number {
  return segments.findIndex((segment, index) => backlog(segment, shown[index] ?? 0));
}

/**
 * One tick: advance the front only. `finished` = the run's stream is over (a
 * still-open segment then drains at the faster end pace too). Null when there
 * is nothing left to reveal.
 */
export function revealStep(segments: readonly BotStreamSegment[], shown: Shown, finished: boolean): number[] | null {
  const front = revealFront(segments, shown);
  if (front < 0) return null;
  const segment = segments[front];
  const ended = finished || segment.status !== 'streaming';
  const next = segments.map((_, index) => shown[index] ?? 0);
  next[front] = nextReveal(segment.text, next[front], ended);
  return next;
}

/** Everything on screen at once (a replay, a run that is gone). */
export function revealAll(segments: readonly BotStreamSegment[]): number[] {
  return segments.map((segment) => segment.text.length);
}

/** `shown` with segment `index` snapped to its full text (its text arrived replayed). */
export function revealSegment(segments: readonly BotStreamSegment[], shown: Shown, index: number): number[] {
  const next = segments.map((_, i) => shown[i] ?? 0);
  if (index >= 0 && index < segments.length) next[index] = segments[index].text.length;
  return next;
}

/** A presented copy, remembered per source segment so an unchanged one keeps its object. */
interface Presented {
  source: BotStreamSegment;
  shown: number;
  out: BotStreamSegment;
}

export type PresentCache = Presented[];

/**
 * The segments as the screen shows them: text cut at what is on screen, and a
 * segment whose text is not all out yet still says `streaming` (its turn may
 * have ended — the reply is still being typed). A fully revealed segment is
 * the source object itself; a cut one is cached against (source, shown), so
 * only the segment being typed becomes a new object on a tick. Mutates `cache`.
 */
export function presentSegments(
  segments: readonly BotStreamSegment[],
  shown: Shown,
  cache: PresentCache,
): BotStreamSegment[] {
  cache.length = Math.min(cache.length, segments.length);
  return segments.map((segment, index) => {
    const on = Math.min(shown[index] ?? 0, segment.text.length);
    if (!backlog(segment, on)) return segment;
    const known = cache[index];
    if (known && known.source === segment && known.shown === on) return known.out;
    const out: BotStreamSegment = { ...segment, text: segment.text.slice(0, on), status: 'streaming' };
    cache[index] = { source: segment, shown: on, out };
    return out;
  });
}

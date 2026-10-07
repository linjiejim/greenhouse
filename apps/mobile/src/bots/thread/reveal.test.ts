/**
 * Typing out a Bots run (./reveal.ts): the front advances one segment at a
 * time, replayed text is shown whole, and presenting keeps objects stable.
 * The per-tick pace itself is pinned in src/chat/stream-drain.test.ts.
 */

import { describe, expect, it } from 'vitest';
import type { BotStreamSegment } from '../../shared/bots-wire';
import { presentSegments, revealAll, revealFront, revealSegment, revealStep, type PresentCache } from './reveal';

function segment(botId: string, text: string, status: BotStreamSegment['status'] = 'streaming'): BotStreamSegment {
  return { botId, reason: 'user', status, text, reasoning: '', toolCalls: [] };
}

/** Run ticks until nothing is left, recording which segment moved on each. */
function drain(segments: BotStreamSegment[], shown: number[], finished = false) {
  const moved: number[] = [];
  let current = shown;
  for (let tick = 0; tick < 1_000; tick += 1) {
    const next = revealStep(segments, current, finished);
    if (!next) break;
    moved.push(next.findIndex((value, index) => value !== (current[index] ?? 0)));
    current = next;
  }
  return { moved, shown: current };
}

describe('reveal front', () => {
  it('with two segments both behind, only the first advances until it has caught up', () => {
    const segments = [segment('a', 'First Bot answer here', 'completed'), segment('b', 'Second Bot types next')];
    const first = revealStep(segments, [], false);
    expect(first?.[0]).toBeGreaterThan(0);
    expect(first?.[1]).toBe(0);
    const { moved, shown } = drain(segments, []);
    const switchAt = moved.indexOf(1);
    expect(moved.slice(0, switchAt).every((index) => index === 0)).toBe(true);
    expect(moved.slice(switchAt).every((index) => index === 1)).toBe(true);
    expect(shown).toEqual([segments[0].text.length, segments[1].text.length]);
  });

  it('the front is the first segment with text not yet on screen; skipped turns never count', () => {
    const segments = [
      segment('a', 'done', 'completed'),
      segment('x', 'never shown', 'skipped'),
      segment('b', 'typing'),
    ];
    expect(revealFront(segments, [4, 0, 0])).toBe(2);
    expect(revealFront(segments, [4, 0, 6])).toBe(-1);
    expect(revealStep(segments, [4, 0, 6], false)).toBeNull();
  });

  it('replayed text is shown at once (one segment, or the whole run)', () => {
    const segments = [segment('a', 'replayed history'), segment('b', 'more')];
    expect(revealSegment(segments, [], 0)).toEqual([16, 0]);
    expect(revealSegment(segments, [3, 1], 1)).toEqual([3, 4]);
    expect(revealAll(segments)).toEqual([16, 4]);
  });

  it('a closed turn drains faster than one still streaming', () => {
    const long = 'x'.repeat(400);
    const live = revealStep([segment('a', long)], [0], false)?.[0] ?? 0;
    const closed = revealStep([segment('a', long, 'completed')], [0], false)?.[0] ?? 0;
    const finished = revealStep([segment('a', long)], [0], true)?.[0] ?? 0;
    expect(closed).toBeGreaterThan(live);
    expect(finished).toBe(closed);
  });
});

describe('presentSegments', () => {
  it('cuts the text at what is on screen and says streaming until it is all out', () => {
    const segments = [segment('a', 'Hello world', 'completed'), segment('b', 'Next', 'completed')];
    const out = presentSegments(segments, [5, 0], []);
    expect(out[0]).toMatchObject({ text: 'Hello', status: 'streaming' });
    expect(out[1]).toMatchObject({ text: '', status: 'streaming' });
  });

  it('a fully shown segment is the source object; a cut one is reused while nothing changed', () => {
    const done = segment('a', 'Done', 'completed');
    const typing = segment('b', 'Typing along');
    const cache: PresentCache = [];
    const first = presentSegments([done, typing], [4, 3], cache);
    expect(first[0]).toBe(done);
    const again = presentSegments([done, typing], [4, 3], cache);
    expect(again[1]).toBe(first[1]);
    const moved = presentSegments([done, typing], [4, 6], cache);
    expect(moved[0]).toBe(done);
    expect(moved[1]).not.toBe(first[1]);
    expect(moved[1].text).toBe('Typing');
  });

  it('a segment with no text keeps its own status (a tool-only turn)', () => {
    const tools = {
      ...segment('a', '', 'completed'),
      toolCalls: [{ id: 't', name: 'browser', input: '{}', status: 'done' as const }],
    };
    expect(presentSegments([tools], [0], [])[0]).toBe(tools);
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendDelta,
  clearStreams,
  endStream,
  forgetStream,
  liveText,
  readStream,
  subscribeStream,
  upsertStep,
} from './streams';

afterEach(() => clearStreams());

describe('live replies (the web’s rules, apps/web/src/data/streams.ts)', () => {
  it('joins the saved partial text with the live piece where they meet', () => {
    expect(liveText('Hello wor', { start: 6, text: 'world and more', steps: [] })).toBe('Hello world and more');
    expect(liveText('Hello wor', { start: 9, text: 'ld', steps: [] })).toBe('Hello world');
    // the live piece is behind the saved text: keep the longer saved text
    expect(liveText('Hello world', { start: 0, text: 'Hel', steps: [] })).toBe('Hello world');
    // a gap: show what there is; the final message fills it in
    expect(liveText('Hello', { start: 9, text: 'ld', steps: [] })).toBe('Hellold');
    expect(liveText('', undefined)).toBe('');
  });

  it('appends in order, drops repeats and restarts after a gap', () => {
    const seen: string[] = [];
    const snapshot = () => seen.push(liveText('', readStream('m1')));
    appendDelta('m1', 'Hel', 0);
    appendDelta('m1', 'lo', 3);
    snapshot();
    appendDelta('m1', 'lo', 3); // a repeat changes nothing
    snapshot();
    appendDelta('m1', 'lo wo', 3); // overlaps: only the new part is added
    snapshot();
    upsertStep('m1', { id: 's1', tool: 'web_search', summary: 'Searched', status: 'running' });
    upsertStep('m1', { id: 's1', tool: 'web_search', summary: 'Searched', status: 'done' });
    expect(readStream('m1')!.steps).toEqual([{ id: 's1', tool: 'web_search', summary: 'Searched', status: 'done' }]);
    expect(seen).toEqual(['Hello', 'Hello', 'Hello wo']);
    appendDelta('m1', 'X', 20);
    expect(readStream('m1')).toMatchObject({ start: 20, text: 'X' });
  });

  it('starts mid-reply when the first delta it sees is not at the beginning', () => {
    appendDelta('m2', 'rld', 8);
    expect(readStream('m2')).toMatchObject({ start: 8, text: 'rld' });
    expect(liveText('Hello wo', readStream('m2'))).toBe('Hello world');
  });
});

describe('the end of a stream', () => {
  it('tells only that reply’s listeners, and the settled copy replaces the live piece', () => {
    const one = vi.fn();
    const other = vi.fn();
    const off = subscribeStream('m1', one);
    subscribeStream('m9', other);
    appendDelta('m1', 'Hi', 0);
    expect(one).toHaveBeenCalledTimes(1);
    endStream('m1');
    expect(one).toHaveBeenCalledTimes(2);
    expect(readStream('m1')).toBeUndefined();
    off();
    appendDelta('m1', 'again', 0);
    expect(one).toHaveBeenCalledTimes(2);
    expect(other).not.toHaveBeenCalled();
  });

  it('ignores whatever still arrives for a reply removed by an edit or a regenerate', () => {
    appendDelta('m3', 'old', 0);
    forgetStream('m3');
    appendDelta('m3', ' late', 3);
    upsertStep('m3', { id: 's', tool: 'x', summary: '', status: 'running' });
    expect(readStream('m3')).toBeUndefined();
  });
});

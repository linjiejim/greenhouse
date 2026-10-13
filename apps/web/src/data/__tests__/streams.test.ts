import { afterEach, describe, expect, it } from 'vitest';
import { appendDelta, clearStreams, liveText, readStream, upsertStep } from '../streams';

afterEach(() => clearStreams());

describe('live replies', () => {
  it('joins the saved partial text with the live piece where they meet', () => {
    expect(liveText('Hello wor', { start: 6, text: 'world and more', steps: [] })).toBe('Hello world and more');
    expect(liveText('Hello wor', { start: 9, text: 'ld', steps: [] })).toBe('Hello world');
    // The live piece is behind the saved text: keep the longer saved text.
    expect(liveText('Hello world', { start: 0, text: 'Hel', steps: [] })).toBe('Hello world');
    // A gap: show what there is; the final message fills it in.
    expect(liveText('Hello', { start: 9, text: 'ld', steps: [] })).toBe('Hellold');
    expect(liveText('', undefined)).toBe('');
  });

  it('appends in order, drops repeats and restarts after a gap', () => {
    const seen: string[] = [];
    const snapshot = () => seen.push(liveText('', currentStream('m1')));
    appendDelta('m1', 'Hel', 0);
    appendDelta('m1', 'lo', 3);
    snapshot();
    appendDelta('m1', 'lo', 3); // a repeat changes nothing
    snapshot();
    appendDelta('m1', 'lo wo', 3); // overlaps: only the new part is added
    snapshot();
    upsertStep('m1', { id: 's1', tool: 'web_search', summary: 'Searched', status: 'running' });
    upsertStep('m1', { id: 's1', tool: 'web_search', summary: 'Searched', status: 'done' });
    expect(currentStream('m1')!.steps).toEqual([
      { id: 's1', tool: 'web_search', summary: 'Searched', status: 'done' },
    ]);
    expect(seen).toEqual(['Hello', 'Hello', 'Hello wo']);
    appendDelta('m1', 'X', 20);
    expect(currentStream('m1')).toMatchObject({ start: 20, text: 'X' });
  });

  it('starts mid-reply when the first delta it sees is not at the beginning', () => {
    appendDelta('m2', 'rld', 8);
    expect(currentStream('m2')).toMatchObject({ start: 8, text: 'rld' });
    expect(liveText('Hello wo', currentStream('m2'))).toBe('Hello world');
  });
});

const currentStream = readStream;

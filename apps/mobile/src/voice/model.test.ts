import { describe, expect, it } from 'vitest';
import { insertTranscript, speechParts, SPEECH_MAX } from './model';
describe('voice words', () => {
  it('replaces only the selected composer text', () => {
    expect(insertTranscript('Hello old world', 'new', { start: 6, end: 9 })).toBe('Hello new world');
    expect(insertTranscript('Hi', '!', { start: 99, end: 99 })).toBe('Hi!');
  });
  it('reads Markdown as words within provider limits', () => {
    const parts = speechParts('**Hello** [doc](#/knowledge/d)\n' + '词'.repeat(9000));
    expect(parts.every((part) => part.length <= SPEECH_MAX)).toBe(true);
    expect(parts.join('')).not.toContain('**');
    expect(parts.join('')).toContain('doc');
  });
});

it('reads only prose, excluding code, image descriptions and table cells', () => {
  expect(
    speechParts('Hello\n```ts\nsecretCode\n```\n![picture](https://example.com/a.png)\n|Name|Value|\n|---|---|\n|n|1|'),
  ).toEqual(['Hello']);
});

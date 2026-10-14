import { describe, expect, it } from 'vitest';
import { plainText } from './text';
describe('reply excerpts', () => {
  it('never exposes rich payloads in previews or speech', () => {
    expect(plainText('Before\n```chart\n{"secret":"JSON"}\n```\nAfter')).toBe('Before\n\nAfter');
    expect(plainText('```chart\n{"unfinished":')).toBe('');
  });
  it('keeps ordinary code and readable links', () => {
    expect(plainText('**Hello** [doc](#/knowledge/d)\n```ts\nconst n=1;\n```')).toContain('const n=1;');
  });
});

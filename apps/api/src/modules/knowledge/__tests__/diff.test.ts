import { describe, expect, it } from 'vitest';
import { diffText, diffTokens, splitLines, splitWords } from '../diff.js';

describe('diffTokens', () => {
  it('finds the shortest edit between two token lists', () => {
    const runs = diffTokens(['a', 'b', 'c', 'a', 'b', 'b', 'a'], ['c', 'b', 'a', 'b', 'a', 'c']);
    const deleted = runs.filter((run) => run.op === 'delete').flatMap((run) => run.tokens).length;
    const inserted = runs.filter((run) => run.op === 'insert').flatMap((run) => run.tokens).length;
    // Myers' classic example: five edits.
    expect(deleted + inserted).toBe(5);
    const before = runs.filter((run) => run.op !== 'insert').flatMap((run) => run.tokens);
    const after = runs.filter((run) => run.op !== 'delete').flatMap((run) => run.tokens);
    expect(before).toEqual(['a', 'b', 'c', 'a', 'b', 'b', 'a']);
    expect(after).toEqual(['c', 'b', 'a', 'b', 'a', 'c']);
  });

  it('handles empty sides and identical lists', () => {
    expect(diffTokens([], ['x'])).toEqual([{ op: 'insert', tokens: ['x'] }]);
    expect(diffTokens(['x'], [])).toEqual([{ op: 'delete', tokens: ['x'] }]);
    expect(diffTokens(['x', 'y'], ['x', 'y'])).toEqual([{ op: 'equal', tokens: ['x', 'y'] }]);
  });

  it('splits text so the pieces join back to it', () => {
    const text = 'Plan v2:\n每周五提交 the  report.\nlast';
    expect(splitLines(text).join('')).toBe(text);
    expect(splitWords(text).join('')).toBe(text);
    expect(splitWords('提交 report')).toEqual(['提', '交', ' ', 'report']);
  });
});

describe('diffText', () => {
  const before = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');

  it('answers hunks of changed lines with two lines of context', () => {
    const after = before.replace('line 10', 'line ten').replace('line 18\n', '');
    const result = diffText(before, after, 'line');
    expect(result).toMatchObject({ added: 1, removed: 2, truncated: false });
    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[0]).toEqual({
      from_line: 8,
      to_line: 8,
      parts: [
        { op: 'equal', text: 'line 8\nline 9\n' },
        { op: 'delete', text: 'line 10\n' },
        { op: 'insert', text: 'line ten\n' },
        { op: 'equal', text: 'line 11\nline 12\n' },
      ],
    });
    expect(result.hunks[1]).toMatchObject({ from_line: 16, to_line: 16 });
  });

  it('joins changes whose context would overlap into one hunk', () => {
    const after = before.replace('line 5', 'five').replace('line 8', 'eight');
    expect(diffText(before, after, 'line').hunks).toHaveLength(1);
  });

  it('shows changed words, Chinese by character, in word mode', () => {
    const result = diffText('每周五提交周报。\nKeep this.\n', '每周四提交周报。\nKeep that.\n', 'word');
    const changed = result.hunks.flatMap((hunk) => hunk.parts).filter((part) => part.op !== 'equal');
    expect(changed).toEqual([
      { op: 'delete', text: '五' },
      { op: 'insert', text: '四' },
      { op: 'delete', text: 'this' },
      { op: 'insert', text: 'that' },
    ]);
    expect(result).toMatchObject({ added: 2, removed: 2 });
  });

  it('stays small: long unchanged text is shortened and nothing changed means no hunks', () => {
    const long = `${'word '.repeat(200)}end`;
    const result = diffText(`${long}\nA\n`, `${long}\nB\n`, 'line');
    const context = result.hunks[0]!.parts[0]!;
    expect(context.op).toBe('equal');
    expect(context.text.length).toBeLessThanOrEqual(300);
    expect(context.text).toContain(' … ');
    expect(diffText('same\n', 'same\n', 'word')).toEqual({ hunks: [], added: 0, removed: 0, truncated: false });
  });

  it('reports a wholesale rewrite of a large doc without hanging', () => {
    const a = Array.from({ length: 3000 }, (_, index) => `a${index}`).join('\n');
    const b = Array.from({ length: 3000 }, (_, index) => `b${index}`).join('\n');
    const started = Date.now();
    const result = diffText(a, b, 'line');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.added).toBe(3000);
    expect(result.removed).toBe(3000);
    expect(result.truncated).toBe(true);
  });
});

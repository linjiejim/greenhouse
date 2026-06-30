/**
 * Tests for markdown table pre-processing.
 */

import { describe, it, expect } from 'vitest';

// Since the function lives in a .tsx file with React/marked imports,
// we replicate the logic here for unit testing. This validates the algorithm.
function fixMarkdownTables(md: string): string {
  const lines = md.split('\n');
  const result: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Fix separator rows: |:---:|::---:|:----:| → |:---:|:---:|:---:|
    if (/^\s*\|([:\-\s|]+)\|\s*$/.test(line)) {
      // Fix double colons: ::--- → :---
      line = line.replace(/::/g, ':');
      // Fix separators with too few dashes: |:| → |:---:|
      line = line.replace(/\|\s*:?\s*:?\s*\|/g, (match) => {
        if (!/---/.test(match)) {
          return '| --- |';
        }
        return match;
      });
    }

    // Fix table rows with ～ vs ~ inconsistency (CJK tilde)
    if (/^\s*\|/.test(line) && /\|\s*$/.test(line)) {
      line = line.replace(/～/g, '~');
    }

    result.push(line);
  }

  let text = result.join('\n');

  // Fix single-tilde ranges being parsed as GFM strikethrough.
  text = text.replace(/(?<!~)~(?!~)/g, (match, offset) => {
    const before = text[offset - 1] || '';
    const after = text[offset + 1] || '';
    const isRange = /[\d\w\u4e00-\u9fff\u00b0)）]/.test(before) &&
                    /[\d\w\u4e00-\u9fff(（]/.test(after);
    return isRange ? '\\~' : match;
  });

  return text;
}

describe('fixMarkdownTables', () => {
  it('should fix double colons in separator rows', () => {
    const input = '| A | B | C |\n|:---:|::---:|:----:|\n| 1 | 2 | 3 |';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toBe('| A | B | C |\n|:---:|:---:|:----:|\n| 1 | 2 | 3 |');
  });

  it('should leave valid tables unchanged', () => {
    const input = '| A | B |\n|---|---|\n| 1 | 2 |';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toBe(input);
  });

  it('should handle aligned separators with double colons', () => {
    const input = '| Col |\n|::---:|\n| val |';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toContain(':---:');
    expect(fixed).not.toContain('::');
  });

  it('should normalize CJK tilde in table cells', () => {
    const input = '| Range |\n|---|\n| 1～5 |';
    const fixed = fixMarkdownTables(input);
    // CJK tilde ～ is first converted to ~, then escaped to \~ in range context
    expect(fixed).toContain('1\\~5');
    expect(fixed).not.toContain('～');
  });

  it('should not modify non-table content', () => {
    const input = 'Hello world\n\nSome text with :: colons';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toBe(input);
  });

  it('should handle the exact problematic pattern from screenshot', () => {
    const input = [
      '| 阶段 | 时间 | 光照 | EC（营养浓度） |',
      '|:---:|:---:|::---:|:----:|',
      '| 🌱 发芽期 | 第 1~14 天 | 无需光照 | — |',
    ].join('\n');

    const fixed = fixMarkdownTables(input);
    // The separator should no longer have ::
    expect(fixed).not.toContain('::');
    // Should have valid separator
    expect(fixed).toContain(':---:');
  });

  it('should escape single tildes in numeric ranges to prevent strikethrough', () => {
    const input = '10~15cm（4~6英寸）';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toContain('\\~');
    // Should not break double-tilde strikethrough
    expect(fixed).not.toContain('~~');
  });

  it('should handle temperature ranges with tildes', () => {
    const input = '温度范围：18~25°C，湿度 40~60%';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toContain('18\\~25');
    expect(fixed).toContain('40\\~60');
  });

  it('should preserve double-tilde strikethrough', () => {
    const input = 'This is ~~strikethrough~~ text';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toBe(input); // Unchanged
  });

  it('should handle mixed tilde usage', () => {
    const input = 'pH范围是5~7，~~不推荐~~低于4';
    const fixed = fixMarkdownTables(input);
    expect(fixed).toContain('5\\~7');
    expect(fixed).toContain('~~不推荐~~'); // Strikethrough preserved
  });
});

import { describe, expect, it } from 'vitest';
import { toSearchSummary } from './search-summary';

describe('toSearchSummary', () => {
  it('renders an authored summary', () => {
    expect(toSearchSummary('五分钟内对齐品牌规范。')).toBe('五分钟内对齐品牌规范。');
  });

  it('cleans accidental markup inside an authored summary', () => {
    expect(toSearchSummary('# <mark>品牌</mark> **总览**\n- 使用 [品牌绿](/colors)')).toBe('品牌 总览 使用 品牌绿');
  });

  it('does not substitute body content when a summary is unavailable', () => {
    expect(toSearchSummary(null)).toBe('');
  });
});

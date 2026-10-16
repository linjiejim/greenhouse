import { describe, expect, it } from 'vitest';
import { queryWords, searchQuery, searchTokens, segment } from '../search.js';

describe('segment', () => {
  it('splits Chinese into words and keeps codes and English words whole', () => {
    expect(segment('LPH64水位低报警', 'query')).toEqual(['lph64', '水位', '低', '报警']);
    expect(segment('See the Onboarding guide!', 'query')).toEqual(['see', 'the', 'onboarding', 'guide']);
  });

  it('keeps accented words whole and drops punctuation and spaces', () => {
    expect(segment('café, naïve — 50% (2026)', 'query')).toEqual(['café', 'naïve', '50', '2026']);
    expect(segment('  ！？。，', 'query')).toEqual([]);
  });

  it('indexes the shorter words inside long Chinese words too', () => {
    const indexed = segment('每周五提交周报', 'index');
    expect(indexed).toEqual(expect.arrayContaining(['每周五', '周五', '周报', '提交']));
    expect(segment('每周五提交周报', 'query')).toEqual(['每周五', '提交', '周报']);
  });

  it('normalises width and case so full-width letters match', () => {
    expect(segment('ＬＰＨ６４', 'query')).toEqual(['lph64']);
  });
});

describe('searchTokens and searchQuery', () => {
  it('writes the words of every part, space separated', () => {
    expect(searchTokens('周报模板', null, undefined, 'Weekly')).toBe(`${segment('周报模板').join(' ')} weekly`);
    expect(searchTokens()).toBe('');
  });

  it('builds prefix queries joined by AND or OR, null when nothing is left', () => {
    expect(searchQuery('水位 低', '&')).toBe('水位:* & 低:*');
    expect(searchQuery('LPH64 报警', '|')).toBe('lph64:* | 报警:*');
    expect(searchQuery('报警 报警', '&')).toBe('报警:*');
    expect(searchQuery('!!!', '&')).toBeNull();
  });

  it('never lets tsquery syntax through', () => {
    expect(searchQuery("a:* | b & !c ' <-> (d)", '&')).toBe('a:* & b:* & c:* & d:*');
    expect(queryWords('Plan, plan & PLAN')).toEqual(['plan']);
  });
});

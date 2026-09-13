import { describe, it, expect } from 'vitest';
import { segmentForFts, buildSegmentedTsQuery, buildSnippet, jsonArrayToText } from './fts.js';

describe('segmentForFts', () => {
  it('word-segments a Chinese sentence into space-joined tokens', () => {
    expect(segmentForFts('水位低报警')).toBe('水位 低 报警');
  });

  it('keeps a device code intact and lowercases latin', () => {
    // jieba keeps the alphanumeric run "LPH64" together; Chinese is segmented.
    expect(segmentForFts('LPH64水位低')).toBe('lph64 水位 低');
  });

  it('drops pure punctuation / whitespace tokens', () => {
    const out = segmentForFts('LPH-SE 定时浇水');
    expect(out.split(/\s+/)).not.toContain('-');
    expect(out).toContain('定时');
    expect(out).toContain('浇水');
  });

  it('returns empty string for empty / nullish input', () => {
    expect(segmentForFts('')).toBe('');
    expect(segmentForFts(null)).toBe('');
    expect(segmentForFts(undefined)).toBe('');
  });

  it('is deterministic (same input → same tokens)', () => {
    expect(segmentForFts('营养液EC值多少合适')).toBe(segmentForFts('营养液EC值多少合适'));
  });
});

describe('buildSegmentedTsQuery', () => {
  it('builds a prefix AND query from a Chinese phrase', () => {
    expect(buildSegmentedTsQuery('水位低', '&')).toBe('水位:* & 低:*');
  });

  it('builds a prefix OR query', () => {
    expect(buildSegmentedTsQuery('水位低', '|')).toBe('水位:* | 低:*');
  });

  it('keeps single Chinese characters (unlike a length>1 latin filter)', () => {
    // "低" is one char but a meaningful word — it must survive.
    expect(buildSegmentedTsQuery('低', '&')).toBe('低:*');
  });

  it('mixes device code and Chinese', () => {
    expect(buildSegmentedTsQuery('LPH64 报警', '&')).toBe('lph64:* & 报警:*');
  });

  it('returns null when nothing usable remains', () => {
    expect(buildSegmentedTsQuery('', '&')).toBeNull();
    expect(buildSegmentedTsQuery('   ', '|')).toBeNull();
    expect(buildSegmentedTsQuery('!@#', '&')).toBeNull();
  });
});

describe('buildSnippet', () => {
  it('windows around the first matching Chinese token', () => {
    const content = '前言部分。设备水位低时会触发报警,请检查水箱。结束语。';
    const snip = buildSnippet(content, '水位低报警', { window: 20 });
    expect(snip).toContain('水位');
    expect(snip.length).toBeLessThanOrEqual(24); // window + ellipses
  });

  it('falls back to the head when no token matches', () => {
    const content = '完全无关的内容在这里。';
    expect(buildSnippet(content, '水位', { window: 8 })).toBe(content.slice(0, 8));
  });

  it('returns empty string for empty content', () => {
    expect(buildSnippet('', '水位')).toBe('');
    expect(buildSnippet(null, '水位')).toBe('');
  });
});

describe('jsonArrayToText', () => {
  it('joins a JSON string array', () => {
    expect(jsonArrayToText('["LPH64","报警"]')).toBe('LPH64 报警');
  });

  it('tolerates malformed JSON by returning the raw string', () => {
    expect(jsonArrayToText('not json')).toBe('not json');
  });

  it('returns empty for nullish', () => {
    expect(jsonArrayToText(null)).toBe('');
    expect(jsonArrayToText('')).toBe('');
  });
});

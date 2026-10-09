import { describe, expect, it } from 'vitest';
import { parseGroundTruth, serializeGroundTruth } from './eval.js';

describe('parseGroundTruth', () => {
  it('reads the stored JSON array of facts', () => {
    expect(parseGroundTruth('["First fact","Second fact"]')).toEqual(['First fact', 'Second fact']);
  });

  it('treats a legacy plain-string ground truth as one fact', () => {
    expect(parseGroundTruth('Reports are due within 30 days.')).toEqual(['Reports are due within 30 days.']);
    // Only Trace → Dataset capture splits by line; everywhere else a string is one fact.
    expect(parseGroundTruth('Line one\nLine two')).toEqual(['Line one\nLine two']);
  });

  it('keeps a bare JSON scalar as the text that was written', () => {
    expect(parseGroundTruth('"quoted fact"')).toEqual(['quoted fact']);
    expect(parseGroundTruth('42')).toEqual(['42']);
    expect(parseGroundTruth('{"a":1}')).toEqual(['{"a":1}']);
    expect(parseGroundTruth('null')).toEqual(['null']);
  });

  it('trims facts and drops empty or non-text items', () => {
    expect(parseGroundTruth('[" a ", "", 3, true, null, {"x": 1}, ["nested"]]')).toEqual(['a', '3', 'true']);
    expect(parseGroundTruth('   ')).toEqual([]);
    expect(parseGroundTruth('[]')).toEqual([]);
  });

  it('accepts an already-parsed array and ignores a missing value', () => {
    expect(parseGroundTruth(['one', ' two '])).toEqual(['one', 'two']);
    expect(parseGroundTruth(undefined)).toEqual([]);
    expect(parseGroundTruth(null)).toEqual([]);
  });
});

describe('serializeGroundTruth', () => {
  it('stores a plain string as a one-element JSON array', () => {
    expect(serializeGroundTruth('Expected answer')).toBe('["Expected answer"]');
  });

  it('is idempotent on the stored form', () => {
    const stored = serializeGroundTruth('["a","b"]');
    expect(stored).toBe('["a","b"]');
    expect(serializeGroundTruth(stored)).toBe(stored);
  });
});

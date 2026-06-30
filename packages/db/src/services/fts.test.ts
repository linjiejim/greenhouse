import { describe, it, expect } from 'vitest';
import { buildPrefixTsQuery } from './fts.js';

describe('buildPrefixTsQuery', () => {
  it('builds an OR prefix-match query from multi-word input', () => {
    expect(buildPrefixTsQuery('hydroponic lettuce')).toBe('hydroponic:* | lettuce:*');
  });

  it('drops single-character tokens', () => {
    expect(buildPrefixTsQuery('a lettuce')).toBe('lettuce:*');
  });

  it('returns null when nothing usable remains', () => {
    expect(buildPrefixTsQuery('')).toBeNull();
    expect(buildPrefixTsQuery('   ')).toBeNull();
    expect(buildPrefixTsQuery('a b')).toBeNull();
  });

  it('strips quotes and backslashes', () => {
    expect(buildPrefixTsQuery(`"pump" it\\s`)).toBe('pump:* | its:*');
  });
});

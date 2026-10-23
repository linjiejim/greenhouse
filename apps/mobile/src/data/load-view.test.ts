import { describe, expect, it } from 'vitest';
import { loadView } from './load-view';

describe('a part of a screen that loads on its own', () => {
  it('shows its data, its failure, or that it is loading', () => {
    expect(loadView({ data: { a: 1 }, loading: true, error: null })).toBe('ready');
    expect(loadView({ data: { a: 1 }, loading: false, error: { status: 500 } })).toBe('ready');
    expect(loadView({ data: null, loading: false, error: { status: 500 } })).toBe('failed');
    expect(loadView({ data: null, loading: true, error: { status: 500 } })).toBe('loading');
    expect(loadView({ data: null, loading: true, error: null })).toBe('loading');
  });
});

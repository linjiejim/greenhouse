/**
 * The autocomplete model: stored fields only, starts-with before contains,
 * functions by prefix, and the text / caret after picking a suggestion.
 */

import { describe, expect, it } from 'vitest';
import { applyFormulaSuggestion, formulaSuggestions } from './formula-suggestions';

const fields = [
  { id: 1, name: 'Name', type: 'text' as const },
  { id: 2, name: 'Order amount', type: 'number' as const },
  { id: 3, name: 'Amount due', type: 'number' as const },
  { id: 4, name: 'Total', type: 'rollup' as const },
  { id: 5, name: 'Price {net}', type: 'number' as const },
];

describe('formulaSuggestions', () => {
  it('offers stored fields inside braces, starts-with first', () => {
    const state = formulaSuggestions('1 + {am', 7, fields)!;
    expect(state.completion).toEqual({ kind: 'field', prefix: 'am', start: 4, end: 7 });
    expect(state.items.map((item) => item.label)).toEqual(['Amount due', 'Name', 'Order amount']);
    expect(formulaSuggestions('{tot', 4, fields)).toBeNull();
    expect(formulaSuggestions('{', 1, fields)!.items.map((item) => item.label)).toEqual([
      'Name',
      'Order amount',
      'Amount due',
      'Price {net}',
    ]);
  });

  it('offers functions by prefix and stays quiet once a name is complete', () => {
    expect(formulaSuggestions('ro', 2, fields)!.items.map((item) => item.label)).toEqual(['ROUND']);
    expect(formulaSuggestions('round', 5, fields)).toBeNull();
    expect(formulaSuggestions('"ro', 3, fields)).toBeNull();
    expect(formulaSuggestions('12', 2, fields)).toBeNull();
  });
});

describe('applyFormulaSuggestion', () => {
  it('replaces the whole reference, escaping braces, and puts the caret after it', () => {
    const state = formulaSuggestions('{pri} * 2', 3, fields)!;
    expect(applyFormulaSuggestion('{pri} * 2', state.completion, state.items[0]!)).toEqual({
      text: '{Price \\{net\\}} * 2',
      caret: 15,
    });
  });

  it('opens a call, or reuses parentheses already there', () => {
    const opening = formulaSuggestions('1 + ab', 6, fields)!;
    expect(applyFormulaSuggestion('1 + ab', opening.completion, opening.items[0]!)).toEqual({
      text: '1 + ABS(',
      caret: 8,
    });
    const existing = formulaSuggestions('ab({Name})', 2, fields)!;
    expect(applyFormulaSuggestion('ab({Name})', existing.completion, existing.items[0]!)).toEqual({
      text: 'ABS({Name})',
      caret: 4,
    });
  });
});

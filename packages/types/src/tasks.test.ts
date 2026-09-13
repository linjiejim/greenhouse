import { describe, expect, it } from 'vitest';
import {
  applyTaskVariables,
  isTaskVariable,
  missingRequired,
  parseExpectedTools,
  parseTaskVariables,
  placeholdersIn,
} from './tasks.js';

describe('placeholdersIn', () => {
  it('finds each placeholder once, in first-appearance order', () => {
    expect(placeholdersIn('Report {{month}} for {{region}}, then {{month}} again.')).toEqual(['month', 'region']);
  });

  it('tolerates inner whitespace but rejects names that are not identifiers', () => {
    expect(placeholdersIn('{{ month }}')).toEqual(['month']);
    expect(placeholdersIn('{{9lives}} {{with-dash}} {{}}')).toEqual([]);
  });
});

describe('applyTaskVariables', () => {
  it('substitutes filled values', () => {
    expect(applyTaskVariables('{{a}}/{{b}}', { a: '1', b: '2' })).toBe('1/2');
  });

  it('leaves unfilled and whitespace-only values as visible placeholders', () => {
    // A blank would silently change what the task asks for; a visible
    // {{b}} is something the profile prompt tells the model to ask about.
    expect(applyTaskVariables('{{a}}/{{b}}', { a: '1' })).toBe('1/{{b}}');
    expect(applyTaskVariables('{{a}}/{{b}}', { a: '1', b: '   ' })).toBe('1/{{b}}');
  });

  it('replaces every occurrence of the same variable', () => {
    expect(applyTaskVariables('{{x}} then {{x}}', { x: 'go' })).toBe('go then go');
  });
});

describe('isTaskVariable', () => {
  it('accepts a well-formed variable and rejects malformed keys', () => {
    expect(isTaskVariable({ key: 'month', label: 'Month' })).toBe(true);
    expect(isTaskVariable({ key: '1month', label: 'Month' })).toBe(false);
    expect(isTaskVariable({ key: 'month' })).toBe(false);
    expect(isTaskVariable({ key: 'month', label: '' })).toBe(false);
  });
});

describe('parseTaskVariables', () => {
  it('degrades to an empty list rather than throwing on bad JSON', () => {
    // The column is model-authored upstream; a broken value must not make the
    // task unusable, only unparameterized.
    expect(parseTaskVariables('not json')).toEqual([]);
    expect(parseTaskVariables('{"not":"an array"}')).toEqual([]);
    expect(parseTaskVariables(null)).toEqual([]);
  });

  it('drops malformed entries but keeps the good ones', () => {
    expect(parseTaskVariables('[{"key":"a","label":"A"},{"key":"!"}]')).toEqual([{ key: 'a', label: 'A' }]);
  });
});

describe('parseExpectedTools', () => {
  it('keeps strings and ignores anything else', () => {
    expect(parseExpectedTools('["crm_query",1,"",null,"export_data"]')).toEqual(['crm_query', 'export_data']);
    expect(parseExpectedTools('nope')).toEqual([]);
  });
});

describe('missingRequired', () => {
  it('reports only required fields that are still blank', () => {
    const variables = [
      { key: 'a', label: 'A', required: true },
      { key: 'b', label: 'B' },
    ];
    expect(missingRequired(variables, {}).map((v) => v.key)).toEqual(['a']);
    expect(missingRequired(variables, { a: ' ' }).map((v) => v.key)).toEqual(['a']);
    expect(missingRequired(variables, { a: 'x' })).toEqual([]);
  });
});

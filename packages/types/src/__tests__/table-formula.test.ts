/**
 * The formula text language: tokenizer, parser (precedence, unary minus,
 * keywords, full-width punctuation), positioned errors with friendly codes,
 * static checks against the catalog, the formatter and text ↔ AST round trips.
 */

import { describe, expect, it } from 'vitest';
import {
  checkTableFormula,
  formatTableFormula,
  normalizeTableFormulaDateUnit,
  parseTableFormula,
  tableFormulaCompletionAt,
  TABLE_FORMULA_FUNCTION_CATALOG,
  TABLE_FORMULA_MAX_LENGTH,
  tokenizeTableFormula,
  type TableFormulaField,
} from '../table-formula.js';
import { TABLE_FORMULA_FUNCTIONS, type TableFormulaExpression } from '../tables.js';

const fields: TableFormulaField[] = [
  { id: 1, name: 'Name', type: 'text' },
  { id: 2, name: '数量', type: 'number' },
  { id: 3, name: 'Start', type: 'date' },
  { id: 4, name: 'Due', type: 'date' },
  { id: 5, name: 'Seen at', type: 'datetime' },
  { id: 6, name: 'Done', type: 'boolean' },
  { id: 7, name: 'Tags', type: 'multi_select' },
  { id: 8, name: 'Total', type: 'rollup' },
  { id: 9, name: 'Price {net}', type: 'number' },
  { id: 10, name: 'Status', type: 'single_select' },
];

const field = (fieldId: number): TableFormulaExpression => ({ type: 'field', fieldId });
const literal = (value: string | number | boolean | null): TableFormulaExpression => ({ type: 'literal', value });

function parsed(text: string) {
  const result = parseTableFormula(text, fields);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result;
}

function failure(text: string) {
  const result = parseTableFormula(text, fields);
  if (result.ok) throw new Error(`expected "${text}" to fail`);
  return result.error;
}

describe('parseTableFormula', () => {
  it('parses the acceptance formulas into the stored AST', () => {
    expect(parsed('IF({数量} > 10, "大单", "小单")')).toEqual({
      ok: true,
      type: 'text',
      expression: {
        type: 'function',
        name: 'if',
        args: [
          { type: 'binary', operator: 'gt', left: field(2), right: literal(10) },
          literal('大单'),
          literal('小单'),
        ],
      },
    });
    expect(parsed('DATEDIFF({Due}, {Start}, "days")')).toEqual({
      ok: true,
      type: 'number',
      expression: { type: 'function', name: 'datediff', args: [field(4), field(3), literal('days')] },
    });
  });

  it('follows precedence: comparison < & < + - < * / < unary, all left-associative', () => {
    expect(parsed('1 + 2 * 3').expression).toEqual({
      type: 'binary',
      operator: 'add',
      left: literal(1),
      right: { type: 'binary', operator: 'multiply', left: literal(2), right: literal(3) },
    });
    expect(parsed('{Name} & 1 + 2 = "x3"').expression).toEqual({
      type: 'binary',
      operator: 'eq',
      left: {
        type: 'binary',
        operator: 'concat',
        left: field(1),
        right: { type: 'binary', operator: 'add', left: literal(1), right: literal(2) },
      },
      right: literal('x3'),
    });
    expect(parsed('10 - 4 - 3').expression).toEqual({
      type: 'binary',
      operator: 'subtract',
      left: { type: 'binary', operator: 'subtract', left: literal(10), right: literal(4) },
      right: literal(3),
    });
    expect(parsed('(1 + 2) * 3').expression).toMatchObject({ operator: 'multiply' });
  });

  it('reads unary minus as a negative literal or 0 - x, and unary plus as nothing', () => {
    expect(parsed('-5').expression).toEqual(literal(-5));
    expect(parsed('- 0').expression).toEqual(literal(0));
    expect(parsed('-{数量} * 2').expression).toEqual({
      type: 'binary',
      operator: 'multiply',
      left: { type: 'binary', operator: 'subtract', left: literal(0), right: field(2) },
      right: literal(2),
    });
    expect(parsed('+{数量}').expression).toEqual(field(2));
    expect(parsed('2 - -3').expression).toEqual({
      type: 'binary',
      operator: 'subtract',
      left: literal(2),
      right: literal(-3),
    });
  });

  it('accepts keywords, operator spellings, escapes, exponents and case-insensitive names', () => {
    expect(parsed('true').expression).toEqual(literal(true));
    expect(parsed('False').expression).toEqual(literal(false));
    expect(parsed('NULL').expression).toEqual(literal(null));
    expect(parsed('{数量} <> 1').expression).toMatchObject({ operator: 'neq' });
    expect(parsed('{数量} == 1').expression).toMatchObject({ operator: 'eq' });
    expect(parsed('1.5e3').expression).toEqual(literal(1500));
    expect(parsed('.5').expression).toEqual(literal(0.5));
    expect(parsed('"say \\"hi\\"\\n"').expression).toEqual(literal('say "hi"\n'));
    expect(parsed("'single'").expression).toEqual(literal('single'));
    expect(parsed('{Price \\{net\\}} * 2').expression).toMatchObject({ left: field(9) });
    expect(parsed('{name}').expression).toEqual(field(1));
    expect(parsed('{#2}').expression).toEqual(field(2));
    expect(parsed('round({数量}, 2)').expression).toMatchObject({ type: 'function', name: 'round' });
    expect(parsed('Upper({Name})').expression).toMatchObject({ type: 'function', name: 'upper' });
  });

  it('reads full-width parentheses, commas and curly quotes like ASCII', () => {
    expect(parsed('IF（{数量} > 10，“大单”，“小单”）').expression).toEqual(
      parsed('IF({数量} > 10, "大单", "小单")').expression,
    );
  });

  it('accepts zero-argument-free calls and AND / OR / NOT as functions', () => {
    expect(parsed('AND({Done}, OR({数量} > 1, NOT({Done})))').type).toBe('boolean');
    expect(parsed('CONCAT({Name}, " ", {数量})').type).toBe('text');
  });

  it('infers result types for the editor', () => {
    expect(parsed('{数量} * 2').type).toBe('number');
    expect(parsed('{Name} & "!"').type).toBe('text');
    expect(parsed('{数量} > 2').type).toBe('boolean');
    expect(parsed('DATEADD({Start}, 3, "weeks")').type).toBe('date');
    expect(parsed('DATEADD({Seen at}, 3, "days")').type).toBe('datetime');
    expect(parsed('IF({Done}, 1, NULL)').type).toBe('number');
    expect(parsed('IF({Done}, 1, "x")').type).toBe('unknown');
    expect(parsed('COALESCE(NULL, {Due})').type).toBe('date');
    expect(parsed('{Tags}').type).toBe('list');
    expect(parsed('{Status}').type).toBe('text');
  });

  it('reports lexical errors with their position', () => {
    expect(failure('"open')).toMatchObject({ code: 'unterminated_string', start: 0, end: 5 });
    expect(failure('{Name')).toMatchObject({ code: 'unterminated_field', start: 0 });
    expect(failure('{ } + 1')).toMatchObject({ code: 'empty_field', start: 0, end: 3 });
    expect(failure('1 # 2')).toMatchObject({ code: 'unexpected_character', start: 2, end: 3, params: { token: '#' } });
    expect(failure('12abc')).toMatchObject({ code: 'invalid_number', start: 0, end: 5 });
  });

  it('reports syntax errors with their position', () => {
    expect(failure('')).toMatchObject({ code: 'empty' });
    expect(failure('   ')).toMatchObject({ code: 'empty' });
    expect(failure('1 +')).toMatchObject({ code: 'unexpected_end', start: 3 });
    expect(failure('(1 + 2')).toMatchObject({ code: 'missing_closing_paren', start: 0, end: 1 });
    expect(failure('IF({Done}, 1')).toMatchObject({ code: 'missing_closing_paren', start: 2, end: 3 });
    expect(failure('1 + 2)')).toMatchObject({ code: 'unexpected_token', start: 5, params: { token: ')' } });
    expect(failure('1 2')).toMatchObject({ code: 'unexpected_token', start: 2, end: 3 });
    expect(failure('IF({Done} 1, 2)')).toMatchObject({ code: 'unexpected_token', start: 10 });
    expect(failure('SUM(1, 2)')).toMatchObject({ code: 'unknown_function', start: 0, end: 3, params: { name: 'SUM' } });
    expect(failure('数量 + 1')).toMatchObject({ code: 'bare_word', start: 0, end: 2, params: { word: '数量' } });
    expect(failure('ROUND + 1')).toMatchObject({ code: 'unexpected_token', start: 0, end: 5 });
    expect(failure('x'.repeat(TABLE_FORMULA_MAX_LENGTH + 1))).toMatchObject({ code: 'too_long' });
  });

  it('refuses unknown and computed fields at the reference', () => {
    expect(failure('{Nope} + 1')).toMatchObject({ code: 'unknown_field', start: 0, end: 6, params: { name: 'Nope' } });
    expect(failure('{#99}')).toMatchObject({ code: 'unknown_field' });
    expect(failure('1 + {Total}')).toMatchObject({
      code: 'computed_field',
      start: 4,
      end: 11,
      params: { name: 'Total' },
    });
  });

  it('checks arity, argument kinds and units against the catalog', () => {
    expect(failure('IF({Done})')).toMatchObject({ code: 'too_few_arguments', start: 0, end: 10, params: { min: 2 } });
    expect(failure('ABS(1, 2)')).toMatchObject({ code: 'too_many_arguments', start: 7, end: 8, params: { max: 1 } });
    expect(failure(`MAX(${Array.from({ length: 11 }, (_, index) => index).join(', ')})`)).toMatchObject({
      code: 'too_many_arguments',
      params: { max: 10 },
    });
    expect(failure('{Name} + 1')).toMatchObject({ code: 'text_in_arithmetic', start: 0, end: 6 });
    expect(failure('{Due} - {Start}')).toMatchObject({ code: 'date_in_arithmetic', start: 0, end: 5 });
    expect(failure('{Tags} * 2')).toMatchObject({ code: 'type_mismatch' });
    expect(failure('ABS({Name})')).toMatchObject({ code: 'type_mismatch', start: 4, params: { expected: 'number' } });
    expect(failure('YEAR({数量})')).toMatchObject({ code: 'type_mismatch', params: { expected: 'date' } });
    expect(failure('YEAR("soon")')).toMatchObject({ code: 'type_mismatch', params: { expected: 'date' } });
    expect(failure('DATEDIFF({Due}, {Start}, "hours")')).toMatchObject({ code: 'invalid_unit', start: 25, end: 32 });
    expect(failure('DATEADD({Due}, 1, {Name})')).toMatchObject({ code: 'invalid_unit' });
    // Numbers in text literals, text fields and date literals are accepted where they make sense.
    expect(parsed('"2" * 3').type).toBe('number');
    expect(parsed('YEAR("2026-03-01")').type).toBe('number');
    expect(parsed('MONTH({Name})').type).toBe('number');
    expect(parsed('{Done} + 1').type).toBe('number');
    expect(parsed('DATEDIFF({Due}, {Start}, "Month")').type).toBe('number');
  });

  it('refuses formulas over the depth and node limits', () => {
    const deep = `${'ABS('.repeat(13)}1${')'.repeat(13)}`;
    expect(failure(deep)).toMatchObject({ code: 'too_complex' });
    const wide = Array.from({ length: 60 }, () => '1').join(' + ');
    expect(failure(wide)).toMatchObject({ code: 'too_complex' });
  });
});

describe('checkTableFormula (stored ASTs)', () => {
  it('passes valid ASTs and reports stored-field and arity problems without positions', () => {
    expect(
      checkTableFormula({ type: 'binary', operator: 'and', left: field(6), right: literal(true) }, fields),
    ).toEqual({ ok: true, type: 'boolean' });
    expect(checkTableFormula(field(8), fields)).toMatchObject({
      ok: false,
      error: { code: 'computed_field', start: 0, end: 0, message: expect.stringContaining('stored fields only') },
    });
    expect(checkTableFormula(field(42), fields)).toMatchObject({
      ok: false,
      error: { code: 'unknown_field', message: 'Formula field 42 is unavailable' },
    });
    expect(checkTableFormula({ type: 'function', name: 'mod', args: [literal(1)] }, fields)).toMatchObject({
      ok: false,
      error: { code: 'too_few_arguments' },
    });
  });

  it('gives every catalog function a spec matching TABLE_FORMULA_FUNCTIONS', () => {
    expect(Object.keys(TABLE_FORMULA_FUNCTION_CATALOG).sort()).toEqual([...TABLE_FORMULA_FUNCTIONS].sort());
    for (const spec of Object.values(TABLE_FORMULA_FUNCTION_CATALOG)) {
      expect(spec.params.length).toBeGreaterThan(0);
      expect(spec.maxArgs === null || spec.maxArgs >= spec.minArgs).toBe(true);
    }
  });
});

describe('formatTableFormula', () => {
  const roundTrips = [
    'IF({数量} > 10, "大单", "小单")',
    'DATEDIFF({Due}, {Start}, "days")',
    '1 + 2 * 3',
    '(1 + 2) * 3',
    '10 - (4 - 3)',
    '10 - 4 - 3',
    '-{数量} * 2',
    '-({数量} + 1)',
    '--{数量}',
    '2 - -3',
    '0 - 5',
    '{Name} & " " & UPPER({Status})',
    '{Name} & ({Name} & "x")',
    '{数量} > 1 = TRUE',
    '{数量} = (1 = TRUE)',
    'AND({Done}, NOT(OR({Done}, FALSE)), NULL)',
    'ROUND({数量} / 3, 2)',
    '{Price \\{net\\}} * 1.5',
    '"tab\\there \\"quoted\\" back\\\\slash"',
    'DATEADD({Seen at}, -1, "months")',
    'CONTAINS(LOWER({Name}), "acme")',
    'MIN({数量}, 3, MAX(1, 2))',
    '1e+21 + 1e-7',
  ];

  it.each(roundTrips)('round-trips %s', (text) => {
    const first = parsed(text);
    expect(formatTableFormula(first.expression, fields)).toBe(text);
    expect(parsed(formatTableFormula(first.expression, fields)).expression).toEqual(first.expression);
  });

  it('normalizes spelling and spacing to the canonical text', () => {
    const canonical = (text: string) => formatTableFormula(parsed(text).expression, fields);
    expect(canonical('if({name}<>"a",1,2)')).toBe('IF({Name} != "a", 1, 2)');
    expect(canonical('((1))+((2))')).toBe('1 + 2');
    expect(canonical('({数量} > 1) = TRUE')).toBe('{数量} > 1 = TRUE');
    expect(canonical("'x'")).toBe('"x"');
  });

  it('prints legacy binary and / or as functions and missing fields as {#id}', () => {
    const legacy: TableFormulaExpression = {
      type: 'binary',
      operator: 'or',
      left: { type: 'binary', operator: 'and', left: field(6), right: literal(true) },
      right: field(77),
    };
    expect(formatTableFormula(legacy, fields)).toBe('OR(AND({Done}, TRUE), {#77})');
    expect(parseTableFormula('OR(AND({Done}, TRUE), {#77})', fields)).toMatchObject({
      ok: false,
      error: { code: 'unknown_field' },
    });
  });
});

describe('editor support', () => {
  it('tokenizes with positions', () => {
    const result = tokenizeTableFormula('IF({A}, "b")');
    expect(result.ok && result.tokens.map((token) => [token.kind, token.start, token.end])).toEqual([
      ['identifier', 0, 2],
      ['lparen', 2, 3],
      ['field', 3, 6],
      ['comma', 6, 7],
      ['string', 8, 11],
      ['rparen', 11, 12],
      ['end', 12, 12],
    ]);
  });

  it('finds the field or function being typed at the caret', () => {
    expect(tableFormulaCompletionAt('{Na', 3)).toEqual({ kind: 'field', prefix: 'Na', start: 0, end: 3 });
    expect(tableFormulaCompletionAt('{Na} + 1', 2)).toEqual({ kind: 'field', prefix: 'N', start: 0, end: 4 });
    expect(tableFormulaCompletionAt('{Na + 1', 3)).toEqual({ kind: 'field', prefix: 'Na', start: 0, end: 3 });
    expect(tableFormulaCompletionAt('1 + da', 6)).toEqual({ kind: 'function', prefix: 'da', start: 4, end: 6 });
    expect(tableFormulaCompletionAt('IF(', 1)).toEqual({ kind: 'function', prefix: 'I', start: 0, end: 2 });
    expect(tableFormulaCompletionAt('"da', 3)).toBeNull();
    expect(tableFormulaCompletionAt('"{x" + ', 7)).toBeNull();
    expect(tableFormulaCompletionAt('1e', 2)).toBeNull();
    expect(tableFormulaCompletionAt('1 + ', 4)).toBeNull();
  });

  it('normalizes date units', () => {
    expect(normalizeTableFormulaDateUnit('Day')).toBe('days');
    expect(normalizeTableFormulaDateUnit(' weeks ')).toBe('weeks');
    expect(normalizeTableFormulaDateUnit('hours')).toBeNull();
    expect(normalizeTableFormulaDateUnit(3)).toBeNull();
  });
});

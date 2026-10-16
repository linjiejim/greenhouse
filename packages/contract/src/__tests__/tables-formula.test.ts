import { describe, expect, it } from 'vitest';
import {
  FORMULA_MAX_NODES,
  FORMULA_TEXT_RESULT_MAX,
  evaluateFormula,
  formatFormula,
  formulaCompletionAt,
  formulaFields,
  parseFormula,
  type FormulaExpression,
  type FormulaField,
  type FormulaValue,
} from '../tables-formula.js';

const fields: FormulaField[] = [
  { id: 'col_price', name: '单价', type: 'number' },
  { id: 'col_qty', name: 'Quantity', type: 'number' },
  { id: 'col_name', name: '名称', type: 'text' },
  { id: 'col_due', name: 'Due', type: 'date' },
  { id: 'col_start', name: 'Start', type: 'date' },
  { id: 'col_done', name: 'Done', type: 'boolean' },
  { id: 'col_tags', name: 'Tags', type: 'list' },
  { id: 'col_odd', name: 'A {strange} name', type: 'text' },
];

function parsed(text: string): FormulaExpression {
  const result = parseFormula(text, fields);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.expression;
}

const run = (text: string, values: Record<string, FormulaValue>) =>
  evaluateFormula(parsed(text), (id) => (id in values ? values[id]! : null));

describe('parsing', () => {
  it('reads fields by name (any case when unambiguous, or by id), functions in any case, full-width punctuation', () => {
    expect(formulaFields(parsed('{单价} * {quantity}'))).toEqual(['col_price', 'col_qty']);
    expect(formulaFields(parsed('{#col_due}'))).toEqual(['col_due']);
    expect(parsed('round（{单价}，2）')).toMatchObject({ type: 'function', name: 'round' });
    expect(parsed('IF({Done}, "是", "否")')).toMatchObject({ type: 'function', name: 'if' });
    expect(formulaFields(parsed('{A \\{strange\\} name} & "!"'))).toEqual(['col_odd']);
  });

  it('says what is wrong and where', () => {
    const cases: Array<[string, string]> = [
      ['', 'empty'],
      ['{单价} +', 'unexpected_end'],
      ['{Nope}', 'unknown_field'],
      ['FOO(1)', 'unknown_function'],
      ['price * 2', 'bare_word'],
      ['"open', 'unterminated_string'],
      ['ROUND()', 'too_few_arguments'],
      ['{名称} * 2', 'text_in_arithmetic'],
      ['{Due} + 1', 'date_in_arithmetic'],
      ['DATEADD({Due}, 1, "fortnights")', 'invalid_unit'],
      ['(1 + 2', 'missing_closing_paren'],
      ['12abc', 'invalid_number'],
      ['1 # 2', 'unexpected_character'],
    ];
    for (const [text, code] of cases) {
      const result = parseFormula(text, fields);
      expect(result.ok ? null : result.error.code, text).toBe(code);
    }
    const missing = parseFormula('{单价} * {Nope}', fields);
    expect(missing.ok ? null : [missing.error.start, missing.error.end]).toEqual([7, 13]);
  });

  it('refuses formulas past the size limits', () => {
    const big = Array.from({ length: FORMULA_MAX_NODES }, () => '1').join(' + ');
    const result = parseFormula(big, fields);
    expect(result.ok ? null : result.error.code).toBe('too_complex');
    const deep = `${'('.repeat(50)}1${')'.repeat(50)}`;
    expect(parseFormula(deep, fields).ok).toBe(false);
  });

  it('infers what a formula yields', () => {
    const typeOf = (text: string) => {
      const result = parseFormula(text, fields);
      return result.ok ? result.type : result.error.code;
    };
    expect(typeOf('{单价} * {Quantity}')).toBe('number');
    expect(typeOf('{名称} & "!"')).toBe('text');
    expect(typeOf('{单价} > 10')).toBe('boolean');
    expect(typeOf('DATEADD({Due}, 3)')).toBe('date');
    expect(typeOf('IF({Done}, 1, 2)')).toBe('number');
    expect(typeOf('IF({Done}, 1, "x")')).toBe('unknown');
  });

  it('prints with today’s names and reads back the same', () => {
    const text = 'IF({单价} * {Quantity} > 100, UPPER({名称}), -{单价} / (2 + 3))';
    const expression = parsed(text);
    const printed = formatFormula(expression, fields);
    expect(parsed(printed)).toEqual(expression);
    const renamed = fields.map((field) => (field.id === 'col_price' ? { ...field, name: 'Price' } : field));
    expect(formatFormula(expression, renamed)).toContain('{Price}');
    expect(formatFormula(expression, fields.slice(1))).toContain('{#col_price}');
  });

  it('knows what to complete at the caret', () => {
    expect(formulaCompletionAt('{单价} * {Qu', 10)).toEqual({ kind: 'field', prefix: 'Qu', start: 7, end: 10 });
    expect(formulaCompletionAt('ROU', 3)).toEqual({ kind: 'function', prefix: 'ROU', start: 0, end: 3 });
    expect(formulaCompletionAt('"ROU', 4)).toBeNull();
  });
});

describe('evaluating', () => {
  it('does arithmetic, text and comparisons; empty values count as 0 in sums', () => {
    expect(run('{单价} * {Quantity}', { col_price: 12.5, col_qty: 4 })).toBe(50);
    expect(run('{单价} + {Quantity}', { col_price: 3 })).toBe(3);
    expect(run('{名称} & " (" & {Quantity} & ")"', { col_name: '笔', col_qty: 2 })).toBe('笔 (2)');
    expect(run('{单价} > 10', { col_price: 12 })).toBe(true);
    expect(run('{名称} = "Done"', { col_name: 'Done' })).toBe(true);
    expect(run('{Tags} & ""', { col_tags: ['a', 'b'] })).toBe('a, b');
  });

  it('turns failures into values that carry on', () => {
    expect(run('{单价} / {Quantity}', { col_price: 1, col_qty: 0 })).toEqual({ error: 'div_zero' });
    expect(run('ROUND({单价} / {Quantity}, 2) + 1', { col_price: 1, col_qty: 0 })).toEqual({ error: 'div_zero' });
    expect(run('MOD(5, 0)', {})).toEqual({ error: 'div_zero' });
    expect(run('{单价} * 2', { col_price: 'abc' })).toEqual({ error: 'not_number' });
    expect(run('{单价} * 2', { col_price: { error: 'missing_field' } })).toEqual({ error: 'missing_field' });
  });

  it('looks only at the branch it takes', () => {
    expect(run('IF({Quantity} = 0, 0, {单价} / {Quantity})', { col_price: 5, col_qty: 0 })).toBe(0);
    expect(run('COALESCE({名称}, "无名")', {})).toBe('无名');
    expect(run('AND({Done}, {单价} / 0)', { col_done: false })).toBe(false);
    expect(run('OR({Done}, {单价} / 0)', { col_done: true })).toBe(true);
  });

  it('has the catalog of functions', () => {
    expect(run('ROUND(3.14159, 2)', {})).toBe(3.14);
    expect(run('ABS(-2) + FLOOR(1.7) + CEIL(1.2)', {})).toBe(5);
    expect(run('MIN(3, 1, 2) + MAX(3, 1, 2)', {})).toBe(4);
    expect(run('MOD(-7, 3)', {})).toBe(2);
    expect(run('LEN("你好呀") + LEN(TRIM("  a "))', {})).toBe(4);
    expect(run('LEFT("abcdef", 2) & RIGHT("abcdef", 2)', {})).toBe('abef');
    expect(run('CONTAINS("Hello World", "world")', {})).toBe(true);
    expect(run('NOT(FALSE)', {})).toBe(true);
    expect(run('LOWER("ABC") & UPPER("d")', {})).toBe('abcD');
    expect(run('CONCAT("a", 1, TRUE)', {})).toBe('a1true');
  });

  it('works with dates in UTC', () => {
    const dates = { col_due: '2026-10-31', col_start: '2026-10-01' };
    expect(run('DATEDIFF({Due}, {Start})', dates)).toBe(30);
    expect(run('DATEDIFF({Due}, {Start}, "weeks")', dates)).toBe(4);
    expect(run('DATEADD({Due}, 1, "month")', dates)).toBe('2026-11-30');
    expect(run('DATEADD({Due}, -1, "years")', dates)).toBe('2025-10-31');
    expect(run('YEAR({Due}) * 100 + MONTH({Due})', dates)).toBe(202610);
    expect(run('DAY({Due})', dates)).toBe(31);
    expect(run('DATEDIFF({Due}, {Start})', { col_due: 'soon' })).toBeNull();
    expect(run('{Due} > {Start}', dates)).toBe(true);
  });

  it('keeps text results bounded', () => {
    const long = 'x'.repeat(9000);
    const result = run('{名称} & {名称}', { col_name: long });
    expect(typeof result === 'string' ? result.length : 0).toBe(FORMULA_TEXT_RESULT_MAX);
  });
});

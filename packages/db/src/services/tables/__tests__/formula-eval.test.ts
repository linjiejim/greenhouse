/**
 * The formula evaluator, function by function: every catalog entry, the value
 * rules (empty as 0 in arithmetic, truthiness, strict equality, date ordering),
 * DATEDIFF / DATEADD units, select labels, and the operators written as text.
 */

import { describe, expect, it } from 'vitest';
import { parseTableFormula, type TableFormulaField } from '@greenhouse/types/table-formula';
import { TABLE_FORMULA_FUNCTIONS, type TableFormulaExpression } from '@greenhouse/types/tables';
import { evaluateTableFormula, resolveFormulaInput } from '../formula-eval.js';

const fields: TableFormulaField[] = [
  { id: 1, name: 'Name', type: 'text' },
  { id: 2, name: 'Qty', type: 'number' },
  { id: 3, name: 'Start', type: 'date' },
  { id: 4, name: 'Due', type: 'date' },
  { id: 5, name: 'At', type: 'datetime' },
  { id: 6, name: 'Done', type: 'boolean' },
  { id: 7, name: 'Empty', type: 'number' },
  { id: 8, name: 'Tags', type: 'multi_select' },
  { id: 9, name: 'Ended', type: 'date' },
];

const record: Record<string, unknown> = {
  '1': '  Acme Corp ',
  '2': 12,
  '3': '2026-01-31',
  '4': '2026-03-15',
  '5': '2026-03-10T17:30:00.000Z',
  '6': true,
  '8': [],
};

/** Parse with the real text syntax, then evaluate against `values`. */
function run(text: string, values: Record<string, unknown> = record): unknown {
  const parsed = parseTableFormula(text, fields);
  if (!parsed.ok) throw new Error(`${text}: ${parsed.error.message}`);
  return evaluateTableFormula(parsed.expression, (fieldId) => values[String(fieldId)]);
}

const covered = new Set<string>();
function fn(name: string) {
  covered.add(name);
  return name;
}

describe('evaluateTableFormula — operators', () => {
  it('evaluates the acceptance formulas', () => {
    expect(run('IF({Qty} > 10, "大单", "小单")')).toBe('大单');
    expect(run('IF({Qty} > 10, "大单", "小单")', { '2': 3 })).toBe('小单');
    expect(run('DATEDIFF({Due}, {Start}, "days")')).toBe(43);
  });

  it('keeps the original arithmetic rules: empty is 0, text is no number, / 0 is empty', () => {
    expect(run('{Empty} + 5')).toBe(5);
    expect(run('{Qty} * 2 - 4 / 2')).toBe(22);
    expect(run('-{Qty}')).toBe(-12);
    expect(run('{Qty} / 0')).toBeNull();
    expect(run('{Done} + 1')).toBe(2);
    // The editor refuses text in arithmetic; a stored AST that has it yields empty.
    const textTimesOne: TableFormulaExpression = {
      type: 'binary',
      operator: 'multiply',
      left: { type: 'field', fieldId: 1 },
      right: { type: 'literal', value: 1 },
    };
    expect(evaluateTableFormula(textTimesOne, (id) => record[String(id)])).toBeNull();
  });

  it('joins text with &, reading empty as ""', () => {
    expect(run('{Qty} & " pcs"')).toBe('12 pcs');
    expect(run('{Empty} & "-"')).toBe('-');
  });

  it('compares strictly for = and by kind for ordering', () => {
    expect(run('{Qty} = 12')).toBe(true);
    expect(run('{Qty} = "12"')).toBe(false);
    expect(run('{Qty} != 12')).toBe(false);
    expect(run('{Due} > {Start}')).toBe(true);
    expect(run('{At} >= "2026-03-10"')).toBe(true);
    expect(run('{Due} < "2026-01-01"')).toBe(false);
    expect(run('"b" > "a"')).toBe(true);
    expect(run('{Qty} <= 12')).toBe(true);
    expect(run('{Qty} < 12')).toBe(false);
    // An empty date is not before anything.
    expect(run('{Empty} < "2026-01-01"')).toBe(false);
  });
});

describe('evaluateTableFormula — every catalog function', () => {
  it(fn('if'), () => {
    expect(run('IF({Done}, "y", "n")')).toBe('y');
    expect(run('IF({Tags}, "y", "n")')).toBe('n');
    expect(run('IF({Empty}, "y")')).toBeNull();
  });

  it(fn('coalesce'), () => {
    expect(run('COALESCE({Empty}, NULL, {Qty}, 1)')).toBe(12);
    expect(run('COALESCE({Empty})')).toBeNull();
  });

  it(fn('concat'), () => {
    expect(run('CONCAT("#", {Qty}, {Empty}, TRUE)')).toBe('#12true');
  });

  it(fn('round'), () => {
    expect(run('ROUND(2.346, 2)')).toBe(2.35);
    expect(run('ROUND(2.5)')).toBe(3);
    expect(run('ROUND({Empty})')).toBe(0);
    expect(run('ROUND(1.23456, 99)')).toBe(1.23456);
  });

  it(fn('upper'), () => expect(run('UPPER("abc")')).toBe('ABC'));
  it(fn('lower'), () => expect(run('LOWER("ÀBC")')).toBe('àbc'));

  it(fn('abs'), () => {
    expect(run('ABS(-3.5)')).toBe(3.5);
    expect(run('ABS({Empty})')).toBe(0);
  });

  it(fn('floor'), () => {
    expect(run('FLOOR(2.7)')).toBe(2);
    expect(run('FLOOR(-2.1)')).toBe(-3);
  });

  it(fn('ceil'), () => {
    expect(run('CEIL(2.1)')).toBe(3);
    expect(run('CEIL(-0.5)')).toBe(0);
    expect(Object.is(run('CEIL(-0.5)'), -0)).toBe(false);
  });

  it(fn('min'), () => {
    expect(run('MIN({Qty}, 3, 7)')).toBe(3);
    expect(run('MIN({Empty}, 4)')).toBe(4);
    expect(run('MIN({Empty})')).toBeNull();
  });

  it(fn('max'), () => {
    expect(run('MAX({Qty}, 3, 7)')).toBe(12);
    expect(run('MAX(-1, {Empty})')).toBe(-1);
  });

  it(fn('mod'), () => {
    expect(run('MOD(7, 3)')).toBe(1);
    expect(run('MOD(-7, 3)')).toBe(2);
    expect(run('MOD(5.5, 2)')).toBe(1.5);
    expect(run('MOD(1, 0)')).toBeNull();
  });

  it(fn('len'), () => {
    expect(run('LEN({Name})')).toBe(12);
    expect(run('LEN("大单😀")')).toBe(3);
    expect(run('LEN({Empty})')).toBe(0);
  });

  it(fn('trim'), () => expect(run('TRIM({Name})')).toBe('Acme Corp'));

  it(fn('left'), () => {
    expect(run('LEFT(TRIM({Name}), 4)')).toBe('Acme');
    expect(run('LEFT("abc", -1)')).toBe('');
    expect(run('LEFT("大单😀", 3)')).toBe('大单😀');
  });

  it(fn('right'), () => {
    expect(run('RIGHT(TRIM({Name}), 4)')).toBe('Corp');
    expect(run('RIGHT("abc", 0)')).toBe('');
    expect(run('RIGHT("abc", 10)')).toBe('abc');
  });

  it(fn('contains'), () => {
    expect(run('CONTAINS({Name}, "acme")')).toBe(true);
    expect(run('CONTAINS({Name}, "globex")')).toBe(false);
    expect(run('CONTAINS({Empty}, "")')).toBe(true);
  });

  it(fn('and'), () => {
    expect(run('AND({Done}, {Qty} > 1, "x")')).toBe(true);
    expect(run('AND({Done}, {Empty})')).toBe(false);
  });

  it(fn('or'), () => {
    expect(run('OR({Empty}, 0, "")')).toBe(false);
    expect(run('OR({Empty}, {Qty})')).toBe(true);
  });

  it(fn('not'), () => {
    expect(run('NOT({Done})')).toBe(false);
    expect(run('NOT({Empty})')).toBe(true);
  });

  it(fn('year'), () => {
    expect(run('YEAR({Start})')).toBe(2026);
    expect(run('YEAR({Ended})')).toBeNull();
    expect(run('YEAR({Name})')).toBeNull();
  });

  it(fn('month'), () => {
    expect(run('MONTH({Start})')).toBe(1);
    expect(run('MONTH({At})')).toBe(3);
  });

  it(fn('day'), () => {
    expect(run('DAY({Due})')).toBe(15);
    // Datetimes are read in UTC: 17:30Z on the 10th is still the 10th.
    expect(run('DAY({At})')).toBe(10);
  });

  it(fn('datediff'), () => {
    expect(run('DATEDIFF({Due}, {Start})')).toBe(43);
    expect(run('DATEDIFF({Start}, {Due}, "days")')).toBe(-43);
    expect(run('DATEDIFF({Due}, {Start}, "weeks")')).toBe(6);
    expect(run('DATEDIFF({Due}, {Start}, "months")')).toBe(1);
    expect(run('DATEDIFF("2026-02-28", "2026-01-31", "months")')).toBe(0);
    expect(run('DATEDIFF("2026-03-31", "2026-01-31", "month")')).toBe(2);
    expect(run('DATEDIFF("2026-01-31", "2026-03-31", "months")')).toBe(-2);
    expect(run('DATEDIFF("2029-01-30", "2026-01-31", "years")')).toBe(2);
    expect(run('DATEDIFF("2029-01-31", "2026-01-31", "years")')).toBe(3);
    expect(run('DATEDIFF({At}, "2026-03-10", "days")')).toBe(0);
    expect(run('DATEDIFF({At}, "2026-03-09T18:00:00.000Z", "days")')).toBe(0);
    expect(run('DATEDIFF({At}, "2026-03-09T17:00:00.000Z", "days")')).toBe(1);
    expect(run('DATEDIFF({Ended}, {Start})')).toBeNull();
  });

  it(fn('dateadd'), () => {
    expect(run('DATEADD({Start}, 1, "months")')).toBe('2026-02-28');
    expect(run('DATEADD("2028-01-31", 1, "month")')).toBe('2028-02-29');
    expect(run('DATEADD({Start}, 10)')).toBe('2026-02-10');
    expect(run('DATEADD({Start}, -2, "weeks")')).toBe('2026-01-17');
    expect(run('DATEADD({Start}, 1, "years")')).toBe('2027-01-31');
    expect(run('DATEADD({Start}, -13, "months")')).toBe('2024-12-31');
    expect(run('DATEADD({At}, 1, "days")')).toBe('2026-03-11T17:30:00.000Z');
    expect(run('DATEADD({At}, 1, "months")')).toBe('2026-04-10T17:30:00.000Z');
    expect(run('DATEADD({Start}, 1.9, "days")')).toBe('2026-02-01');
    expect(run('DATEADD({Ended}, 1)')).toBeNull();
    expect(run('DATEADD({Start}, {Empty})')).toBe('2026-01-31');
    const badUnit: TableFormulaExpression = {
      type: 'function',
      name: 'dateadd',
      args: [
        { type: 'field', fieldId: 3 },
        { type: 'literal', value: 1 },
        { type: 'literal', value: 'hours' },
      ],
    };
    expect(evaluateTableFormula(badUnit, (id) => record[String(id)])).toBeNull();
  });

  it('covers every function in TABLE_FORMULA_FUNCTIONS', () => {
    expect([...covered].sort()).toEqual([...TABLE_FORMULA_FUNCTIONS].sort());
  });
});

describe('evaluateTableFormula — stored ASTs', () => {
  const field = (fieldId: number): TableFormulaExpression => ({ type: 'field', fieldId });

  it('keeps the legacy binary and / or', () => {
    const both: TableFormulaExpression = { type: 'binary', operator: 'and', left: field(6), right: field(2) };
    expect(evaluateTableFormula(both, (id) => record[String(id)])).toBe(true);
    const either: TableFormulaExpression = { type: 'binary', operator: 'or', left: field(7), right: field(8) };
    expect(evaluateTableFormula(either, (id) => record[String(id)])).toBe(false);
  });

  it('never throws: an unevaluable formula is empty', () => {
    const exploding = () => {
      throw new Error('boom');
    };
    expect(evaluateTableFormula(field(1), exploding)).toBeNull();
  });
});

describe('resolveFormulaInput', () => {
  const options = [
    { id: 'won', label: 'Won' },
    { id: 'lost', label: 'Lost' },
  ];

  it('reads select options as their labels, unknown ids as themselves', () => {
    expect(resolveFormulaInput({ type: 'single_select', config: { options } }, 'won')).toBe('Won');
    expect(resolveFormulaInput({ type: 'single_select', config: { options } }, 'gone')).toBe('gone');
    expect(resolveFormulaInput({ type: 'multi_select', config: { options } }, ['lost', 'won'])).toEqual([
      'Lost',
      'Won',
    ]);
    expect(resolveFormulaInput({ type: 'text', config: {} }, 'won')).toBe('won');
    expect(resolveFormulaInput(undefined, 3)).toBe(3);
  });
});

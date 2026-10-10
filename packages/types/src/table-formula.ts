/**
 * Tables formula language — the text form people type and the function catalog.
 *
 * Formulas are stored as a JSON AST (`TableFormulaExpression` in `./tables`);
 * this module owns the text syntax that maps onto it:
 *
 *   {Field name}   "text"   12.5   true / false / null
 *   + - * /   &  (concatenate)   = != > >= < <=
 *   NAME(arg, …)   — case-insensitive function names from the catalog below
 *
 * No TODAY()/NOW(): formula results are computed on write and stored, so a
 * value depending on "today" would be wrong tomorrow (use a date-reached
 * automation instead).
 */

import type { TableFormulaFunction, TableFormulaResultType } from './tables.js';

export interface TableFormulaFunctionSpec {
  name: TableFormulaFunction;
  minArgs: number;
  /** null = variadic. */
  maxArgs: number | null;
  /** 'same' = the type of the first non-null argument. */
  result: TableFormulaResultType | 'same';
}

/** Arity and result typing for every function in `TABLE_FORMULA_FUNCTIONS`. */
export const TABLE_FORMULA_FUNCTION_CATALOG: Readonly<Record<TableFormulaFunction, TableFormulaFunctionSpec>> =
  Object.freeze({
    if: { name: 'if', minArgs: 2, maxArgs: 3, result: 'same' },
    coalesce: { name: 'coalesce', minArgs: 1, maxArgs: null, result: 'same' },
    concat: { name: 'concat', minArgs: 1, maxArgs: null, result: 'text' },
    round: { name: 'round', minArgs: 1, maxArgs: 2, result: 'number' },
    upper: { name: 'upper', minArgs: 1, maxArgs: 1, result: 'text' },
    lower: { name: 'lower', minArgs: 1, maxArgs: 1, result: 'text' },
    abs: { name: 'abs', minArgs: 1, maxArgs: 1, result: 'number' },
    floor: { name: 'floor', minArgs: 1, maxArgs: 1, result: 'number' },
    ceil: { name: 'ceil', minArgs: 1, maxArgs: 1, result: 'number' },
    min: { name: 'min', minArgs: 1, maxArgs: null, result: 'number' },
    max: { name: 'max', minArgs: 1, maxArgs: null, result: 'number' },
    mod: { name: 'mod', minArgs: 2, maxArgs: 2, result: 'number' },
    len: { name: 'len', minArgs: 1, maxArgs: 1, result: 'number' },
    trim: { name: 'trim', minArgs: 1, maxArgs: 1, result: 'text' },
    left: { name: 'left', minArgs: 2, maxArgs: 2, result: 'text' },
    right: { name: 'right', minArgs: 2, maxArgs: 2, result: 'text' },
    contains: { name: 'contains', minArgs: 2, maxArgs: 2, result: 'boolean' },
    and: { name: 'and', minArgs: 1, maxArgs: null, result: 'boolean' },
    or: { name: 'or', minArgs: 1, maxArgs: null, result: 'boolean' },
    not: { name: 'not', minArgs: 1, maxArgs: 1, result: 'boolean' },
    year: { name: 'year', minArgs: 1, maxArgs: 1, result: 'number' },
    month: { name: 'month', minArgs: 1, maxArgs: 1, result: 'number' },
    day: { name: 'day', minArgs: 1, maxArgs: 1, result: 'number' },
    datediff: { name: 'datediff', minArgs: 2, maxArgs: 3, result: 'number' },
    dateadd: { name: 'dateadd', minArgs: 2, maxArgs: 3, result: 'date' },
  });

/** Units accepted by DATEDIFF / DATEADD (third argument, default "days"). */
export const TABLE_FORMULA_DATE_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type TableFormulaDateUnit = (typeof TABLE_FORMULA_DATE_UNITS)[number];

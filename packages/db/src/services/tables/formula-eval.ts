/**
 * The formula evaluator: one stored AST + one record's values → one value.
 * Pure (no database), so every catalog function is unit-tested directly.
 *
 * Value rules, kept from the original evaluator and extended to the catalog:
 * - Arithmetic (`+ - * /`) and the numeric functions read an empty value as 0
 *   (`Number(null)`); text that is not a number makes the result empty; `/`
 *   and MOD by zero are empty. MIN / MAX skip empty arguments (all empty → empty).
 * - `&`, CONCAT and the text functions read an empty value as "".
 * - IF / AND / OR / NOT use truthiness: empty, 0, false, "" and [] are false.
 * - `=` / `!=` are strict (a number never equals text). `> >= < <=` compare
 *   ISO dates by instant, numbers numerically, other text alphabetically;
 *   anything else is false.
 * - Date functions take a `YYYY-MM-DD` date or an ISO datetime and work in
 *   UTC (results are stored once for every reader); anything else → empty.
 * - Select fields read as their option labels (`resolveFormulaInput`), so
 *   `{Status} = "Done"` means what it says.
 */

import { normalizeTableFormulaDateUnit, type TableFormulaDateUnit } from '@greenhouse/types/table-formula';
import type { TableFieldConfig, TableFormulaExpression } from '@greenhouse/types/tables';

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

function isBlank(value: unknown): boolean {
  return value === null || value === undefined || value === '';
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** `Number(value)` for scalars (empty → 0, as `+ - * /` always did); lists are not numbers. */
function toNumber(value: unknown): number {
  if (Array.isArray(value)) return Number.NaN;
  return Number(value);
}

function toText(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

function finiteOrNull(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  return value === 0 ? 0 : value;
}

interface FormulaDate {
  ms: number;
  dateOnly: boolean;
}

function toDate(value: unknown): FormulaDate | null {
  if (typeof value !== 'string') return null;
  const day = DATE_ONLY.exec(value);
  if (day) {
    const ms = Date.UTC(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
    return new Date(ms).toISOString().slice(0, 10) === value ? { ms, dateOnly: true } : null;
  }
  if (!ISO_DATETIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : { ms, dateOnly: false };
}

function formatDate(ms: number, dateOnly: boolean): string | null {
  const date = new Date(ms);
  if (Number.isNaN(date.valueOf())) return null;
  const iso = date.toISOString();
  return dateOnly ? iso.slice(0, 10) : iso;
}

/** Whole calendar months from `start` to `end`, truncated toward zero (Jan 31 → Feb 28 is 0). */
function monthsBetween(end: number, start: number): number {
  const a = new Date(end);
  const b = new Date(start);
  let months = (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth());
  const aRest = end - Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1);
  const bRest = start - Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), 1);
  if (months > 0 && aRest < bRest) months -= 1;
  else if (months < 0 && aRest > bRest) months += 1;
  return months;
}

function dateDiff(endValue: unknown, startValue: unknown, unitValue: unknown): number | null {
  const end = toDate(endValue);
  const start = toDate(startValue);
  const unit = unitValue === undefined ? 'days' : normalizeTableFormulaDateUnit(unitValue);
  if (!end || !start || !unit) return null;
  const elapsed = end.ms - start.ms;
  const result =
    unit === 'days'
      ? Math.trunc(elapsed / DAY_MS)
      : unit === 'weeks'
        ? Math.trunc(elapsed / (7 * DAY_MS))
        : unit === 'months'
          ? monthsBetween(end.ms, start.ms)
          : Math.trunc(monthsBetween(end.ms, start.ms) / 12);
  return finiteOrNull(result);
}

/** Add calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28 / 29). */
function addMonths(ms: number, count: number): number {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const timeOfDay = ms - Date.UTC(year, month, day);
  const target = month + count;
  const targetYear = year + Math.floor(target / 12);
  const targetMonth = ((target % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)) + timeOfDay;
}

function dateAdd(dateValue: unknown, amountValue: unknown, unitValue: unknown): string | null {
  const date = toDate(dateValue);
  const unit: TableFormulaDateUnit | null = unitValue === undefined ? 'days' : normalizeTableFormulaDateUnit(unitValue);
  const amount = Math.trunc(toNumber(amountValue));
  if (!date || !unit || !Number.isFinite(amount)) return null;
  const ms =
    unit === 'days'
      ? date.ms + amount * DAY_MS
      : unit === 'weeks'
        ? date.ms + amount * 7 * DAY_MS
        : addMonths(date.ms, unit === 'months' ? amount : amount * 12);
  return formatDate(ms, date.dateOnly);
}

function datePart(value: unknown, part: 'year' | 'month' | 'day'): number | null {
  const date = toDate(value);
  if (!date) return null;
  const at = new Date(date.ms);
  if (part === 'year') return at.getUTCFullYear();
  if (part === 'month') return at.getUTCMonth() + 1;
  return at.getUTCDate();
}

/** Ordering for `> >= < <=`; null = not comparable (the comparison is false). */
function compare(left: unknown, right: unknown): number | null {
  const leftDate = typeof left === 'string' ? toDate(left) : null;
  const rightDate = typeof right === 'string' ? toDate(right) : null;
  if (leftDate && rightDate) return leftDate.ms - rightDate.ms;
  const leftNumber = toNumber(left);
  const rightNumber = toNumber(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber - rightNumber;
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  return null;
}

function codePoints(value: unknown): string[] {
  return Array.from(toText(value));
}

function count(value: unknown): number {
  const number = Math.trunc(toNumber(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function evaluate(expression: TableFormulaExpression, read: (fieldId: number) => unknown): unknown {
  if (expression.type === 'literal') return expression.value;
  if (expression.type === 'field') return read(expression.fieldId) ?? null;
  if (expression.type === 'binary') {
    const left = evaluate(expression.left, read);
    const right = evaluate(expression.right, read);
    switch (expression.operator) {
      case 'concat':
        return `${toText(left)}${toText(right)}`;
      case 'and':
        return truthy(left) && truthy(right);
      case 'or':
        return truthy(left) || truthy(right);
      case 'eq':
        return left === right;
      case 'neq':
        return left !== right;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const order = compare(left, right);
        if (order === null) return false;
        if (expression.operator === 'gt') return order > 0;
        if (expression.operator === 'gte') return order >= 0;
        if (expression.operator === 'lt') return order < 0;
        return order <= 0;
      }
      default: {
        const a = toNumber(left);
        const b = toNumber(right);
        if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
        if (expression.operator === 'add') return finiteOrNull(a + b);
        if (expression.operator === 'subtract') return finiteOrNull(a - b);
        if (expression.operator === 'multiply') return finiteOrNull(a * b);
        return b === 0 ? null : finiteOrNull(a / b);
      }
    }
  }
  const args = expression.args.map((argument) => evaluate(argument, read));
  const [first, second, third] = args;
  switch (expression.name) {
    case 'if':
      return truthy(first) ? (second ?? null) : (third ?? null);
    case 'coalesce':
      return args.find((value) => value !== null && value !== undefined) ?? null;
    case 'concat':
      return args.map(toText).join('');
    case 'upper':
      return toText(first).toUpperCase();
    case 'lower':
      return toText(first).toLowerCase();
    case 'trim':
      return toText(first).trim();
    case 'len':
      return codePoints(first).length;
    case 'left':
      return codePoints(first).slice(0, count(second)).join('');
    case 'right': {
      const take = count(second);
      return take === 0 ? '' : codePoints(first).slice(-take).join('');
    }
    case 'contains':
      return toText(first).toLowerCase().includes(toText(second).toLowerCase());
    case 'and':
      return args.every(truthy);
    case 'or':
      return args.some(truthy);
    case 'not':
      return !truthy(first);
    case 'round': {
      const value = toNumber(first);
      const precision = Math.min(Math.max(Number(second ?? 0), 0), 10);
      return Number.isFinite(value) ? Number(value.toFixed(precision)) : null;
    }
    case 'abs':
      return finiteOrNull(Math.abs(toNumber(first)));
    case 'floor':
      return finiteOrNull(Math.floor(toNumber(first)));
    case 'ceil':
      return finiteOrNull(Math.ceil(toNumber(first)));
    case 'mod': {
      const a = toNumber(first);
      const b = toNumber(second);
      if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
      return finiteOrNull(a - b * Math.floor(a / b));
    }
    case 'min':
    case 'max': {
      const numbers = args
        .filter((value) => !isBlank(value))
        .map(toNumber)
        .filter(Number.isFinite);
      if (numbers.length === 0) return null;
      return expression.name === 'min' ? Math.min(...numbers) : Math.max(...numbers);
    }
    case 'year':
    case 'month':
    case 'day':
      return datePart(first, expression.name);
    case 'datediff':
      return dateDiff(first, second, args.length > 2 ? third : undefined);
    case 'dateadd':
      return dateAdd(first, second, args.length > 2 ? third : undefined);
  }
}

/**
 * Evaluate a stored formula against one record. `read` returns a field's
 * value as formulas see it (see `resolveFormulaInput`). Never throws: a
 * formula that cannot be evaluated yields null rather than failing the write.
 */
export function evaluateTableFormula(expression: TableFormulaExpression, read: (fieldId: number) => unknown): unknown {
  try {
    return evaluate(expression, read) ?? null;
  } catch {
    return null;
  }
}

/**
 * A stored value as formulas and lookups see it: select option ids become
 * their labels (an id no longer configured stays as is); everything else is
 * the stored value.
 */
export function resolveFormulaInput(
  field: { type: string; config: TableFieldConfig } | undefined,
  value: unknown,
): unknown {
  if (!field || (field.type !== 'single_select' && field.type !== 'multi_select')) return value;
  const labels = new Map((field.config.options ?? []).map((option) => [option.id, option.label]));
  if (field.type === 'single_select') return typeof value === 'string' ? (labels.get(value) ?? value) : value;
  return Array.isArray(value)
    ? value.map((entry) => (typeof entry === 'string' ? (labels.get(entry) ?? entry) : entry))
    : value;
}

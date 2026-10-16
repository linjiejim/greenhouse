/**
 * The 表格 formula language: the text people type, the functions it has, the checks the editor
 * and the server share, and the evaluator. Formulas are kept as an expression tree (field ids,
 * not names), so renaming a field never breaks one; the text is printed with today's names.
 *
 *   {Field name}   "text"   12.5   TRUE / FALSE / NULL
 *   + - * /   &  (joins text)   = != <> > >= < <=
 *   NAME(arg, …)   — function names in any case, from the catalog below
 *
 * Precedence, loosest first: comparison < & < + - < * / < unary minus; left-associative.
 * Inside braces `\}` and `\\` escape; inside strings `\"`, `\\`, `\n`, `\t`. Full-width
 * `（ ） ，` and curly quotes read like their ASCII forms, so a Chinese input method does not
 * trip the parser. `{#col_…}` names a field by id (how a field that is gone prints).
 *
 * Evaluation is pure and bounded: at most FORMULA_MAX_NODES nodes, text at most
 * FORMULA_TEXT_RESULT_MAX characters, no loops, no `eval`. Failures are values: `{ error }`
 * (division by zero, text where a number belongs, a field that is gone), shown in the cell.
 * There is no TODAY()/NOW(): values are worked out when records change and kept, so a value
 * depending on the day would be wrong tomorrow.
 *
 * Adapted from the formula language of PR #64 (packages/types/src/table-formula.ts there).
 */

import { z } from 'zod';
import type { ComputedError, FieldType } from './tables.js';

// ── Limits ────────────────────────────────────────────────

export const FORMULA_MAX_DEPTH = 12;
export const FORMULA_MAX_NODES = 100;
export const FORMULA_MAX_ARGS = 10;
export const FORMULA_MAX_LENGTH = 4000;
/** Longest text a formula yields; longer is cut. */
export const FORMULA_TEXT_RESULT_MAX = 10_000;

// ── The expression tree ───────────────────────────────────

export const FORMULA_FUNCTIONS = [
  'if',
  'coalesce',
  'concat',
  'round',
  'upper',
  'lower',
  'abs',
  'floor',
  'ceil',
  'min',
  'max',
  'mod',
  'len',
  'trim',
  'left',
  'right',
  'contains',
  'and',
  'or',
  'not',
  'year',
  'month',
  'day',
  'datediff',
  'dateadd',
] as const;
export type FormulaFunction = (typeof FORMULA_FUNCTIONS)[number];
export const FORMULA_OPERATORS = [
  'add',
  'subtract',
  'multiply',
  'divide',
  'concat',
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
] as const;
export type FormulaOperator = (typeof FORMULA_OPERATORS)[number];

export type FormulaExpression =
  | { type: 'literal'; value: string | number | boolean | null }
  | { type: 'field'; field: string }
  | { type: 'binary'; op: FormulaOperator; left: FormulaExpression; right: FormulaExpression }
  | { type: 'function'; name: FormulaFunction; args: FormulaExpression[] };

/** A stored expression, read back with the same limits it was saved under. */
export const formulaExpressionSchema: z.ZodType<FormulaExpression> = z.lazy(() =>
  z.union([
    z.object({
      type: z.literal('literal'),
      value: z.union([z.string().max(FORMULA_MAX_LENGTH), z.number(), z.boolean(), z.null()]),
    }),
    z.object({ type: z.literal('field'), field: z.string().min(1).max(64) }),
    z.object({
      type: z.literal('binary'),
      op: z.enum(FORMULA_OPERATORS),
      left: formulaExpressionSchema,
      right: formulaExpressionSchema,
    }),
    z.object({
      type: z.literal('function'),
      name: z.enum(FORMULA_FUNCTIONS),
      args: z.array(formulaExpressionSchema).max(FORMULA_MAX_ARGS),
    }),
  ]),
);

// ── The catalog ───────────────────────────────────────────

/** `any` takes everything; `number` refuses text, dates and lists; `date` a date or date-time; `unit` a literal unit. */
export type FormulaParamKind = 'any' | 'number' | 'date' | 'unit';
/** What an expression yields as far as the checker can tell. */
export type FormulaValueType = 'text' | 'number' | 'boolean' | 'date' | 'datetime' | 'list' | 'null' | 'unknown';

export interface FormulaFunctionSpec {
  name: FormulaFunction;
  minArgs: number;
  /** null: any number (still at most FORMULA_MAX_ARGS). */
  maxArgs: number | null;
  /** By position; a variadic function repeats the last. */
  params: readonly FormulaParamKind[];
  /** `same`: the common type of its value arguments (IF: its branches; COALESCE: all). */
  result: Exclude<FormulaValueType, 'list' | 'null' | 'unknown'> | 'same';
}

export const FORMULA_CATALOG: Readonly<Record<FormulaFunction, FormulaFunctionSpec>> = Object.freeze({
  if: { name: 'if', minArgs: 2, maxArgs: 3, params: ['any', 'any', 'any'], result: 'same' },
  coalesce: { name: 'coalesce', minArgs: 1, maxArgs: null, params: ['any'], result: 'same' },
  concat: { name: 'concat', minArgs: 1, maxArgs: null, params: ['any'], result: 'text' },
  round: { name: 'round', minArgs: 1, maxArgs: 2, params: ['number', 'number'], result: 'number' },
  upper: { name: 'upper', minArgs: 1, maxArgs: 1, params: ['any'], result: 'text' },
  lower: { name: 'lower', minArgs: 1, maxArgs: 1, params: ['any'], result: 'text' },
  abs: { name: 'abs', minArgs: 1, maxArgs: 1, params: ['number'], result: 'number' },
  floor: { name: 'floor', minArgs: 1, maxArgs: 1, params: ['number'], result: 'number' },
  ceil: { name: 'ceil', minArgs: 1, maxArgs: 1, params: ['number'], result: 'number' },
  min: { name: 'min', minArgs: 1, maxArgs: null, params: ['number'], result: 'number' },
  max: { name: 'max', minArgs: 1, maxArgs: null, params: ['number'], result: 'number' },
  mod: { name: 'mod', minArgs: 2, maxArgs: 2, params: ['number', 'number'], result: 'number' },
  len: { name: 'len', minArgs: 1, maxArgs: 1, params: ['any'], result: 'number' },
  trim: { name: 'trim', minArgs: 1, maxArgs: 1, params: ['any'], result: 'text' },
  left: { name: 'left', minArgs: 2, maxArgs: 2, params: ['any', 'number'], result: 'text' },
  right: { name: 'right', minArgs: 2, maxArgs: 2, params: ['any', 'number'], result: 'text' },
  contains: { name: 'contains', minArgs: 2, maxArgs: 2, params: ['any', 'any'], result: 'boolean' },
  and: { name: 'and', minArgs: 1, maxArgs: null, params: ['any'], result: 'boolean' },
  or: { name: 'or', minArgs: 1, maxArgs: null, params: ['any'], result: 'boolean' },
  not: { name: 'not', minArgs: 1, maxArgs: 1, params: ['any'], result: 'boolean' },
  year: { name: 'year', minArgs: 1, maxArgs: 1, params: ['date'], result: 'number' },
  month: { name: 'month', minArgs: 1, maxArgs: 1, params: ['date'], result: 'number' },
  day: { name: 'day', minArgs: 1, maxArgs: 1, params: ['date'], result: 'number' },
  datediff: { name: 'datediff', minArgs: 2, maxArgs: 3, params: ['date', 'date', 'unit'], result: 'number' },
  dateadd: { name: 'dateadd', minArgs: 2, maxArgs: 3, params: ['date', 'number', 'unit'], result: 'date' },
});

/** Units of DATEDIFF and DATEADD (third argument, default days). */
export const FORMULA_DATE_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type FormulaDateUnit = (typeof FORMULA_DATE_UNITS)[number];

/** "day", "Days", "weeks"… → the unit; null when it is not one. */
export function formulaDateUnit(value: unknown): FormulaDateUnit | null {
  if (typeof value !== 'string') return null;
  const unit = value.trim().toLowerCase();
  const plural = unit.endsWith('s') ? unit : `${unit}s`;
  return (FORMULA_DATE_UNITS as readonly string[]).includes(plural) ? (plural as FormulaDateUnit) : null;
}

/** A field a formula may name: its id, name, and the type its value reads as (see formulaTypeOf). */
export interface FormulaField {
  id: string;
  name: string;
  type: FormulaValueType;
}

/** The type a field's value reads as inside a formula: selects as their labels, lists as lists. */
export function formulaTypeOf(field: { type: FieldType; config: { result?: string | undefined } }): FormulaValueType {
  switch (field.type) {
    case 'number':
      return 'number';
    case 'checkbox':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'multi_select':
    case 'member':
    case 'attachment':
    case 'relation':
    case 'parent':
    case 'dependency':
    case 'lookup':
      return 'list';
    case 'formula':
    case 'rollup':
      return field.config.result === 'number'
        ? 'number'
        : field.config.result === 'checkbox'
          ? 'boolean'
          : field.config.result === 'date'
            ? 'date'
            : field.config.result === 'datetime'
              ? 'datetime'
              : field.type === 'rollup'
                ? 'number'
                : 'text';
    default:
      return 'text';
  }
}

/** What a formula result of this type is kept as (a field type the value behaves as). */
export function formulaResultOf(type: FormulaValueType): 'text' | 'number' | 'checkbox' | 'date' | 'datetime' {
  switch (type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'checkbox';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    default:
      return 'text';
  }
}

// ── Errors ────────────────────────────────────────────────

export type FormulaErrorCode =
  | 'empty'
  | 'too_long'
  | 'too_complex'
  | 'unexpected_character'
  | 'unterminated_string'
  | 'unterminated_field'
  | 'empty_field'
  | 'invalid_number'
  | 'unexpected_token'
  | 'unexpected_end'
  | 'missing_closing_paren'
  | 'unknown_field'
  | 'unknown_function'
  | 'bare_word'
  | 'too_few_arguments'
  | 'too_many_arguments'
  | 'type_mismatch'
  | 'text_in_arithmetic'
  | 'date_in_arithmetic'
  | 'invalid_unit';

/**
 * One problem at `[start, end)` in the text (both 0 when the tree did not come from text).
 * `message` is English for logs and Agents; screens translate `code` with `params`.
 */
export interface FormulaError {
  code: FormulaErrorCode;
  message: string;
  start: number;
  end: number;
  params?: Record<string, string | number>;
}

export type FormulaCheck = { ok: true; type: FormulaValueType } | { ok: false; error: FormulaError };
export type FormulaParse =
  | { ok: true; expression: FormulaExpression; type: FormulaValueType }
  | { ok: false; error: FormulaError };

interface Span {
  start: number;
  end: number;
}

class FormulaSyntaxError extends Error {
  constructor(readonly detail: FormulaError) {
    super(detail.message);
  }
}

function fail(code: FormulaErrorCode, message: string, span: Span, params?: Record<string, string | number>): never {
  throw new FormulaSyntaxError({ code, message, start: span.start, end: span.end, ...(params ? { params } : {}) });
}

// ── Tokens ────────────────────────────────────────────────

type TokenKind = 'number' | 'string' | 'field' | 'identifier' | 'operator' | 'lparen' | 'rparen' | 'comma' | 'end';

interface Token {
  kind: TokenKind;
  value: string | number;
  start: number;
  end: number;
}

const OPEN_QUOTES: Record<string, string[]> = { '"': ['"'], "'": ["'"], '“': ['”', '"'], '‘': ['’', "'"] };
const FULL_WIDTH: Record<string, string> = { '（': '(', '）': ')', '，': ',' };
const NUMBER_PATTERN = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const IDENTIFIER_START = /[\p{L}_]/u;
const IDENTIFIER_PART = /[\p{L}\p{N}_]/u;
const STRING_ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r' };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const start = index;
    const punctuation = FULL_WIDTH[char] ?? char;
    if (punctuation === '(' || punctuation === ')' || punctuation === ',') {
      tokens.push({
        kind: punctuation === '(' ? 'lparen' : punctuation === ')' ? 'rparen' : 'comma',
        value: punctuation,
        start,
        end: index + 1,
      });
      index += 1;
      continue;
    }
    if (OPEN_QUOTES[char]) {
      const closers = OPEN_QUOTES[char]!;
      let value = '';
      let closed = false;
      index += 1;
      while (index < text.length) {
        const next = text[index]!;
        if (next === '\\' && index + 1 < text.length) {
          const escaped = text[index + 1]!;
          value += STRING_ESCAPES[escaped] ?? escaped;
          index += 2;
          continue;
        }
        if (closers.includes(next)) {
          closed = true;
          index += 1;
          break;
        }
        value += next;
        index += 1;
      }
      if (!closed) fail('unterminated_string', 'Text is missing its closing quote', { start, end: text.length });
      tokens.push({ kind: 'string', value, start, end: index });
      continue;
    }
    if (char === '{') {
      let value = '';
      let closed = false;
      index += 1;
      while (index < text.length) {
        const next = text[index]!;
        if (next === '\\' && index + 1 < text.length) {
          value += text[index + 1]!;
          index += 2;
          continue;
        }
        if (next === '}') {
          closed = true;
          index += 1;
          break;
        }
        if (next === '{') break;
        value += next;
        index += 1;
      }
      if (!closed) fail('unterminated_field', 'A field name is missing its closing }', { start, end: index });
      if (!value.trim()) fail('empty_field', 'Put a field name between { and }', { start, end: index });
      tokens.push({ kind: 'field', value: value.trim(), start, end: index });
      continue;
    }
    NUMBER_PATTERN.lastIndex = index;
    const number = NUMBER_PATTERN.exec(text);
    if (number) {
      const raw = number[0];
      const end = index + raw.length;
      const value = Number(raw);
      if (!Number.isFinite(value) || IDENTIFIER_PART.test(text[end] ?? '')) {
        let stop = end;
        while (stop < text.length && IDENTIFIER_PART.test(text[stop]!)) stop += 1;
        fail('invalid_number', `"${text.slice(index, stop)}" is not a number`, { start, end: stop });
      }
      tokens.push({ kind: 'number', value, start, end });
      index = end;
      continue;
    }
    if (IDENTIFIER_START.test(char)) {
      let end = index + 1;
      while (end < text.length && IDENTIFIER_PART.test(text[end]!)) end += 1;
      tokens.push({ kind: 'identifier', value: text.slice(index, end), start, end });
      index = end;
      continue;
    }
    const two = text.slice(index, index + 2);
    if (two === '>=' || two === '<=' || two === '!=' || two === '<>' || two === '==') {
      tokens.push({ kind: 'operator', value: two, start, end: index + 2 });
      index += 2;
      continue;
    }
    if ('+-*/&=<>'.includes(char)) {
      tokens.push({ kind: 'operator', value: char, start, end: index + 1 });
      index += 1;
      continue;
    }
    fail('unexpected_character', `Unexpected "${char}"`, { start, end: index + 1 }, { token: char });
  }
  tokens.push({ kind: 'end', value: '', start: text.length, end: text.length });
  return tokens;
}

// ── Parser ────────────────────────────────────────────────

const COMPARISONS: Record<string, FormulaOperator> = {
  '=': 'eq',
  '==': 'eq',
  '!=': 'neq',
  '<>': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};
const ADDITIVE: Record<string, FormulaOperator> = { '+': 'add', '-': 'subtract' };
const MULTIPLICATIVE: Record<string, FormulaOperator> = { '*': 'multiply', '/': 'divide' };
const KEYWORDS: Record<string, boolean | null> = { true: true, false: false, null: null };
/** Parentheses followed before the formula counts as too complex (the tree limits apply after). */
const MAX_PAREN_DEPTH = 40;

const isFunctionName = (name: string): name is FormulaFunction =>
  (FORMULA_FUNCTIONS as readonly string[]).includes(name);

const describe = (token: Token) =>
  token.kind === 'string' ? `"${token.value}"` : token.kind === 'field' ? `{${token.value}}` : String(token.value);

class Parser {
  private position = 0;
  private parens = 0;
  readonly spans = new WeakMap<FormulaExpression, Span>();

  constructor(
    private readonly tokens: Token[],
    private readonly fields: readonly FormulaField[],
  ) {}

  parse(): FormulaExpression {
    const expression = this.comparison();
    const next = this.peek();
    if (next.kind !== 'end') this.unexpected(next);
    return expression;
  }

  private peek(): Token {
    return this.tokens[this.position]!;
  }

  private advance(): Token {
    const token = this.tokens[this.position]!;
    if (token.kind !== 'end') this.position += 1;
    return token;
  }

  private unexpected(token: Token): never {
    if (token.kind === 'end') fail('unexpected_end', 'The formula ends too early', token);
    if (token.kind === 'rparen' && this.parens === 0) {
      fail('unexpected_token', 'There is a ) without a matching (', token, { token: ')' });
    }
    fail('unexpected_token', `Unexpected ${describe(token)}`, token, { token: describe(token) });
  }

  private node<T extends FormulaExpression>(expression: T, start: number, end: number): T {
    this.spans.set(expression, { start, end });
    return expression;
  }

  private spanOf(expression: FormulaExpression): Span {
    return this.spans.get(expression) ?? { start: 0, end: 0 };
  }

  private level(operators: Record<string, FormulaOperator>, next: () => FormulaExpression): FormulaExpression {
    let left = next();
    for (;;) {
      const token = this.peek();
      const op = token.kind === 'operator' ? operators[token.value as string] : undefined;
      if (!op) return left;
      this.advance();
      const right = next();
      left = this.node({ type: 'binary', op, left, right }, this.spanOf(left).start, this.spanOf(right).end);
    }
  }

  private comparison(): FormulaExpression {
    return this.level(COMPARISONS, () => this.concat());
  }

  private concat(): FormulaExpression {
    return this.level({ '&': 'concat' }, () => this.additive());
  }

  private additive(): FormulaExpression {
    return this.level(ADDITIVE, () => this.multiplicative());
  }

  private multiplicative(): FormulaExpression {
    return this.level(MULTIPLICATIVE, () => this.unary());
  }

  private unary(): FormulaExpression {
    const token = this.peek();
    if (token.kind === 'operator' && (token.value === '-' || token.value === '+')) {
      this.advance();
      const next = this.peek();
      if (token.value === '-' && next.kind === 'number') {
        this.advance();
        return this.node(
          { type: 'literal', value: next.value === 0 ? 0 : -(next.value as number) },
          token.start,
          next.end,
        );
      }
      const operand = this.unary();
      if (token.value === '+') return operand;
      const zero = this.node({ type: 'literal', value: 0 } as const, token.start, token.start);
      return this.node(
        { type: 'binary', op: 'subtract', left: zero, right: operand },
        token.start,
        this.spanOf(operand).end,
      );
    }
    return this.primary();
  }

  private primary(): FormulaExpression {
    const token = this.advance();
    switch (token.kind) {
      case 'number':
        return this.node({ type: 'literal', value: token.value as number }, token.start, token.end);
      case 'string':
        return this.node({ type: 'literal', value: token.value as string }, token.start, token.end);
      case 'field':
        return this.node({ type: 'field', field: this.resolveField(token) }, token.start, token.end);
      case 'lparen': {
        this.parens += 1;
        if (this.parens > MAX_PAREN_DEPTH) fail('too_complex', 'The formula is nested too deeply', token);
        const inner = this.comparison();
        const close = this.peek();
        if (close.kind !== 'rparen') {
          if (close.kind === 'end') fail('missing_closing_paren', 'A ( is missing its closing )', token);
          this.unexpected(close);
        }
        this.advance();
        this.parens -= 1;
        return inner;
      }
      case 'identifier':
        return this.identifier(token);
      default:
        return this.unexpected(token);
    }
  }

  private identifier(token: Token): FormulaExpression {
    const raw = token.value as string;
    const lower = raw.toLowerCase();
    const next = this.peek();
    if (next.kind !== 'lparen') {
      if (lower in KEYWORDS)
        return this.node({ type: 'literal', value: KEYWORDS[lower] ?? null }, token.start, token.end);
      if (isFunctionName(lower))
        fail('unexpected_token', `${raw.toUpperCase()} needs ( ) after it`, token, { token: raw });
      fail('bare_word', `"${raw}" is not a function: put field names in braces, {${raw}}`, token, { word: raw });
    }
    if (!isFunctionName(lower)) fail('unknown_function', `Unknown function ${raw}`, token, { name: raw });
    this.advance();
    this.parens += 1;
    if (this.parens > MAX_PAREN_DEPTH) fail('too_complex', 'The formula is nested too deeply', next);
    const args: FormulaExpression[] = [];
    if (this.peek().kind !== 'rparen') {
      for (;;) {
        args.push(this.comparison());
        const separator = this.peek();
        if (separator.kind === 'comma') {
          this.advance();
          continue;
        }
        if (separator.kind === 'rparen') break;
        if (separator.kind === 'end')
          fail('missing_closing_paren', `${raw.toUpperCase()}( is missing its closing )`, next);
        this.unexpected(separator);
      }
    }
    const close = this.advance();
    this.parens -= 1;
    return this.node({ type: 'function', name: lower, args }, token.start, close.end);
  }

  private resolveField(token: Token): string {
    const name = token.value as string;
    const exact = this.fields.find((field) => field.name === name);
    if (exact) return exact.id;
    const folded = name.toLowerCase();
    const loose = this.fields.filter((field) => field.name.toLowerCase() === folded);
    if (loose.length === 1) return loose[0]!.id;
    const byId = /^#(.+)$/.exec(name);
    if (byId && this.fields.some((field) => field.id === byId[1])) return byId[1]!;
    return fail('unknown_field', `Unknown field {${name}}`, token, { name });
  }
}

/**
 * Text → expression, then the checks the server runs (checkFormula): fields resolve by name
 * (exactly, then ignoring case when only one matches, then `{#id}`), and arity, argument kinds,
 * units and the size limits hold. `fields` are the fields of the table the formula may read
 * (the server leaves out the formula itself and the fields that read it).
 */
export function parseFormula(text: string, fields: readonly FormulaField[]): FormulaParse {
  if (!text.trim())
    return { ok: false, error: { code: 'empty', message: 'Enter a formula', start: 0, end: text.length } };
  if (text.length > FORMULA_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'too_long',
        message: `A formula is at most ${FORMULA_MAX_LENGTH} characters`,
        start: FORMULA_MAX_LENGTH,
        end: text.length,
        params: { max: FORMULA_MAX_LENGTH },
      },
    };
  }
  try {
    const parser = new Parser(tokenize(text), fields);
    const expression = parser.parse();
    const checked = check(expression, fields, parser.spans);
    return checked.ok ? { ok: true, expression, type: checked.type } : checked;
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: error.detail };
    throw error;
  }
}

// ── Checker ───────────────────────────────────────────────

const ARITHMETIC: ReadonlySet<FormulaOperator> = new Set(['add', 'subtract', 'multiply', 'divide']);
const NUMERIC_TEXT = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const SYMBOLS: Record<FormulaOperator, string> = {
  add: '+',
  subtract: '-',
  multiply: '*',
  divide: '/',
  concat: '&',
  eq: '=',
  neq: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

function unify(types: FormulaValueType[]): FormulaValueType {
  const present = [...new Set(types.filter((type) => type !== 'null'))];
  if (!present.length) return 'null';
  return present.length === 1 ? present[0]! : 'unknown';
}

function check(
  root: FormulaExpression,
  fields: readonly FormulaField[],
  spans?: WeakMap<FormulaExpression, Span>,
): FormulaCheck {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const spanOf = (expression: FormulaExpression): Span => spans?.get(expression) ?? { start: 0, end: 0 };
  let nodes = 0;

  const requireNumber = (
    expression: FormulaExpression,
    type: FormulaValueType,
    context: { op?: FormulaOperator; name?: string; index?: number },
  ) => {
    if (type === 'number' || type === 'boolean' || type === 'null' || type === 'unknown') return;
    if (type === 'text' && expression.type === 'literal' && NUMERIC_TEXT.test(String(expression.value))) return;
    const name = context.name ? context.name.toUpperCase() : context.op ? SYMBOLS[context.op] : '';
    if (type === 'text' && context.op) {
      fail(
        'text_in_arithmetic',
        `Text cannot be used with ${SYMBOLS[context.op]}: join text with &`,
        spanOf(expression),
        {
          operator: SYMBOLS[context.op],
        },
      );
    }
    if ((type === 'date' || type === 'datetime') && context.op) {
      fail(
        'date_in_arithmetic',
        `Dates cannot be used with ${SYMBOLS[context.op]}: use DATEADD or DATEDIFF`,
        spanOf(expression),
        { operator: SYMBOLS[context.op] },
      );
    }
    fail('type_mismatch', `${name} argument ${(context.index ?? 0) + 1} must be a number`, spanOf(expression), {
      name,
      index: (context.index ?? 0) + 1,
      expected: 'number',
      actual: type,
    });
  };

  const visit = (expression: FormulaExpression, depth: number): FormulaValueType => {
    nodes += 1;
    if (depth > FORMULA_MAX_DEPTH || nodes > FORMULA_MAX_NODES) {
      fail('too_complex', 'The formula is too complex', spanOf(expression), {
        maxDepth: FORMULA_MAX_DEPTH,
        maxNodes: FORMULA_MAX_NODES,
      });
    }
    if (expression.type === 'literal') {
      if (expression.value === null) return 'null';
      if (typeof expression.value === 'number') return 'number';
      if (typeof expression.value === 'boolean') return 'boolean';
      return 'text';
    }
    if (expression.type === 'field') {
      const field = byId.get(expression.field);
      if (!field)
        fail('unknown_field', `Field ${expression.field} cannot be used here`, spanOf(expression), {
          name: `#${expression.field}`,
        });
      return field.type;
    }
    if (expression.type === 'binary') {
      const left = visit(expression.left, depth + 1);
      const right = visit(expression.right, depth + 1);
      if (ARITHMETIC.has(expression.op)) {
        requireNumber(expression.left, left, { op: expression.op });
        requireNumber(expression.right, right, { op: expression.op });
        return 'number';
      }
      if (expression.op === 'concat') return 'text';
      return 'boolean';
    }
    const spec = FORMULA_CATALOG[expression.name];
    const name = expression.name.toUpperCase();
    if (!spec) fail('unknown_function', `Unknown function ${name}`, spanOf(expression), { name });
    const count = expression.args.length;
    if (count < spec.minArgs) {
      fail('too_few_arguments', `${name} needs at least ${spec.minArgs} argument(s)`, spanOf(expression), {
        name,
        min: spec.minArgs,
      });
    }
    const max = Math.min(spec.maxArgs ?? FORMULA_MAX_ARGS, FORMULA_MAX_ARGS);
    if (count > max) {
      fail('too_many_arguments', `${name} takes at most ${max} argument(s)`, spanOf(expression.args[max]!), {
        name,
        max,
      });
    }
    const types = expression.args.map((argument) => visit(argument, depth + 1));
    expression.args.forEach((argument, index) => {
      const kind = spec.params[Math.min(index, spec.params.length - 1)]!;
      const type = types[index]!;
      if (kind === 'number') requireNumber(argument, type, { name: expression.name, index });
      if (kind === 'date') {
        const textDate = type === 'text' && (argument.type !== 'literal' || ISO_DATE_TEXT.test(String(argument.value)));
        if (!(type === 'date' || type === 'datetime' || type === 'null' || type === 'unknown' || textDate)) {
          fail('type_mismatch', `${name} argument ${index + 1} must be a date`, spanOf(argument), {
            name,
            index: index + 1,
            expected: 'date',
            actual: type,
          });
        }
      }
      if (kind === 'unit' && (argument.type !== 'literal' || formulaDateUnit(argument.value) === null)) {
        fail(
          'invalid_unit',
          `${name} takes a unit of ${FORMULA_DATE_UNITS.map((unit) => `"${unit}"`).join(', ')}`,
          spanOf(argument),
          { name, units: FORMULA_DATE_UNITS.join(', ') },
        );
      }
    });
    if (expression.name === 'if') return unify(types.slice(1));
    if (expression.name === 'coalesce') return unify(types);
    if (expression.name === 'dateadd') return types[0] === 'datetime' ? 'datetime' : 'date';
    return spec.result as FormulaValueType;
  };

  try {
    return { ok: true, type: visit(root, 0) };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: error.detail };
    throw error;
  }
}

/** The checks on a stored expression against the fields it may read; its result type. */
export function checkFormula(expression: FormulaExpression, fields: readonly FormulaField[]): FormulaCheck {
  return check(expression, fields);
}

/** The fields an expression reads. */
export function formulaFields(expression: FormulaExpression): string[] {
  const found = new Set<string>();
  const walk = (node: FormulaExpression) => {
    if (node.type === 'field') found.add(node.field);
    else if (node.type === 'binary') {
      walk(node.left);
      walk(node.right);
    } else if (node.type === 'function') node.args.forEach(walk);
  };
  walk(expression);
  return [...found];
}

// ── Printing ──────────────────────────────────────────────

const PRECEDENCE: Record<FormulaOperator, number> = {
  eq: 1,
  neq: 1,
  gt: 1,
  gte: 1,
  lt: 1,
  lte: 1,
  concat: 2,
  add: 3,
  subtract: 3,
  multiply: 4,
  divide: 4,
};
const UNARY = 5;
const ATOMIC = 6;

const isUnaryMinus = (node: FormulaExpression) =>
  node.type === 'binary' &&
  node.op === 'subtract' &&
  node.left.type === 'literal' &&
  node.left.value === 0 &&
  !(node.right.type === 'literal' && typeof node.right.value === 'number');

const precedenceOf = (node: FormulaExpression) =>
  node.type !== 'binary' ? ATOMIC : isUnaryMinus(node) ? UNARY : PRECEDENCE[node.op];

const quote = (value: string) =>
  `"${value.replace(/[\\"\n\t\r]/g, (char) =>
    char === '\n' ? '\\n' : char === '\t' ? '\\t' : char === '\r' ? '\\r' : `\\${char}`,
  )}"`;

/** `{Name}` with `\`, `{` and `}` escaped. */
export const formulaFieldRef = (name: string) => `{${name.replace(/[\\{}]/g, '\\$&')}}`;

/** Expression → text, fields by today's names; a field not in `fields` prints as `{#id}`. */
export function formatFormula(
  expression: FormulaExpression,
  fields: ReadonlyArray<Pick<FormulaField, 'id' | 'name'>>,
): string {
  const names = new Map(fields.map((field) => [field.id, field.name]));
  const wrap = (child: FormulaExpression, parens: boolean) => (parens ? `(${print(child)})` : print(child));
  const print = (node: FormulaExpression): string => {
    if (node.type === 'literal') {
      if (node.value === null) return 'NULL';
      if (typeof node.value === 'boolean') return node.value ? 'TRUE' : 'FALSE';
      if (typeof node.value === 'number') return String(node.value);
      return quote(node.value);
    }
    if (node.type === 'field') {
      const name = names.get(node.field);
      return name === undefined ? `{#${node.field}}` : formulaFieldRef(name);
    }
    if (node.type === 'function') return `${node.name.toUpperCase()}(${node.args.map(print).join(', ')})`;
    if (isUnaryMinus(node)) return `-${wrap(node.right, precedenceOf(node.right) < UNARY)}`;
    const own = PRECEDENCE[node.op];
    return `${wrap(node.left, precedenceOf(node.left) < own)} ${SYMBOLS[node.op]} ${wrap(node.right, precedenceOf(node.right) <= own)}`;
  };
  return print(expression);
}

// ── Editor support ────────────────────────────────────────

/** What to complete at `caret`: a field name inside an open `{…` (replace [start, end)), a function name, or nothing. */
export type FormulaCompletion =
  | { kind: 'field'; prefix: string; start: number; end: number }
  | { kind: 'function'; prefix: string; start: number; end: number };

export function formulaCompletionAt(text: string, caret: number): FormulaCompletion | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let index = 0;
  let fieldStart = -1;
  let fieldText = '';
  let quoteClosers: string[] | null = null;
  while (index < at) {
    const char = text[index]!;
    if (quoteClosers) {
      if (char === '\\') index += 1;
      else if (quoteClosers.includes(char)) quoteClosers = null;
      index += 1;
      continue;
    }
    if (fieldStart >= 0) {
      if (char === '\\' && index + 1 < at) {
        fieldText += text[index + 1]!;
        index += 2;
        continue;
      }
      if (char === '}') fieldStart = -1;
      else if (char === '{') {
        fieldStart = index;
        fieldText = '';
      } else fieldText += char;
      index += 1;
      continue;
    }
    if (OPEN_QUOTES[char]) quoteClosers = OPEN_QUOTES[char]!;
    else if (char === '{') {
      fieldStart = index;
      fieldText = '';
    }
    index += 1;
  }
  if (quoteClosers) return null;
  if (fieldStart >= 0) {
    let end = at;
    for (let scan = at; scan < text.length; scan += 1) {
      const char = text[scan]!;
      if (char === '\\') scan += 1;
      else if (char === '}') {
        end = scan + 1;
        break;
      } else if (char === '{' || char === '\n') break;
    }
    return { kind: 'field', prefix: fieldText.trimStart(), start: fieldStart, end };
  }
  let start = at;
  while (start > 0 && /[A-Za-z_]/.test(text[start - 1]!)) start -= 1;
  if (start === at) return null;
  if (start > 0 && /[\p{L}\p{N}_.]/u.test(text[start - 1]!)) return null;
  let end = at;
  while (end < text.length && /[A-Za-z_]/.test(text[end]!)) end += 1;
  return { kind: 'function', prefix: text.slice(start, at), start, end };
}

// ── Evaluation ────────────────────────────────────────────

/** A value inside a formula: what fields read as (selects as labels, lists as lists), or a failure. */
export type FormulaValue = string | number | boolean | null | FormulaValue[] | { error: ComputedError };

const DAY_MS = 86_400_000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

const failure = (value: unknown): value is { error: ComputedError } =>
  !!value && typeof value === 'object' && !Array.isArray(value) && 'error' in value;
const blank = (value: unknown) => value === null || value === undefined || value === '';
const truthy = (value: unknown) => (Array.isArray(value) ? value.length > 0 : Boolean(value));

function toText(value: FormulaValue): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.map(toText).filter(Boolean).join(', ');
  if (typeof value === 'object') return '';
  return String(value);
}

/** A number, an empty value as 0, text that is a number; null for text that is not one or a list. */
function toNumber(value: FormulaValue): number | null {
  if (value === null || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && NUMERIC_TEXT.test(value)) return Number(value);
  return null;
}

const finite = (value: number): FormulaValue => (Number.isFinite(value) ? (value === 0 ? 0 : value) : null);

interface DateValue {
  ms: number;
  dateOnly: boolean;
}

function toDate(value: FormulaValue): DateValue | null {
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

function dateText(ms: number, dateOnly: boolean): FormulaValue {
  const date = new Date(ms);
  if (Number.isNaN(date.valueOf())) return null;
  return dateOnly ? date.toISOString().slice(0, 10) : date.toISOString();
}

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

function addMonths(ms: number, count: number): number {
  const date = new Date(ms);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const time = ms - Date.UTC(year, month, day);
  const target = month + count;
  const targetYear = year + Math.floor(target / 12);
  const targetMonth = ((target % 12) + 12) % 12;
  const last = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return Date.UTC(targetYear, targetMonth, Math.min(day, last)) + time;
}

/** Ordering for `> >= < <=`: dates by instant, numbers numerically, text alphabetically; null when not comparable. */
function compare(left: FormulaValue, right: FormulaValue): number | null {
  const leftDate = toDate(left);
  const rightDate = toDate(right);
  if (leftDate && rightDate) return leftDate.ms - rightDate.ms;
  if (typeof left === 'number' || typeof right === 'number') {
    const a = toNumber(left);
    const b = toNumber(right);
    return a === null || b === null ? null : a - b;
  }
  if (typeof left === 'string' && typeof right === 'string') return left < right ? -1 : left > right ? 1 : 0;
  return null;
}

const same = (left: FormulaValue, right: FormulaValue): boolean => {
  if (Array.isArray(left) || Array.isArray(right)) return JSON.stringify(left) === JSON.stringify(right);
  if (typeof left === 'number' && typeof right === 'string' && NUMERIC_TEXT.test(right)) return left === Number(right);
  if (typeof right === 'number' && typeof left === 'string' && NUMERIC_TEXT.test(left)) return right === Number(left);
  return (left ?? null) === (right ?? null) || (blank(left) && blank(right));
};

const cut = (text: string): string =>
  text.length > FORMULA_TEXT_RESULT_MAX ? text.slice(0, FORMULA_TEXT_RESULT_MAX) : text;
const count = (value: FormulaValue) => {
  const number = toNumber(value);
  return number !== null && number > 0 ? Math.trunc(number) : 0;
};

function evaluateNode(node: FormulaExpression, read: (fieldId: string) => FormulaValue): FormulaValue {
  if (node.type === 'literal') return node.value;
  if (node.type === 'field') return read(node.field);
  if (node.type === 'binary') {
    const left = evaluateNode(node.left, read);
    if (failure(left)) return left;
    const right = evaluateNode(node.right, read);
    if (failure(right)) return right;
    switch (node.op) {
      case 'concat':
        return cut(`${toText(left)}${toText(right)}`);
      case 'eq':
        return same(left, right);
      case 'neq':
        return !same(left, right);
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const order = compare(left, right);
        if (order === null) return false;
        return node.op === 'gt'
          ? order > 0
          : node.op === 'gte'
            ? order >= 0
            : node.op === 'lt'
              ? order < 0
              : order <= 0;
      }
      default: {
        const a = toNumber(left);
        const b = toNumber(right);
        if (a === null || b === null) return { error: 'not_number' };
        if (node.op === 'add') return finite(a + b);
        if (node.op === 'subtract') return finite(a - b);
        if (node.op === 'multiply') return finite(a * b);
        return b === 0 ? { error: 'div_zero' } : finite(a / b);
      }
    }
  }
  // Branches and short circuits look only at what they need.
  if (node.name === 'if') {
    const condition = evaluateNode(node.args[0]!, read);
    if (failure(condition)) return condition;
    const branch = truthy(condition) ? node.args[1] : node.args[2];
    return branch ? evaluateNode(branch, read) : null;
  }
  if (node.name === 'coalesce') {
    for (const argument of node.args) {
      const value = evaluateNode(argument, read);
      if (failure(value) || !blank(value)) return value;
    }
    return null;
  }
  if (node.name === 'and' || node.name === 'or') {
    for (const argument of node.args) {
      const value = evaluateNode(argument, read);
      if (failure(value)) return value;
      if (node.name === 'and' && !truthy(value)) return false;
      if (node.name === 'or' && truthy(value)) return true;
    }
    return node.name === 'and';
  }
  const args: FormulaValue[] = [];
  for (const argument of node.args) {
    const value = evaluateNode(argument, read);
    if (failure(value)) return value;
    args.push(value);
  }
  const [first = null, second = null, third] = args;
  const number = (value: FormulaValue): number | { error: ComputedError } => {
    const n = toNumber(value);
    return n === null ? { error: 'not_number' } : n;
  };
  switch (node.name) {
    case 'concat':
      return cut(args.map(toText).join(''));
    case 'upper':
      return toText(first).toUpperCase();
    case 'lower':
      return toText(first).toLowerCase();
    case 'trim':
      return toText(first).trim();
    case 'len':
      return Array.from(toText(first)).length;
    case 'left':
      return Array.from(toText(first)).slice(0, count(second)).join('');
    case 'right': {
      const take = count(second);
      return take === 0 ? '' : Array.from(toText(first)).slice(-take).join('');
    }
    case 'contains':
      return toText(first).toLowerCase().includes(toText(second).toLowerCase());
    case 'not':
      return !truthy(first);
    case 'round': {
      const value = number(first);
      if (typeof value !== 'number') return value;
      const digits = Math.min(Math.max(Math.trunc(toNumber(second) ?? 0), 0), 10);
      return finite(Number(value.toFixed(digits)));
    }
    case 'abs':
    case 'floor':
    case 'ceil': {
      const value = number(first);
      if (typeof value !== 'number') return value;
      return finite(
        node.name === 'abs' ? Math.abs(value) : node.name === 'floor' ? Math.floor(value) : Math.ceil(value),
      );
    }
    case 'mod': {
      const a = number(first);
      const b = number(second);
      if (typeof a !== 'number') return a;
      if (typeof b !== 'number') return b;
      return b === 0 ? { error: 'div_zero' } : finite(a - b * Math.floor(a / b));
    }
    case 'min':
    case 'max': {
      const numbers: number[] = [];
      for (const value of args.flat()) {
        if (blank(value as FormulaValue)) continue;
        const n = toNumber(value as FormulaValue);
        if (n === null) return { error: 'not_number' };
        numbers.push(n);
      }
      if (!numbers.length) return null;
      return node.name === 'min' ? Math.min(...numbers) : Math.max(...numbers);
    }
    case 'year':
    case 'month':
    case 'day': {
      const date = toDate(first);
      if (!date) return null;
      const at = new Date(date.ms);
      return node.name === 'year'
        ? at.getUTCFullYear()
        : node.name === 'month'
          ? at.getUTCMonth() + 1
          : at.getUTCDate();
    }
    case 'datediff': {
      const end = toDate(first);
      const start = toDate(second);
      const unit = third === undefined ? 'days' : formulaDateUnit(third);
      if (!end || !start || !unit) return null;
      const elapsed = end.ms - start.ms;
      return finite(
        unit === 'days'
          ? Math.trunc(elapsed / DAY_MS)
          : unit === 'weeks'
            ? Math.trunc(elapsed / (7 * DAY_MS))
            : unit === 'months'
              ? monthsBetween(end.ms, start.ms)
              : Math.trunc(monthsBetween(end.ms, start.ms) / 12),
      );
    }
    case 'dateadd': {
      const date = toDate(first);
      const unit = third === undefined ? 'days' : formulaDateUnit(third);
      const amount = toNumber(second);
      if (!date || !unit || amount === null) return null;
      const steps = Math.trunc(amount);
      const ms =
        unit === 'days'
          ? date.ms + steps * DAY_MS
          : unit === 'weeks'
            ? date.ms + steps * 7 * DAY_MS
            : addMonths(date.ms, unit === 'months' ? steps : steps * 12);
      return dateText(ms, date.dateOnly);
    }
    default:
      return null;
  }
}

/**
 * Works out a stored formula for one record. `read` gives a field's value as formulas see it
 * (fieldValueForFormula); a field that is gone reads as `{ error: 'missing_field' }`. Never
 * throws: what cannot be worked out is a failure value.
 */
export function evaluateFormula(expression: FormulaExpression, read: (fieldId: string) => FormulaValue): FormulaValue {
  try {
    return evaluateNode(expression, read) ?? null;
  } catch {
    return { error: 'too_large' };
  }
}

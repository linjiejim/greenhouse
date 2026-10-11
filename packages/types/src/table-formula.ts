/**
 * Tables formula language — the text form people type, the function catalog,
 * and the static checks shared by the editor and the server.
 *
 * Formulas are stored as a JSON AST (`TableFormulaExpression` in `./tables`);
 * this module owns the text syntax that maps onto it:
 *
 *   {Field name}   "text"   12.5   TRUE / FALSE / NULL
 *   + - * /   &  (join text)   = != <> > >= < <=
 *   NAME(arg, …)   — case-insensitive function names from the catalog below
 *
 * Precedence, loosest first: comparison < & < + - < * / < unary minus.
 * Every binary operator is left-associative. `AND` / `OR` / `NOT` are written
 * as functions; the AST's legacy binary `and` / `or` print as `AND(a, b)`.
 * Inside braces `\}` and `\\` escape; inside strings `\"`, `\\`, `\n`, `\t`.
 * Full-width `（ ） ，` and curly quotes are read like their ASCII forms so a
 * Chinese input method does not trip the parser. `{#12}` refers to a field by
 * id (that is how a reference to a field no longer in the table prints).
 *
 * No TODAY()/NOW(): formula results are computed on write and stored, so a
 * value depending on "today" would be wrong tomorrow (use a date-reached
 * automation instead).
 */

import { isComputedFieldType, TABLE_FORMULA_FUNCTIONS } from './tables.js';
import type {
  TableFieldType,
  TableFormulaBinaryOperator,
  TableFormulaExpression,
  TableFormulaFunction,
  TableFormulaResultType,
} from './tables.js';

// ─── Limits (the server's AST validator enforces the same numbers) ──────────

/** Deepest AST nesting accepted (root = 0). */
export const TABLE_FORMULA_MAX_DEPTH = 12;
/** Most AST nodes in one formula. */
export const TABLE_FORMULA_MAX_NODES = 100;
/** Most arguments in one function call, variadic functions included. */
export const TABLE_FORMULA_MAX_ARGS = 10;
/** Longest formula text the parser reads. */
export const TABLE_FORMULA_MAX_LENGTH = 4_000;

// ─── Catalog ──────────────────────────────────────────────

/**
 * What an argument must be. `any` takes everything (text functions coerce);
 * `number` refuses text, dates and lists; `date` takes a date, a datetime or
 * text that reads as one; `unit` must be a literal unit name.
 */
export type TableFormulaParamKind = 'any' | 'number' | 'date' | 'unit';

export interface TableFormulaFunctionSpec {
  name: TableFormulaFunction;
  minArgs: number;
  /** null = variadic (still capped at `TABLE_FORMULA_MAX_ARGS`). */
  maxArgs: number | null;
  /** Kinds by position; a variadic function repeats the last one. */
  params: readonly TableFormulaParamKind[];
  /** 'same' = the common type of the value arguments (IF: its two branches; COALESCE: every argument). */
  result: TableFormulaResultType | 'same';
}

/** Arity, argument kinds and result typing for every function in `TABLE_FORMULA_FUNCTIONS`. */
export const TABLE_FORMULA_FUNCTION_CATALOG: Readonly<Record<TableFormulaFunction, TableFormulaFunctionSpec>> =
  Object.freeze({
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

/** Units accepted by DATEDIFF / DATEADD (third argument, default "days"). */
export const TABLE_FORMULA_DATE_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type TableFormulaDateUnit = (typeof TABLE_FORMULA_DATE_UNITS)[number];

/** `"day"`, `"Days"`, `"weeks"` … → the canonical unit; null when it is not one. */
export function normalizeTableFormulaDateUnit(value: unknown): TableFormulaDateUnit | null {
  if (typeof value !== 'string') return null;
  const unit = value.trim().toLowerCase();
  const plural = unit.endsWith('s') ? unit : `${unit}s`;
  return (TABLE_FORMULA_DATE_UNITS as readonly string[]).includes(plural) ? (plural as TableFormulaDateUnit) : null;
}

// ─── Types ────────────────────────────────────────────────

/**
 * What an expression yields, as far as the checker can tell: a result type,
 * `list` (multi-value fields), `null` (the NULL literal) or `unknown` (mixed
 * branches).
 */
export type TableFormulaValueType = TableFormulaResultType | 'list' | 'null' | 'unknown';

/** A field the formula may name. Pass the table's active fields. */
export interface TableFormulaField {
  id: number;
  name: string;
  type: TableFieldType;
}

/** The value type a stored field reads as inside a formula (select fields read as their labels). */
export function tableFormulaFieldValueType(type: TableFieldType): TableFormulaValueType {
  switch (type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
      return 'date';
    case 'datetime':
      return 'datetime';
    case 'multi_select':
    case 'multi_user':
    case 'attachment':
    case 'relation':
    case 'lookup':
      return 'list';
    default:
      return 'text';
  }
}

/** The result type a builder should store for a formula of `type`; undefined when it cannot be told. */
export function suggestedTableFormulaResultType(type: TableFormulaValueType): TableFormulaResultType | undefined {
  return type === 'text' || type === 'number' || type === 'boolean' || type === 'date' || type === 'datetime'
    ? type
    : undefined;
}

// ─── Errors ───────────────────────────────────────────────

export type TableFormulaErrorCode =
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
  | 'computed_field'
  | 'unknown_function'
  | 'bare_word'
  | 'too_few_arguments'
  | 'too_many_arguments'
  | 'type_mismatch'
  | 'text_in_arithmetic'
  | 'date_in_arithmetic'
  | 'invalid_unit';

/**
 * One problem, located in the text: `[start, end)` character offsets (both 0
 * when the AST did not come from text). `message` is English for logs and
 * agents; screens translate `code` with `params`.
 */
export interface TableFormulaError {
  code: TableFormulaErrorCode;
  message: string;
  start: number;
  end: number;
  params?: Record<string, string | number>;
}

export type TableFormulaCheckResult =
  | { ok: true; type: TableFormulaValueType }
  | { ok: false; error: TableFormulaError };

export type TableFormulaParseResult =
  | { ok: true; expression: TableFormulaExpression; type: TableFormulaValueType }
  | { ok: false; error: TableFormulaError };

interface Span {
  start: number;
  end: number;
}

class FormulaSyntaxError extends Error {
  constructor(readonly detail: TableFormulaError) {
    super(detail.message);
  }
}

function fail(
  code: TableFormulaErrorCode,
  message: string,
  span: Span,
  params?: Record<string, string | number>,
): never {
  throw new FormulaSyntaxError({ code, message, start: span.start, end: span.end, ...(params ? { params } : {}) });
}

// ─── Tokens ───────────────────────────────────────────────

export type TableFormulaTokenKind =
  | 'number'
  | 'string'
  | 'field'
  | 'identifier'
  | 'operator'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'end';

export interface TableFormulaToken {
  kind: TableFormulaTokenKind;
  /** Decoded value: the number, the unescaped string / field name, the operator or the identifier. */
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

/** Split formula text into tokens. Throws the first lexical error as a `TableFormulaError`. */
function tokenize(text: string): TableFormulaToken[] {
  const tokens: TableFormulaToken[] = [];
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
      index += 1;
      let closed = false;
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
      index += 1;
      let closed = false;
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
      if (!closed) fail('unterminated_field', 'Field name is missing its closing }', { start, end: index });
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

/** Tokens of `text`, or the first lexical error (for highlighting). */
export function tokenizeTableFormula(
  text: string,
): { ok: true; tokens: TableFormulaToken[] } | { ok: false; error: TableFormulaError } {
  try {
    return { ok: true, tokens: tokenize(text) };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: error.detail };
    throw error;
  }
}

// ─── Parser ───────────────────────────────────────────────

const COMPARISON_OPERATORS: Record<string, TableFormulaBinaryOperator> = {
  '=': 'eq',
  '==': 'eq',
  '!=': 'neq',
  '<>': 'neq',
  '>': 'gt',
  '>=': 'gte',
  '<': 'lt',
  '<=': 'lte',
};
const ADDITIVE_OPERATORS: Record<string, TableFormulaBinaryOperator> = { '+': 'add', '-': 'subtract' };
const MULTIPLICATIVE_OPERATORS: Record<string, TableFormulaBinaryOperator> = { '*': 'multiply', '/': 'divide' };
const KEYWORDS: Record<string, boolean | null> = { true: true, false: false, null: null };
/** Parenthesis nesting the parser follows before calling it too complex (the AST limits apply after). */
const MAX_PAREN_DEPTH = 40;

function isFunctionName(name: string): name is TableFormulaFunction {
  return (TABLE_FORMULA_FUNCTIONS as readonly string[]).includes(name);
}

function describeToken(token: TableFormulaToken): string {
  return token.kind === 'string'
    ? `"${token.value}"`
    : token.kind === 'field'
      ? `{${token.value}}`
      : String(token.value);
}

class Parser {
  private position = 0;
  private parens = 0;
  readonly spans = new WeakMap<TableFormulaExpression, Span>();

  constructor(
    private readonly tokens: TableFormulaToken[],
    private readonly fields: readonly TableFormulaField[],
  ) {}

  parse(): TableFormulaExpression {
    const expression = this.comparison();
    const next = this.peek();
    if (next.kind !== 'end') this.unexpected(next);
    return expression;
  }

  private peek(): TableFormulaToken {
    return this.tokens[this.position]!;
  }

  private advance(): TableFormulaToken {
    const token = this.tokens[this.position]!;
    if (token.kind !== 'end') this.position += 1;
    return token;
  }

  private unexpected(token: TableFormulaToken): never {
    if (token.kind === 'end') fail('unexpected_end', 'The formula ends too early', token);
    if (token.kind === 'rparen' && this.parens === 0) {
      fail('unexpected_token', 'There is a ) without a matching (', token, { token: ')' });
    }
    fail('unexpected_token', `Unexpected ${describeToken(token)}`, token, { token: describeToken(token) });
  }

  private node<T extends TableFormulaExpression>(expression: T, start: number, end: number): T {
    this.spans.set(expression, { start, end });
    return expression;
  }

  private spanOf(expression: TableFormulaExpression): Span {
    return this.spans.get(expression) ?? { start: 0, end: 0 };
  }

  private binaryLevel(
    operators: Record<string, TableFormulaBinaryOperator>,
    next: () => TableFormulaExpression,
  ): TableFormulaExpression {
    let left = next();
    for (;;) {
      const token = this.peek();
      const operator = token.kind === 'operator' ? operators[token.value as string] : undefined;
      if (!operator) return left;
      this.advance();
      const right = next();
      left = this.node({ type: 'binary', operator, left, right }, this.spanOf(left).start, this.spanOf(right).end);
    }
  }

  private comparison(): TableFormulaExpression {
    return this.binaryLevel(COMPARISON_OPERATORS, () => this.concat());
  }

  private concat(): TableFormulaExpression {
    return this.binaryLevel({ '&': 'concat' }, () => this.additive());
  }

  private additive(): TableFormulaExpression {
    return this.binaryLevel(ADDITIVE_OPERATORS, () => this.multiplicative());
  }

  private multiplicative(): TableFormulaExpression {
    return this.binaryLevel(MULTIPLICATIVE_OPERATORS, () => this.unary());
  }

  private unary(): TableFormulaExpression {
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
        { type: 'binary', operator: 'subtract', left: zero, right: operand },
        token.start,
        this.spanOf(operand).end,
      );
    }
    return this.primary();
  }

  private primary(): TableFormulaExpression {
    const token = this.advance();
    switch (token.kind) {
      case 'number':
        return this.node({ type: 'literal', value: token.value as number }, token.start, token.end);
      case 'string':
        return this.node({ type: 'literal', value: token.value as string }, token.start, token.end);
      case 'field':
        return this.node({ type: 'field', fieldId: this.resolveField(token) }, token.start, token.end);
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

  private identifier(token: TableFormulaToken): TableFormulaExpression {
    const raw = token.value as string;
    const lower = raw.toLowerCase();
    const next = this.peek();
    if (next.kind !== 'lparen') {
      if (lower in KEYWORDS) {
        return this.node({ type: 'literal', value: KEYWORDS[lower] ?? null }, token.start, token.end);
      }
      if (isFunctionName(lower)) {
        fail('unexpected_token', `${raw.toUpperCase()} needs ( ) after it`, token, { token: raw });
      }
      fail('bare_word', `"${raw}" is not a function — put field names in braces: {${raw}}`, token, { word: raw });
    }
    if (!isFunctionName(lower)) fail('unknown_function', `Unknown function ${raw}`, token, { name: raw });
    this.advance();
    this.parens += 1;
    if (this.parens > MAX_PAREN_DEPTH) fail('too_complex', 'The formula is nested too deeply', next);
    const args: TableFormulaExpression[] = [];
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

  private resolveField(token: TableFormulaToken): number {
    const name = token.value as string;
    const exact = this.fields.find((field) => field.name === name);
    if (exact) return exact.id;
    const folded = name.toLowerCase();
    const loose = this.fields.filter((field) => field.name.toLowerCase() === folded);
    if (loose.length === 1) return loose[0]!.id;
    const byId = /^#(\d+)$/.exec(name);
    if (byId) {
      const id = Number(byId[1]);
      if (this.fields.some((field) => field.id === id)) return id;
    }
    return fail('unknown_field', `Unknown field {${name}}`, token, { name });
  }
}

/**
 * Text → AST, then the same checks the server runs (`checkTableFormula`):
 * field references resolve by name against `fields` (exact, then
 * case-insensitive when unambiguous, then `{#id}`), computed fields are
 * refused, arity / argument kinds / units / size limits are enforced.
 */
export function parseTableFormula(text: string, fields: readonly TableFormulaField[]): TableFormulaParseResult {
  if (!text.trim()) {
    return { ok: false, error: { code: 'empty', message: 'Enter a formula', start: 0, end: text.length } };
  }
  if (text.length > TABLE_FORMULA_MAX_LENGTH) {
    return {
      ok: false,
      error: {
        code: 'too_long',
        message: `A formula is at most ${TABLE_FORMULA_MAX_LENGTH} characters`,
        start: TABLE_FORMULA_MAX_LENGTH,
        end: text.length,
        params: { max: TABLE_FORMULA_MAX_LENGTH },
      },
    };
  }
  try {
    const parser = new Parser(tokenize(text), fields);
    const expression = parser.parse();
    const checked = checkExpression(expression, fields, parser.spans);
    return checked.ok ? { ok: true, expression, type: checked.type } : checked;
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: error.detail };
    throw error;
  }
}

// ─── Checker ──────────────────────────────────────────────

const ARITHMETIC: ReadonlySet<TableFormulaBinaryOperator> = new Set(['add', 'subtract', 'multiply', 'divide']);
const COMPARISON: ReadonlySet<TableFormulaBinaryOperator> = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte']);
const NUMERIC_TEXT = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;
const ISO_DATE_TEXT = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

const OPERATOR_SYMBOLS: Record<TableFormulaBinaryOperator, string> = {
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
  and: 'AND',
  or: 'OR',
};

function unify(types: TableFormulaValueType[]): TableFormulaValueType {
  const present = [...new Set(types.filter((type) => type !== 'null'))];
  if (present.length === 0) return 'null';
  return present.length === 1 ? present[0]! : 'unknown';
}

function checkExpression(
  root: TableFormulaExpression,
  fields: readonly TableFormulaField[],
  spans?: WeakMap<TableFormulaExpression, Span>,
): TableFormulaCheckResult {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const spanOf = (expression: TableFormulaExpression): Span => spans?.get(expression) ?? { start: 0, end: 0 };
  let nodes = 0;

  /** Arithmetic / numeric parameter acceptance. */
  const requireNumber = (
    expression: TableFormulaExpression,
    type: TableFormulaValueType,
    context: { operator?: TableFormulaBinaryOperator; name?: string; index?: number },
  ): void => {
    if (type === 'number' || type === 'boolean' || type === 'null' || type === 'unknown') return;
    if (type === 'text' && expression.type === 'literal' && NUMERIC_TEXT.test(String(expression.value))) return;
    const where = context.name ? `${context.name.toUpperCase()} argument ${context.index! + 1}` : 'This value';
    if (type === 'text') {
      if (context.operator) {
        fail(
          'text_in_arithmetic',
          `Text can't be used with ${OPERATOR_SYMBOLS[context.operator]} — use & to join text`,
          spanOf(expression),
          { operator: OPERATOR_SYMBOLS[context.operator] },
        );
      }
      fail('type_mismatch', `${where} must be a number`, spanOf(expression), {
        name: context.name!.toUpperCase(),
        index: context.index! + 1,
        expected: 'number',
        actual: type,
      });
    }
    if ((type === 'date' || type === 'datetime') && context.operator) {
      fail(
        'date_in_arithmetic',
        `Dates can't be used with ${OPERATOR_SYMBOLS[context.operator]} — use DATEADD or DATEDIFF`,
        spanOf(expression),
        { operator: OPERATOR_SYMBOLS[context.operator] },
      );
    }
    fail('type_mismatch', `${where} must be a number`, spanOf(expression), {
      name: context.name ? context.name.toUpperCase() : OPERATOR_SYMBOLS[context.operator!],
      index: (context.index ?? 0) + 1,
      expected: 'number',
      actual: type,
    });
  };

  const visit = (expression: TableFormulaExpression, depth: number): TableFormulaValueType => {
    nodes += 1;
    if (depth > TABLE_FORMULA_MAX_DEPTH || nodes > TABLE_FORMULA_MAX_NODES) {
      fail('too_complex', 'The formula is too complex', spanOf(expression), {
        maxDepth: TABLE_FORMULA_MAX_DEPTH,
        maxNodes: TABLE_FORMULA_MAX_NODES,
      });
    }
    if (expression.type === 'literal') {
      if (expression.value === null) return 'null';
      if (typeof expression.value === 'number') return 'number';
      if (typeof expression.value === 'boolean') return 'boolean';
      return 'text';
    }
    if (expression.type === 'field') {
      const field = byId.get(expression.fieldId);
      if (!field) {
        fail('unknown_field', `Formula field ${expression.fieldId} is unavailable`, spanOf(expression), {
          name: `#${expression.fieldId}`,
        });
      }
      if (isComputedFieldType(field.type)) {
        fail(
          'computed_field',
          `Formula fields may reference stored fields only ({${field.name}} is computed)`,
          spanOf(expression),
          { name: field.name },
        );
      }
      return tableFormulaFieldValueType(field.type);
    }
    if (expression.type === 'binary') {
      const left = visit(expression.left, depth + 1);
      const right = visit(expression.right, depth + 1);
      if (ARITHMETIC.has(expression.operator)) {
        requireNumber(expression.left, left, { operator: expression.operator });
        requireNumber(expression.right, right, { operator: expression.operator });
        return 'number';
      }
      if (expression.operator === 'concat') return 'text';
      if (COMPARISON.has(expression.operator)) return 'boolean';
      return 'boolean';
    }
    const spec = TABLE_FORMULA_FUNCTION_CATALOG[expression.name];
    const name = expression.name.toUpperCase();
    if (!spec) fail('unknown_function', `Unknown function ${name}`, spanOf(expression), { name });
    const count = expression.args.length;
    if (count < spec.minArgs) {
      fail('too_few_arguments', `${name} needs at least ${spec.minArgs} argument(s)`, spanOf(expression), {
        name,
        min: spec.minArgs,
      });
    }
    const max = Math.min(spec.maxArgs ?? TABLE_FORMULA_MAX_ARGS, TABLE_FORMULA_MAX_ARGS);
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
      if (kind === 'unit') {
        if (argument.type !== 'literal' || normalizeTableFormulaDateUnit(argument.value) === null) {
          fail(
            'invalid_unit',
            `${name} unit must be one of ${TABLE_FORMULA_DATE_UNITS.map((unit) => `"${unit}"`).join(', ')}`,
            spanOf(argument),
            { name, units: TABLE_FORMULA_DATE_UNITS.join(', ') },
          );
        }
      }
    });
    if (expression.name === 'if') return unify(types.slice(1));
    if (expression.name === 'coalesce') return unify(types);
    if (expression.name === 'dateadd') return types[0] === 'datetime' ? 'datetime' : 'date';
    return spec.result as TableFormulaValueType;
  };

  try {
    return { ok: true, type: visit(root, 0) };
  } catch (error) {
    if (error instanceof FormulaSyntaxError) return { ok: false, error: error.detail };
    throw error;
  }
}

/**
 * Static checks on an AST against the table's active `fields`: every field
 * reference exists and is stored (formulas reference stored fields only),
 * every function exists with the right arity, argument kinds and units, and
 * the size limits hold. Returns the inferred value type. The server runs this
 * before saving; `parseTableFormula` runs it after parsing.
 */
export function checkTableFormula(
  expression: TableFormulaExpression,
  fields: readonly TableFormulaField[],
): TableFormulaCheckResult {
  return checkExpression(expression, fields);
}

// ─── Formatter ────────────────────────────────────────────

const PRECEDENCE: Record<TableFormulaBinaryOperator, number> = {
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
  // Printed as AND(…) / OR(…): a function call is atomic.
  and: 6,
  or: 6,
};
const UNARY_PRECEDENCE = 5;
const ATOMIC_PRECEDENCE = 6;

/** `0 - x` (x not a number literal) prints as `-x`: what the parser builds from a unary minus. */
function isUnaryMinus(expression: TableFormulaExpression): boolean {
  return (
    expression.type === 'binary' &&
    expression.operator === 'subtract' &&
    expression.left.type === 'literal' &&
    expression.left.value === 0 &&
    !Object.is(expression.left.value, -0) &&
    !(expression.right.type === 'literal' && typeof expression.right.value === 'number')
  );
}

function precedenceOf(expression: TableFormulaExpression): number {
  if (expression.type !== 'binary') return ATOMIC_PRECEDENCE;
  if (isUnaryMinus(expression)) return UNARY_PRECEDENCE;
  return PRECEDENCE[expression.operator];
}

function formatString(value: string): string {
  return `"${value.replace(/[\\"\n\t\r]/g, (char) =>
    char === '\n' ? '\\n' : char === '\t' ? '\\t' : char === '\r' ? '\\r' : `\\${char}`,
  )}"`;
}

/** `{Name}` with `\`, `{` and `}` escaped. */
export function formatTableFormulaFieldRef(name: string): string {
  return `{${name.replace(/[\\{}]/g, '\\$&')}}`;
}

/**
 * AST → text. Field ids print as their names from `fields` (a field missing
 * from the list prints as `{#id}`, which parses back only while that field is
 * in the table). `parseTableFormula(formatTableFormula(ast))` returns the same
 * AST, except the legacy binary `and` / `or`, which come back as the
 * equivalent `AND(…)` / `OR(…)` calls.
 */
export function formatTableFormula(
  expression: TableFormulaExpression,
  fields: ReadonlyArray<Pick<TableFormulaField, 'id' | 'name'>>,
): string {
  const names = new Map(fields.map((field) => [field.id, field.name]));
  const wrap = (child: TableFormulaExpression, needsParens: boolean): string => {
    const text = format(child);
    return needsParens ? `(${text})` : text;
  };
  const format = (node: TableFormulaExpression): string => {
    if (node.type === 'literal') {
      if (node.value === null) return 'NULL';
      if (typeof node.value === 'boolean') return node.value ? 'TRUE' : 'FALSE';
      if (typeof node.value === 'number') return String(node.value);
      return formatString(node.value);
    }
    if (node.type === 'field') {
      const name = names.get(node.fieldId);
      return name === undefined ? `{#${node.fieldId}}` : formatTableFormulaFieldRef(name);
    }
    if (node.type === 'function') {
      return `${node.name.toUpperCase()}(${node.args.map(format).join(', ')})`;
    }
    if (node.operator === 'and' || node.operator === 'or') {
      return `${node.operator.toUpperCase()}(${format(node.left)}, ${format(node.right)})`;
    }
    if (isUnaryMinus(node)) {
      return `-${wrap(node.right, precedenceOf(node.right) < UNARY_PRECEDENCE)}`;
    }
    const own = PRECEDENCE[node.operator];
    const left = wrap(node.left, precedenceOf(node.left) < own);
    const right = wrap(node.right, precedenceOf(node.right) <= own);
    return `${left} ${OPERATOR_SYMBOLS[node.operator]} ${right}`;
  };
  return format(expression);
}

// ─── Editor support ───────────────────────────────────────

/**
 * What to complete at `caret`: a field name inside an open `{…` (replace
 * `[start, end)`, the braces included), a function name being typed, or
 * nothing (inside a string, after a number…).
 */
export type TableFormulaCompletion =
  | { kind: 'field'; prefix: string; start: number; end: number }
  | { kind: 'function'; prefix: string; start: number; end: number };

export function tableFormulaCompletionAt(text: string, caret: number): TableFormulaCompletion | null {
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
    // Replace through the closing brace when this reference already has one.
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

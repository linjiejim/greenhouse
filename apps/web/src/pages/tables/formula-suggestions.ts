/**
 * Pure model behind the formula editor's autocomplete: what to offer at the
 * caret (a field inside `{…`, a function name being typed) and the text after
 * picking one. The lexical rules (strings, escapes, braces) come from
 * `tableFormulaCompletionAt` in `@greenhouse/types/table-formula`, so the
 * editor and the parser never disagree about where a field reference starts.
 */

import {
  formatTableFormulaFieldRef,
  tableFormulaCompletionAt,
  type TableFormulaCompletion,
} from '@greenhouse/types/table-formula';
import {
  isComputedFieldType,
  TABLE_FORMULA_FUNCTIONS,
  type TableFieldType,
  type TableFormulaFunction,
} from '@greenhouse/types/tables';

/** Most suggestions shown at once. */
export const MAX_FORMULA_SUGGESTIONS = 8;

export type FormulaSuggestion =
  | { kind: 'field'; key: string; label: string; fieldType: TableFieldType }
  | { kind: 'function'; key: string; label: string; name: TableFormulaFunction };

export interface FormulaSuggestionState {
  completion: TableFormulaCompletion;
  items: FormulaSuggestion[];
}

/** Starts-with matches first, then contains; both keep the input order. */
function rank<T>(entries: T[], text: (entry: T) => string, prefix: string): T[] {
  const needle = prefix.trim().toLocaleLowerCase();
  if (!needle) return entries;
  const starts = entries.filter((entry) => text(entry).toLocaleLowerCase().startsWith(needle));
  const contains = entries.filter(
    (entry) => !starts.includes(entry) && text(entry).toLocaleLowerCase().includes(needle),
  );
  return [...starts, ...contains];
}

/**
 * Suggestions for the caret. Formulas may only use stored fields, so computed
 * fields are never offered (the parser explains why if one is typed anyway).
 */
export function formulaSuggestions(
  text: string,
  caret: number,
  fields: ReadonlyArray<{ id: number; name: string; type: TableFieldType }>,
): FormulaSuggestionState | null {
  const completion = tableFormulaCompletionAt(text, caret);
  if (!completion) return null;
  if (completion.kind === 'field') {
    const stored = fields.filter((field) => !isComputedFieldType(field.type));
    const items = rank(stored, (field) => field.name, completion.prefix)
      .slice(0, MAX_FORMULA_SUGGESTIONS)
      .map(
        (field): FormulaSuggestion => ({
          kind: 'field',
          key: `f:${field.id}`,
          label: field.name,
          fieldType: field.type,
        }),
      );
    return items.length > 0 ? { completion, items } : null;
  }
  const names = rank([...TABLE_FORMULA_FUNCTIONS], (name) => name, completion.prefix);
  const items = names
    .slice(0, MAX_FORMULA_SUGGESTIONS)
    .map((name): FormulaSuggestion => ({ kind: 'function', key: `fn:${name}`, label: name.toUpperCase(), name }));
  // Typing a whole function name already is not a question.
  if (items.length === 1 && items[0]!.label === completion.prefix.toUpperCase()) return null;
  return items.length > 0 ? { completion, items } : null;
}

/** The text after picking `item`, and where the caret goes (after the field, or inside the call's parentheses). */
export function applyFormulaSuggestion(
  text: string,
  completion: TableFormulaCompletion,
  item: FormulaSuggestion,
): { text: string; caret: number } {
  const before = text.slice(0, completion.start);
  const after = text.slice(completion.end);
  if (item.kind === 'field') {
    const reference = formatTableFormulaFieldRef(item.label);
    return { text: `${before}${reference}${after}`, caret: before.length + reference.length };
  }
  const call = after.trimStart().startsWith('(') ? item.label : `${item.label}(`;
  const next = `${before}${call}${after}`;
  const caret = call.endsWith('(') ? before.length + call.length : next.indexOf('(', before.length) + 1;
  return { text: next, caret };
}

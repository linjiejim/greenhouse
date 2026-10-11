/**
 * The formula text editor of the field dialog: a monospace text box with
 * field (`{…`) and function autocomplete, the live parse error with its
 * position highlighted, and the type the formula returns.
 *
 * Parsing is the caller's (`parseTableFormula` from
 * `@greenhouse/types/table-formula`, the same parser the server's checks
 * mirror); this component only edits text and explains the result.
 */

import { useEffect, useId, useMemo, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import type {
  TableFormulaError,
  TableFormulaErrorCode,
  TableFormulaParseResult,
} from '@greenhouse/types/table-formula';
import type { TableFieldType } from '@greenhouse/types/tables';
import { Button, Textarea } from '../../components/ui';
import { FIELD_TYPE_LABEL_KEYS } from '../../components/tables/field-types';
import type { TranslationKey } from '../../lib/i18n';
import { useT } from '../../lib/i18n';
import { SquareFunction } from '../../lib/icons';
import { applyFormulaSuggestion, formulaSuggestions, type FormulaSuggestion } from './formula-suggestions';

const ERROR_KEYS: Record<TableFormulaErrorCode, TranslationKey> = {
  empty: 'tables.formula.errors.empty',
  too_long: 'tables.formula.errors.too_long',
  too_complex: 'tables.formula.errors.too_complex',
  unexpected_character: 'tables.formula.errors.unexpected_character',
  unterminated_string: 'tables.formula.errors.unterminated_string',
  unterminated_field: 'tables.formula.errors.unterminated_field',
  empty_field: 'tables.formula.errors.empty_field',
  invalid_number: 'tables.formula.errors.invalid_number',
  unexpected_token: 'tables.formula.errors.unexpected_token',
  unexpected_end: 'tables.formula.errors.unexpected_end',
  missing_closing_paren: 'tables.formula.errors.missing_closing_paren',
  unknown_field: 'tables.formula.errors.unknown_field',
  computed_field: 'tables.formula.errors.computed_field',
  unknown_function: 'tables.formula.errors.unknown_function',
  bare_word: 'tables.formula.errors.bare_word',
  too_few_arguments: 'tables.formula.errors.too_few_arguments',
  too_many_arguments: 'tables.formula.errors.too_many_arguments',
  type_mismatch: 'tables.formula.errors.type_mismatch',
  text_in_arithmetic: 'tables.formula.errors.text_in_arithmetic',
  date_in_arithmetic: 'tables.formula.errors.date_in_arithmetic',
  invalid_unit: 'tables.formula.errors.invalid_unit',
};

const EXPECTED_KEYS: Record<string, TranslationKey> = {
  number: 'tables.formula.expected.number',
  date: 'tables.formula.expected.date',
};

const RESULT_TYPE_KEYS: Partial<Record<string, TranslationKey>> = {
  text: 'tables.fieldType.text',
  number: 'tables.fieldType.number',
  boolean: 'tables.fieldType.booleanValue',
  date: 'tables.fieldType.date',
  datetime: 'tables.fieldType.datetime',
};

/** One parse error in the reader's language. */
export function useFormulaErrorText(): (error: TableFormulaError) => string {
  const t = useT();
  return (error) => {
    const params = { ...error.params };
    if (typeof params.expected === 'string' && EXPECTED_KEYS[params.expected]) {
      params.expected = t(EXPECTED_KEYS[params.expected]!);
    }
    return t(ERROR_KEYS[error.code], params);
  };
}

/** The text box itself (the shared `Textarea` takes no ref; FormField's id names it). */
function textareaById(id: string): HTMLTextAreaElement | null {
  return document.getElementById(id) as HTMLTextAreaElement | null;
}

/** Characters shown either side of an error in a long formula. */
const EXCERPT_CONTEXT = 40;

function ErrorExcerpt({ text, error }: { text: string; error: TableFormulaError }) {
  const from = Math.max(0, error.start - EXCERPT_CONTEXT);
  const to = Math.min(text.length, error.end + EXCERPT_CONTEXT);
  const marked = text.slice(error.start, error.end);
  return (
    <code className="block whitespace-pre-wrap break-all rounded-md bg-surface-sunken px-2 py-1.5 font-mono text-[11px] text-fg-secondary">
      {from > 0 && '…'}
      {text.slice(from, error.start)}
      <mark
        data-testid="formula-error-mark"
        className="rounded-sm bg-danger-subtle px-px text-danger underline decoration-wavy underline-offset-2"
      >
        {marked || ' '}
      </mark>
      {text.slice(error.end, to)}
      {to < text.length && '…'}
    </code>
  );
}

interface FormulaEditorProps {
  value: string;
  onChange: (text: string) => void;
  /** The table's fields the formula may name (the edited field excluded). */
  fields: ReadonlyArray<{ id: number; name: string; type: TableFieldType }>;
  /** `parseTableFormula(value, fields)`, computed by the caller (it also builds the config from it). */
  result: TableFormulaParseResult;
  /** Set by `FormField` so its label names the text box. */
  id?: string;
  'aria-describedby'?: string;
}

export function FormulaEditor({
  value,
  onChange,
  fields,
  result,
  id: controlId,
  'aria-describedby': describedBy,
}: FormulaEditorProps) {
  const t = useT();
  const errorText = useFormulaErrorText();
  const generatedId = useId();
  const id = controlId ?? generatedId;
  const listId = `${id}-suggestions`;
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [pendingCaret, setPendingCaret] = useState<number | null>(null);

  const suggestions = useMemo(
    () => (caret === null || dismissed ? null : formulaSuggestions(value, caret, fields)),
    [caret, dismissed, fields, value],
  );
  const suggestionKeys = suggestions?.items.map((item) => item.key).join('|');
  useEffect(() => setActive(0), [suggestionKeys]);

  // Place the caret after an inserted suggestion once React rendered the new text.
  useEffect(() => {
    const textarea = textareaById(id);
    if (pendingCaret === null || !textarea) return;
    textarea.focus();
    textarea.setSelectionRange(pendingCaret, pendingCaret);
    setCaret(pendingCaret);
    setPendingCaret(null);
  }, [id, pendingCaret, value]);

  const track = (event: SyntheticEvent<HTMLTextAreaElement>) => {
    const target = event.currentTarget;
    setCaret(target.selectionStart === target.selectionEnd ? target.selectionStart : null);
  };

  const pick = (item: FormulaSuggestion) => {
    if (!suggestions) return;
    const next = applyFormulaSuggestion(value, suggestions.completion, item);
    setPendingCaret(next.caret);
    onChange(next.text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!suggestions || event.nativeEvent.isComposing) return;
    const count = suggestions.items.length;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => (index + 1) % count);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => (index - 1 + count) % count);
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pick(suggestions.items[Math.min(active, count - 1)]!);
    } else if (event.key === 'Escape') {
      // Close the list, not the dialog.
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  };

  const selectError = (error: TableFormulaError) => {
    const textarea = textareaById(id);
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(error.start, Math.max(error.end, error.start));
  };

  const error = !result.ok && value.trim() ? result.error : null;
  const resultTypeKey = result.ok ? RESULT_TYPE_KEYS[result.type] : undefined;

  return (
    <div className="space-y-2">
      <Textarea
        id={id}
        rows={3}
        value={value}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        placeholder={t('tables.formula.placeholder')}
        aria-label={controlId ? undefined : t('tables.formula.editorLabel')}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        aria-autocomplete="list"
        aria-controls={suggestions ? listId : undefined}
        aria-expanded={suggestions ? true : false}
        role="combobox"
        className={`font-mono text-xs ${error ? 'border-danger' : ''}`}
        data-testid="formula-editor-input"
        onChange={(event) => {
          setDismissed(false);
          onChange(event.target.value);
          track(event);
        }}
        onSelect={track}
        onClick={track}
        onKeyUp={(event) => {
          if (event.key.startsWith('Arrow') && suggestions) return;
          track(event);
        }}
        onKeyDown={onKeyDown}
        onBlur={() => setCaret(null)}
      />

      {suggestions && (
        <div
          id={listId}
          role="listbox"
          aria-label={t('tables.formula.suggestions')}
          data-testid="formula-suggestions"
          className="max-h-48 overflow-y-auto rounded-md border border-edge bg-surface-raised py-1 shadow-sm"
        >
          {suggestions.items.map((item, index) => {
            const selected = index === active;
            return (
              <button
                key={item.key}
                type="button"
                role="option"
                aria-selected={selected}
                data-testid={`formula-suggestion-${item.key}`}
                // Keep the caret in the text box: pick on mouse down, before blur.
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
                onMouseEnter={() => setActive(index)}
                className={`flex w-full items-baseline gap-2 px-2.5 py-1 text-left text-xs transition-colors ${
                  selected ? 'bg-primary-subtle text-primary-fg-strong' : 'text-fg hover:bg-surface-muted'
                }`}
              >
                {item.kind === 'field' ? (
                  <>
                    <span className="truncate font-mono">{`{${item.label}}`}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                      {t(FIELD_TYPE_LABEL_KEYS[item.fieldType])}
                    </span>
                  </>
                ) : (
                  <>
                    <SquareFunction size={12} className="shrink-0 self-center text-fg-muted" />
                    <span className="min-w-0 truncate">{t(`tables.formula.functions.${item.name}`)}</span>
                  </>
                )}
              </button>
            );
          })}
        </div>
      )}

      {error ? (
        <div role="alert" data-testid="formula-error" className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs text-danger">{errorText(error)}</p>
            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => selectError(error)}
              title={t('tables.formula.errorAt', { position: error.start + 1 })}
            >
              {t('tables.formula.showError')}
            </Button>
          </div>
          <ErrorExcerpt text={value} error={error} />
        </div>
      ) : result.ok && (resultTypeKey || result.type === 'unknown') ? (
        <p className="text-[11px] text-fg-muted" data-testid="formula-result-type">
          {resultTypeKey ? t('tables.formula.returns', { type: t(resultTypeKey) }) : t('tables.formula.returnsMixed')}
        </p>
      ) : (
        <p className="text-[11px] text-fg-faint">{t('tables.formula.hint')}</p>
      )}
    </div>
  );
}

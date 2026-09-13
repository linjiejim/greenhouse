/**
 * Fill-in form for a selected Task's `{{variables}}`.
 *
 * Sits under the task pill in the composer rather than being asked for
 * conversationally. Two reasons, both about cost: it is deterministic (the
 * user sees every field the task needs at once, and can tab through them), and
 * it spends no model round-trip on data collection. `ask_user` remains the
 * fallback for a task that arrives with placeholders still unfilled — someone
 * cleared a field, or pasted the body in from elsewhere (spec D3).
 */

import React from 'react';
import { missingRequired, type TaskVariable } from '@greenhouse/types/tasks';
import { Input } from '../ui';
import { useT } from '../../lib/i18n';

export function TaskVariableForm({
  variables,
  values,
  onChange,
  onComplete,
}: {
  variables: TaskVariable[];
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Move forward from the last variable into the free-form message field. */
  onComplete?: () => void;
}) {
  const t = useT();
  if (variables.length === 0) return null;
  const missingKeys = new Set(missingRequired(variables, values).map((variable) => variable.key));

  return (
    <div className="grid gap-2 px-3 pb-2 sm:grid-cols-2" data-task-variable-form>
      {variables.map((variable) => {
        const missing = missingKeys.has(variable.key);
        return (
          <label key={variable.key} className="flex min-w-0 flex-col gap-1">
            <span className="truncate text-[10px] text-fg-muted" title={variable.description || undefined}>
              {variable.label}
              {variable.required && <span className="ml-0.5 text-danger">*</span>}
            </span>
            <Input
              size="sm"
              value={values[variable.key] ?? ''}
              onChange={(e) => onChange(variable.key, e.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                const fields = Array.from(
                  event.currentTarget
                    .closest('[data-task-variable-form]')
                    ?.querySelectorAll<HTMLInputElement>('[data-task-variable-input]') ?? [],
                );
                const currentIndex = fields.indexOf(event.currentTarget);
                if (event.shiftKey) {
                  const previous = fields[currentIndex - 1];
                  if (!previous) return;
                  event.preventDefault();
                  previous.focus();
                  return;
                }
                const next = fields[currentIndex + 1];
                if (!next && !onComplete) return;
                event.preventDefault();
                if (next) next.focus();
                else if (onComplete) onComplete();
              }}
              placeholder={variable.example || t('tasks.variablePlaceholder')}
              aria-label={variable.label}
              autoComplete="off"
              data-task-variable-input={variable.key}
              // Signalled, not blocked: Send stays enabled, and an unfilled
              // placeholder reaches the model as `{{key}}` for it to ask about.
              className={missing ? 'border-danger' : ''}
            />
          </label>
        );
      })}
    </div>
  );
}

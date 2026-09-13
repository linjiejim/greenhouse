/**
 * ConfirmBlock — renders interactive confirmation buttons from custom code fence.
 *
 * After clicking, buttons are disabled and show a "confirmed" state.
 * If no onConfirmAction callback is provided, buttons are rendered but non-interactive.
 */

import React, { useRef, useState } from 'react';
import type { ConfirmData } from './index';
import { Button } from '../ui';
import { Check } from '../../lib/icons';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';

// ─── Component ───────────────────────────────────────────

const BUTTON_VARIANTS = {
  primary: 'default',
  secondary: 'outline',
  destructive: 'destructive',
} as const;

export function ConfirmBlock({
  data,
  compact = false,
  onAction,
  resolvedValue,
}: {
  data: ConfirmData;
  compact?: boolean;
  onAction?: (value: string) => void;
  /** Persisted next user message, when it matches one of this block's values. */
  resolvedValue?: string;
}) {
  const persistedValue = data.actions.some((action) => action.value === resolvedValue) ? resolvedValue! : null;
  const [localValue, setLocalValue] = useState<string | null>(null);
  const selectedValue = persistedValue ?? localValue;
  const submittingRef = useRef(false);

  const handleClick = (value: string) => {
    if (selectedValue || submittingRef.current) return;
    submittingRef.current = true;
    setLocalValue(value);
    onAction?.(value);
  };

  const isResolved = selectedValue !== null;

  return (
    <RichBlockShell compact={compact} tone={isResolved ? 'muted' : 'accent'}>
      <div className={richBlockBodyClass(compact)}>
        <p
          className={`${compact ? 'mb-2 text-sm leading-[1.6]' : 'mb-3 text-sm leading-[1.72]'} ${
            isResolved ? 'text-fg-muted' : 'text-fg-secondary'
          }`}
        >
          {data.text}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {data.actions.map((action) => {
            const isSelected = selectedValue === action.value;
            const variant = action.variant || 'secondary';

            if (isResolved) {
              return (
                <Button
                  key={action.value}
                  disabled
                  size="sm"
                  variant="outline"
                  className={`gap-1 disabled:opacity-100 ${
                    isSelected
                      ? 'border-primary-300 bg-primary-subtle-hover text-primary-fg-strong'
                      : 'border-edge bg-surface-muted text-fg-faint'
                  }`}
                >
                  {isSelected && <Check size={12} aria-hidden="true" />}
                  {action.label}
                </Button>
              );
            }

            return (
              <Button
                key={action.value}
                onClick={() => handleClick(action.value)}
                disabled={!onAction}
                size="sm"
                variant={BUTTON_VARIANTS[variant]}
              >
                {action.label}
              </Button>
            );
          })}
        </div>
      </div>
    </RichBlockShell>
  );
}

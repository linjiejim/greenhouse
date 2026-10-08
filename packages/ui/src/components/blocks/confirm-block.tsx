/**
 * ConfirmBlock — renders interactive confirmation buttons from custom code fence.
 *
 * After clicking, buttons are disabled and show a "confirmed" state.
 * If no onConfirmAction callback is provided, buttons are rendered but non-interactive.
 */

import React, { useRef, useState } from 'react';
import type { ConfirmData } from './index';

// ─── Component ───────────────────────────────────────────

export function ConfirmBlock({
  data,
  onAction,
  resolvedValue,
}: {
  data: ConfirmData;
  /** A returned promise that rejects means the choice was not delivered: the buttons re-arm. */
  onAction?: (value: string) => void | Promise<void>;
  /** The next user message, when it matches one of this block's values (restores the choice after reload). */
  resolvedValue?: string;
}) {
  const persistedValue = data.actions.some((action) => action.value === resolvedValue) ? resolvedValue! : null;
  const [localValue, setLocalValue] = useState<string | null>(null);
  const selectedValue = persistedValue ?? localValue;
  const submittingRef = useRef(false);

  const handleClick = (value: string) => {
    if (selectedValue || submittingRef.current) return; // Already clicked
    submittingRef.current = true;
    setLocalValue(value);
    Promise.resolve(onAction?.(value)).catch(() => {
      submittingRef.current = false;
      setLocalValue(null);
    });
  };

  const isResolved = selectedValue !== null;

  return (
    <div
      className={`my-3 border rounded-lg overflow-hidden transition-colors ${
        isResolved ? 'bg-surface-sunken border-edge' : 'bg-primary-subtle/30 border-primary-edge'
      }`}
    >
      <div className="px-4 py-3">
        <p className={`text-sm mb-3 ${isResolved ? 'text-fg-muted' : 'text-fg-secondary'}`}>{data.text}</p>
        <div className="flex items-center gap-2 flex-wrap">
          {data.actions.map((action) => {
            const isSelected = selectedValue === action.value;
            const variant = action.variant || 'secondary';

            if (isResolved) {
              return (
                <button
                  key={action.value}
                  disabled
                  className={`px-3 py-1.5 text-xs rounded-md border transition-colors ${
                    isSelected
                      ? 'bg-primary-subtle-hover text-primary-fg-strong border-primary-300 font-medium'
                      : 'bg-surface-muted text-fg-faint border-edge'
                  }`}
                >
                  {isSelected ? '✓ ' : ''}
                  {action.label}
                </button>
              );
            }

            // Active state — clickable
            const baseStyles = 'px-3 py-1.5 text-xs rounded-md border font-medium transition-colors cursor-pointer';
            const variantStyles = {
              primary: 'bg-primary-600 text-white border-primary-600 hover:bg-primary-700',
              secondary: 'bg-surface-raised text-fg-secondary border-edge-strong hover:bg-surface-sunken',
              destructive: 'bg-destructive text-white border-destructive hover:bg-destructive-hover',
            };

            return (
              <button
                key={action.value}
                onClick={() => handleClick(action.value)}
                disabled={!onAction}
                className={`${baseStyles} ${variantStyles[variant]} ${!onAction ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                {action.label}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * BlockActions — the buttons under a Rich Output block (confirm, stats, cards,
 * steps). Pressing one hands its `value` to the host, which sends it as the
 * member's next message; the choice then shows as selected, and a reload
 * restores it from that message (`resolvedValue`). Without `onAction` (a
 * read-only viewer, a shared session) the buttons render disabled.
 *
 * One implementation for the web app and the browser extension (spec
 * docs/specs/20261008-interactive-rich-blocks.md D5).
 */

import React, { useRef, useState } from 'react';
import { resolveBlockAction, type BlockAction } from './index';
import { Check } from '../../lib/icons';

const BASE =
  'inline-flex items-center justify-center gap-1 rounded-lg font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500/40 disabled:cursor-not-allowed';

const VARIANTS = {
  primary: 'bg-primary-600 text-white shadow-sm shadow-primary-900/10 hover:bg-primary-700',
  secondary: 'border border-edge-strong text-fg-secondary hover:bg-surface-sunken',
  destructive: 'bg-destructive text-white hover:bg-destructive-hover',
} as const;

export interface BlockActionsProps {
  actions: readonly BlockAction[];
  /** A returned promise that rejects means the choice was not delivered: the buttons re-arm. */
  onAction?: (value: string) => void | Promise<void>;
  /** The member's next message, when it is one of these values (restores the choice after reload). */
  resolvedValue?: string | null;
  compact?: boolean;
  className?: string;
  /** Told when a press is in flight or settled (null again if the delivery failed) — e.g. to mute the block. */
  onPressedChange?: (value: string | null) => void;
}

export function BlockActions({
  actions,
  onAction,
  resolvedValue,
  compact = false,
  className = '',
  onPressedChange,
}: BlockActionsProps) {
  const persisted = resolveBlockAction(actions, resolvedValue);
  const [localValue, setLocalValue] = useState<string | null>(null);
  const selected = persisted ?? localValue;
  const submittingRef = useRef(false);
  const size = compact ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-xs';

  const press = (value: string) => {
    if (selected || submittingRef.current || !onAction) return;
    submittingRef.current = true;
    setLocalValue(value);
    onPressedChange?.(value);
    Promise.resolve(onAction(value)).catch(() => {
      submittingRef.current = false;
      setLocalValue(null);
      onPressedChange?.(null);
    });
  };

  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`} data-block-actions="">
      {actions.map((action) => {
        if (selected !== null) {
          const isSelected = selected === action.value;
          return (
            <button
              key={action.value}
              type="button"
              disabled
              aria-pressed={isSelected}
              className={`${BASE} ${size} border ${
                isSelected
                  ? 'border-primary-300 bg-primary-subtle-hover text-primary-fg-strong'
                  : 'border-edge bg-surface-muted text-fg-faint'
              }`}
            >
              {isSelected && <Check size={12} aria-hidden="true" />}
              {action.label}
            </button>
          );
        }
        return (
          <button
            key={action.value}
            type="button"
            onClick={() => press(action.value)}
            disabled={!onAction}
            title={action.value}
            className={`${BASE} ${size} ${VARIANTS[action.variant ?? 'secondary']} ${onAction ? '' : 'opacity-50'}`}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

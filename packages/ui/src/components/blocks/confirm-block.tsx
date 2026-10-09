/**
 * ConfirmBlock — renders interactive confirmation buttons from custom code fence.
 *
 * The buttons are the shared BlockActions: after a click they show the choice;
 * without an `onAction` handler they render disabled.
 */

import React from 'react';
import { resolveBlockAction, type ConfirmData } from './index';
import { BlockActions } from './block-actions';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';

// ─── Component ───────────────────────────────────────────

export function ConfirmBlock({
  data,
  onAction,
  resolvedValue,
  compact = false,
}: {
  data: ConfirmData;
  /** A returned promise that rejects means the choice was not delivered: the buttons re-arm. */
  onAction?: (value: string) => void | Promise<void>;
  /** The next user message, when it matches one of this block's values (restores the choice after reload). */
  resolvedValue?: string;
  compact?: boolean;
}) {
  const resolved = resolveBlockAction(data.actions, resolvedValue) !== null;
  return (
    <RichBlockShell compact={compact} tone={resolved ? 'muted' : 'accent'}>
      <div className={richBlockBodyClass(compact)}>
        <p className={`mb-2 text-sm ${resolved ? 'text-fg-muted' : 'text-fg-secondary'}`}>{data.text}</p>
        <BlockActions actions={data.actions} onAction={onAction} resolvedValue={resolvedValue} compact={compact} />
      </div>
    </RichBlockShell>
  );
}

/**
 * ConfirmBlock — a question with buttons, from the ```confirm fence.
 *
 * The buttons are the shared BlockActions (the same ones stats / cards / steps
 * carry): after a click they show the choice and the block mutes; without an
 * `onAction` handler they render disabled.
 */

import React, { useState } from 'react';
import { resolveBlockAction, type ConfirmData } from './index';
import { BlockActions } from '@greenhouse/ui/components/blocks/block-actions';
import { RichBlockShell, richBlockBodyClass } from '@greenhouse/ui/components/blocks/rich-block-shell';

// ─── Component ───────────────────────────────────────────

export function ConfirmBlock({
  data,
  compact = false,
  onAction,
  resolvedValue,
}: {
  data: ConfirmData;
  compact?: boolean;
  /** A returned promise that rejects means the choice was not delivered: the buttons re-arm. */
  onAction?: (value: string) => void | Promise<void>;
  /** Persisted next user message, when it matches one of this block's values. */
  resolvedValue?: string;
}) {
  const [pressed, setPressed] = useState<string | null>(null);
  const isResolved = pressed !== null || resolveBlockAction(data.actions, resolvedValue) !== null;

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
        <BlockActions
          actions={data.actions}
          onAction={onAction}
          resolvedValue={resolvedValue}
          compact={compact}
          onPressedChange={setPressed}
        />
      </div>
    </RichBlockShell>
  );
}

/**
 * StepsBlock — the ```steps fence: a plan, a progress report or a dated
 * history as a vertical timeline. Each step carries one of five states; the
 * host supplies their words (`copy.status`), so the kit holds no catalog.
 */

import React from 'react';
import type { StepItem, StepStatus, StepsData } from './index';
import { BlockActions, type BlockActionsProps } from './block-actions';
import { BlockTitle } from './stats-block';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';
import { Tag } from '../ui';
import { AlertTriangle, Check, Circle, CircleDot, Minus } from '../../lib/icons';

export interface StepsCopy {
  status: Record<StepStatus, string>;
}

export interface StepsBlockProps extends Pick<BlockActionsProps, 'onAction' | 'resolvedValue'> {
  data: StepsData;
  copy: StepsCopy;
  compact?: boolean;
}

const MARKER = {
  done: { Icon: Check, className: 'bg-primary-600 text-white border-primary-600' },
  active: { Icon: CircleDot, className: 'bg-primary-subtle text-primary-fg-strong border-primary-300' },
  pending: { Icon: Circle, className: 'bg-surface-raised text-fg-faint border-edge' },
  blocked: { Icon: AlertTriangle, className: 'bg-warning-subtle text-warning border-warning' },
  skipped: { Icon: Minus, className: 'bg-surface-muted text-fg-faint border-edge' },
} as const;

/** States worth a word next to the title; done / pending read from the marker alone. */
const LABELLED = { active: 'primary', blocked: 'warning', skipped: 'neutral' } as const;

export function StepsBlock({ data, copy, compact = false, onAction, resolvedValue }: StepsBlockProps) {
  return (
    <RichBlockShell compact={compact} header={data.title ? <BlockTitle title={data.title} /> : undefined}>
      <div className={richBlockBodyClass(compact)}>
        <ol className="relative">
          {data.items.map((item, index) => (
            <Step key={index} item={item} copy={copy} last={index === data.items.length - 1} />
          ))}
        </ol>
        {data.actions?.length ? (
          <BlockActions
            actions={data.actions}
            onAction={onAction}
            resolvedValue={resolvedValue}
            compact={compact}
            className="mt-3"
          />
        ) : null}
      </div>
    </RichBlockShell>
  );
}

function Step({ item, copy, last }: { item: StepItem; copy: StepsCopy; last: boolean }) {
  const { Icon, className } = MARKER[item.status];
  const tagTone = item.status in LABELLED ? LABELLED[item.status as keyof typeof LABELLED] : null;
  return (
    <li className="relative flex gap-3 pb-3 last:pb-0" data-step-status={item.status}>
      {!last && <span className="absolute left-[9px] top-5 bottom-0 w-px bg-edge" aria-hidden="true" />}
      <span
        className={`relative z-[1] mt-0.5 flex h-[19px] w-[19px] shrink-0 items-center justify-center rounded-full border ${className}`}
        aria-hidden="true"
      >
        <Icon size={11} strokeWidth={2.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <span
            className={`text-sm ${item.status === 'active' ? 'font-semibold text-fg' : 'text-fg'} ${
              item.status === 'skipped' ? 'text-fg-faint line-through' : ''
            }`}
          >
            {item.title}
          </span>
          <span className="sr-only">({copy.status[item.status]})</span>
          {tagTone && <Tag tone={tagTone}>{copy.status[item.status]}</Tag>}
          {item.time && <span className="ml-auto shrink-0 text-xs tabular-nums text-fg-faint">{item.time}</span>}
        </div>
        {item.detail && <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{item.detail}</p>}
      </div>
    </li>
  );
}

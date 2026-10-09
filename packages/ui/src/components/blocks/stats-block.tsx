/**
 * StatsBlock — the ```stats fence: 1–8 headline figures as tiles.
 *
 * Direction (`trend`, the arrow) and colour (`tone`) are separate on purpose: a
 * rising cost is bad news, so colour appears only when the model said what the
 * change means (spec docs/specs/20261008-interactive-rich-blocks.md D7).
 */

import React from 'react';
import type { StatItem, StatsData } from './index';
import { BlockActions, type BlockActionsProps } from './block-actions';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';
import { ArrowDown, ArrowRight, ArrowUp } from '../../lib/icons';
import { formatKpi } from '../../lib/number-format';

const TONE_CLASS = {
  positive: 'text-success',
  negative: 'text-danger',
  neutral: 'text-fg-muted',
} as const;

const TREND_ICON = { up: ArrowUp, down: ArrowDown, flat: ArrowRight } as const;

export interface StatsBlockProps extends Pick<BlockActionsProps, 'onAction' | 'resolvedValue'> {
  data: StatsData;
  compact?: boolean;
}

export function StatsBlock({ data, compact = false, onAction, resolvedValue }: StatsBlockProps) {
  return (
    <RichBlockShell compact={compact} header={data.title ? <BlockTitle title={data.title} /> : undefined}>
      <div className={richBlockBodyClass(compact)}>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(140px,1fr))] gap-2">
          {data.items.map((item, index) => (
            <StatTile key={index} item={item} compact={compact} />
          ))}
        </div>
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

function StatTile({ item, compact }: { item: StatItem; compact: boolean }) {
  const value = typeof item.value === 'number' ? (formatKpi(item.value) ?? String(item.value)) : item.value;
  const Trend = item.trend ? TREND_ICON[item.trend] : null;
  const toneClass = TONE_CLASS[item.tone ?? 'neutral'];
  const delta = item.delta === undefined ? null : String(item.delta);

  return (
    <div
      className={`min-w-0 rounded-md border border-edge bg-surface-raised ${compact ? 'px-3 py-2' : 'px-3.5 py-2.5'}`}
    >
      <div className="truncate text-xs text-fg-muted" title={item.label}>
        {item.label}
      </div>
      <div className="mt-0.5 flex items-baseline gap-1">
        <span
          className={`font-semibold tabular-nums leading-tight text-fg ${compact ? 'text-xl' : 'text-2xl'}`}
          title={String(item.value)}
        >
          {value}
        </span>
        {item.unit && <span className="text-xs text-fg-muted">{item.unit}</span>}
      </div>
      {(delta || item.hint) && (
        <div className="mt-1 flex min-w-0 items-center gap-1 text-xs">
          {(Trend || delta) && (
            <span className={`inline-flex shrink-0 items-center gap-0.5 font-medium tabular-nums ${toneClass}`}>
              {Trend && <Trend size={12} aria-hidden="true" />}
              {delta}
            </span>
          )}
          {item.hint && (
            <span className="truncate text-fg-faint" title={item.hint}>
              {item.hint}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** The header line every business block uses for its optional title. */
export function BlockTitle({ title }: { title: string }) {
  return <div className="truncate text-xs font-semibold text-fg">{title}</div>;
}

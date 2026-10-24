/**
 * Stats, cards and steps blocks (ported from v2's RichContent onto the v1 block shell).
 *
 * The data was validated by `parseSegments` (`@greenhouse/types/rich-output`); these only
 * draw it. Buttons under a block send their `value` as the member's next message through the
 * same callback as confirm buttons — nothing runs behind the member's back — and the pressed
 * one is read back from the persisted follow-up message (`resolveBlockAction`), so a reload
 * or another device shows the same choice.
 */

import React, { useRef, useState } from 'react';
import { parseEntityUrl } from '@greenhouse/types/entity-links';
import { resolveBlockAction, type BlockAction, type CardsData, type StatsData, type StepsData } from './index';
import { Button, Tag } from '../ui';
import { ArrowDown, ArrowUp, Check } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { openEntityPeek } from '../../stores/entity-peek-store';
import { isSidePaneAvailable, openSidePane } from '../../stores/side-pane-store';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';

const BUTTON_VARIANTS = {
  primary: 'default',
  secondary: 'outline',
  destructive: 'destructive',
} as const;

export interface BlockActionProps {
  compact?: boolean;
  /** Sends a button's value as the member's next message. Absent → buttons are inert. */
  onAction?: (value: string) => void;
  /** The member's message after this reply (which button was pressed). */
  resolvedValue?: string;
}

function BlockActions({ actions, compact, onAction, resolvedValue }: BlockActionProps & { actions?: BlockAction[] }) {
  const [local, setLocal] = useState<string | null>(null);
  const sending = useRef(false);
  if (!actions?.length) return null;
  const chosen = resolveBlockAction(actions, resolvedValue) ?? local;
  return (
    <div className={`flex flex-wrap items-center gap-2 border-t border-edge ${compact ? 'px-3 py-2' : 'px-4 py-2.5'}`}>
      {actions.map((action) => {
        const selected = chosen === action.value;
        return (
          <Button
            key={action.value}
            size="sm"
            variant={chosen ? 'outline' : BUTTON_VARIANTS[action.variant ?? 'secondary']}
            disabled={chosen !== null || !onAction}
            aria-pressed={selected || undefined}
            className={
              chosen
                ? `gap-1 disabled:opacity-100 ${selected ? 'border-primary-300 bg-primary-subtle-hover text-primary-fg-strong' : 'text-fg-faint'}`
                : undefined
            }
            onClick={() => {
              if (chosen || sending.current) return;
              sending.current = true;
              setLocal(action.value);
              onAction?.(action.value);
            }}
          >
            {selected && <Check size={12} aria-hidden="true" />}
            {action.label}
          </Button>
        );
      })}
    </div>
  );
}

function BlockTitle({ title }: { title?: string }) {
  return title ? <span className="text-xs font-semibold text-fg">{title}</span> : undefined;
}

// ─── Stats ───────────────────────────────────────────────

const DELTA_TONE = { positive: 'text-success', negative: 'text-danger', neutral: 'text-fg-muted' } as const;

export function StatsBlock({ data, ...actionProps }: { data: StatsData } & BlockActionProps) {
  const { compact } = actionProps;
  return (
    <RichBlockShell compact={compact} header={BlockTitle({ title: data.title })}>
      <div
        className={`grid gap-2 ${richBlockBodyClass(compact)}`}
        style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(8.5rem, 1fr))' }}
        data-testid="rich-stats"
      >
        {data.items.map((item, index) => (
          <div
            key={index}
            className="flex min-w-0 flex-col gap-0.5 rounded-md border border-edge bg-surface-raised p-2.5"
          >
            <span className="truncate text-xs text-fg-muted">{item.label}</span>
            <span className="text-lg font-semibold tabular-nums text-fg">
              {typeof item.value === 'number' ? item.value.toLocaleString() : item.value}
              {item.unit && <span className="ml-1 text-xs font-normal text-fg-muted">{item.unit}</span>}
            </span>
            {item.delta !== undefined && (
              <span
                className={`inline-flex items-center gap-0.5 text-xs font-medium ${DELTA_TONE[item.tone ?? 'neutral']}`}
              >
                {item.trend === 'up' && <ArrowUp size={12} aria-hidden="true" />}
                {item.trend === 'down' && <ArrowDown size={12} aria-hidden="true" />}
                {item.delta}
              </span>
            )}
            {item.hint && <span className="truncate text-xs text-fg-faint">{item.hint}</span>}
          </div>
        ))}
      </div>
      <BlockActions actions={data.actions} {...actionProps} />
    </RichBlockShell>
  );
}

// ─── Cards ───────────────────────────────────────────────

/** A card's in-app record link opens beside the chat (or as a peek), like a link in the text. */
function openCardLink(e: React.MouseEvent<HTMLAnchorElement>, url: string, label: string) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
  const ref = parseEntityUrl(url);
  if (!ref) return;
  e.preventDefault();
  if (isSidePaneAvailable()) openSidePane({ kind: 'entity', ref, label });
  else openEntityPeek({ ref, label });
}

export function CardsBlock({ data, ...actionProps }: { data: CardsData } & BlockActionProps) {
  const { compact } = actionProps;
  return (
    <RichBlockShell compact={compact} header={BlockTitle({ title: data.title })}>
      <ul className={`flex flex-col gap-2 ${richBlockBodyClass(compact)}`} data-testid="rich-cards">
        {data.items.map((item, index) => {
          const external = item.url ? /^https?:/i.test(item.url) : false;
          const body = (
            <>
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <span className="min-w-0 truncate text-sm font-semibold text-fg">{item.title}</span>
                {item.badges?.map((badge) => (
                  <Tag key={badge.label} tone={badge.tone ?? 'neutral'} size="xs">
                    {badge.label}
                  </Tag>
                ))}
              </span>
              {item.subtitle && <span className="text-xs text-fg-muted">{item.subtitle}</span>}
              {item.fields?.length ? (
                <dl className="mt-0.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
                  {item.fields.map((field) => (
                    <div key={field.label} className="flex gap-1">
                      <dt className="text-fg-muted">{field.label}</dt>
                      <dd className="text-fg">{field.value}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </>
          );
          const frame = 'flex flex-col gap-1 rounded-md border border-edge bg-surface-raised p-2.5';
          return (
            <li key={index}>
              {item.url ? (
                <a
                  href={item.url}
                  className={`${frame} no-underline transition-colors hover:border-primary-edge hover:bg-surface-muted`}
                  onClick={external ? undefined : (e) => openCardLink(e, item.url!, item.title)}
                  {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
                >
                  {body}
                </a>
              ) : (
                <div className={frame}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
      <BlockActions actions={data.actions} {...actionProps} />
    </RichBlockShell>
  );
}

// ─── Steps ───────────────────────────────────────────────

const STEP_DOT = {
  done: 'bg-success border-success',
  active: 'bg-primary-500 border-primary-500 ring-2 ring-primary-500/25',
  pending: 'bg-surface-card border-edge-strong',
  blocked: 'bg-danger border-danger',
  skipped: 'bg-surface-muted border-edge',
} as const;

export function StepsBlock({ data, ...actionProps }: { data: StepsData } & BlockActionProps) {
  const t = useT();
  const { compact } = actionProps;
  return (
    <RichBlockShell compact={compact} header={BlockTitle({ title: data.title })}>
      <ol className={`flex flex-col ${richBlockBodyClass(compact)}`} data-testid="rich-steps">
        {data.items.map((item, index) => {
          const last = index === data.items.length - 1;
          return (
            <li key={index} className="relative flex gap-3 pb-3 last:pb-0">
              {!last && <span className="absolute left-[5px] top-4 bottom-0 w-px bg-edge" aria-hidden="true" />}
              <span
                className={`relative mt-1.5 h-[11px] w-[11px] flex-shrink-0 rounded-full border ${STEP_DOT[item.status]}`}
                aria-hidden="true"
              />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="flex items-baseline gap-2">
                  <span
                    className={`min-w-0 text-sm ${
                      item.status === 'skipped' ? 'text-fg-faint line-through' : 'font-medium text-fg'
                    }`}
                  >
                    {item.title}
                  </span>
                  {item.status !== 'done' && item.status !== 'pending' && (
                    <span className={`text-xs ${item.status === 'blocked' ? 'text-danger' : 'text-fg-muted'}`}>
                      {t(`richBlocks.step.${item.status}`)}
                    </span>
                  )}
                  {item.time && (
                    <span className="ml-auto flex-shrink-0 text-xs tabular-nums text-fg-faint">{item.time}</span>
                  )}
                </span>
                {item.detail && <span className="text-xs text-fg-muted">{item.detail}</span>}
                {(item.status === 'done' || item.status === 'pending') && (
                  <span className="sr-only">{t(`richBlocks.step.${item.status}`)}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      <BlockActions actions={data.actions} {...actionProps} />
    </RichBlockShell>
  );
}

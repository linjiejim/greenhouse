/**
 * CardsBlock — the ```cards fence: records worth scanning (projects, customers,
 * documents…) as compact cards with badges and a few fields.
 *
 * Opening a card is the host's business (`onOpenUrl`): the web app turns an
 * in-app `#/…` link into its entity peek / side pane, the browser extension
 * opens it in the station's web app. Without a handler, cards are plain text.
 */

import React from 'react';
import type { CardItem, CardsData } from './index';
import { BlockActions, type BlockActionsProps } from './block-actions';
import { BlockTitle } from './stats-block';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';
import { Tag } from '../ui';
import { ChevronRight, ExternalLink } from '../../lib/icons';

export interface CardsBlockProps extends Pick<BlockActionsProps, 'onAction' | 'resolvedValue'> {
  data: CardsData;
  compact?: boolean;
  /** Open a card's link (`#/projects/42` or an http(s) URL); `label` is the card title. */
  onOpenUrl?: (url: string, label: string) => void;
}

export function CardsBlock({ data, compact = false, onAction, resolvedValue, onOpenUrl }: CardsBlockProps) {
  return (
    <RichBlockShell compact={compact} header={data.title ? <BlockTitle title={data.title} /> : undefined}>
      <div className={richBlockBodyClass(compact)}>
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
          {data.items.map((item, index) => (
            <li key={index} className="min-w-0">
              <Card item={item} compact={compact} onOpenUrl={onOpenUrl} />
            </li>
          ))}
        </ul>
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

function Card({
  item,
  compact,
  onOpenUrl,
}: {
  item: CardItem;
  compact: boolean;
  onOpenUrl?: (url: string, label: string) => void;
}) {
  const url = item.url;
  const openable = Boolean(url && onOpenUrl);
  const external = Boolean(url && /^https?:/i.test(url));
  const body = (
    <>
      <div className="flex min-w-0 items-start gap-1.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg" title={item.title}>
          {item.title}
        </span>
        {openable &&
          (external ? (
            <ExternalLink size={13} className="mt-0.5 shrink-0 text-fg-faint" aria-hidden="true" />
          ) : (
            <ChevronRight size={14} className="mt-0.5 shrink-0 text-fg-faint" aria-hidden="true" />
          ))}
      </div>
      {item.subtitle && (
        <div className="mt-0.5 truncate text-xs text-fg-muted" title={item.subtitle}>
          {item.subtitle}
        </div>
      )}
      {item.badges?.length ? (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {item.badges.map((badge, index) => (
            <Tag key={index} tone={badge.tone ?? 'neutral'}>
              {badge.label}
            </Tag>
          ))}
        </div>
      ) : null}
      {item.fields?.length ? (
        <dl className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs">
          {item.fields.map((field, index) => (
            <div key={index} className="flex min-w-0 gap-1">
              <dt className="shrink-0 text-fg-faint">{field.label}</dt>
              <dd className="truncate text-fg-secondary" title={field.value}>
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </>
  );
  const frame = `block h-full w-full rounded-md border border-edge bg-surface-raised text-left ${compact ? 'px-3 py-2' : 'px-3.5 py-2.5'}`;

  if (!openable) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      onClick={() => onOpenUrl!(url!, item.title)}
      className={`${frame} transition-colors hover:border-primary-300 hover:bg-surface-sunken focus:outline-none focus:ring-2 focus:ring-primary-500/40`}
    >
      {body}
    </button>
  );
}

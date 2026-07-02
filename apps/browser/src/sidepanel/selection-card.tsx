/**
 * Selection context card — shows what page context will ride along with the
 * next message: the user's selection (preferred), or just URL + title.
 * Refreshes on tab switches/navigation and right before send (see chat-view).
 */

import React, { useState } from 'react';
import { MessageSquareQuote, ChevronDown, ChevronRight } from '@greenhouse/ui/lib/icons';
import { Toggle } from '@greenhouse/ui/components/ui';
import { useT } from '@greenhouse/ui/lib/i18n';
import { requestSiteAccess, type PageContext } from '../lib/page-context';

interface SelectionCardProps {
  ctx: PageContext | null;
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  onRefresh: () => void;
}

export function SelectionCard({ ctx, enabled, onEnabledChange, onRefresh }: SelectionCardProps) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (!ctx || ctx.tabId === null) return null;

  const host = (() => {
    try {
      return ctx.url ? new URL(ctx.url).host : null;
    } catch {
      return null;
    }
  })();

  const grantAccess = async (allSites: boolean) => {
    const ok = await requestSiteAccess(allSites ? undefined : ctx.url);
    if (ok) onRefresh();
  };

  return (
    <div className="mx-3 mt-2 rounded-lg border border-edge bg-surface-sunken px-3 py-2 text-xs">
      <div className="flex items-center gap-2">
        <MessageSquareQuote
          size={14}
          className={ctx.selection ? 'text-primary-600 shrink-0' : 'text-fg-faint shrink-0'}
        />
        <span className="min-w-0 flex-1 truncate font-medium text-fg-secondary">
          {ctx.title || host || t('panel.currentPage')}
        </span>
        {ctx.selection && (
          <span className="shrink-0 rounded-full bg-primary-100 px-2 py-0.5 text-[11px] text-primary-700 dark:bg-primary-900 dark:text-primary-200">
            {t('panel.selectedChars', { count: ctx.selection.length })}
          </span>
        )}
        <Toggle size="sm" checked={enabled} onChange={onEnabledChange} />
      </div>

      {enabled && !ctx.permitted && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-fg-muted">
          <span>{t('panel.needsAccess')}</span>
          <button className="text-primary-600 hover:underline" onClick={() => grantAccess(false)}>
            {t('panel.allowSite')}
          </button>
          <button className="text-fg-faint hover:underline" onClick={() => grantAccess(true)}>
            {t('panel.allowAllSites')}
          </button>
        </div>
      )}

      {enabled && ctx.permitted && !ctx.selection && <p className="mt-1 text-fg-faint">{t('panel.noSelectionHint')}</p>}

      {enabled && ctx.selection && (
        <div className="mt-1.5">
          <button
            className="flex items-center gap-1 text-fg-muted hover:text-fg-secondary"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('panel.selectionPreview')}
          </button>
          {expanded && (
            <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap text-fg-muted">{ctx.selection}</p>
          )}
          {!expanded && <p className="mt-1 line-clamp-2 text-fg-muted">{ctx.selection}</p>}
        </div>
      )}
    </div>
  );
}

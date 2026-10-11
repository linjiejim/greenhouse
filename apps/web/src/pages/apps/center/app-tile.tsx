/**
 * One app on a shelf of the app center: the whole tile opens it; managers get
 * the builder link; everyone may pin it to the sidebar (server-side pins, D9).
 */

import { useState } from 'react';
import type { AppSummary } from '@greenhouse/types/apps';
import { AppBadge } from '../../../components/apps';
import { IconButton, Tag, toast } from '../../../components/ui';
import { appBuilderHref, appHref } from '../../../lib/app-routes';
import { useT } from '../../../lib/i18n';
import { Pencil, Pin, PinOff } from '../../../lib/icons';
import { formatDay } from '../../../lib/utils';
import { useAppsStore } from '../../../stores/apps-store';

export function AppTile({ app, pinned }: { app: AppSummary; pinned: boolean }) {
  const t = useT();
  const setPinned = useAppsStore((state) => state.setPinned);
  const [busy, setBusy] = useState(false);

  const togglePin = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await setPinned(app.id, !pinned);
    } catch {
      toast(t('apps.center.pinFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="group relative flex flex-col rounded-xl border border-edge bg-surface-card p-4 shadow-sm transition hover:border-primary-300 hover:shadow-md"
      data-testid={`app-card-${app.id}`}
    >
      {/* The whole card opens the app; the buttons sit above this link. */}
      <a
        href={appHref(app.id)}
        className="absolute inset-0 z-0 rounded-xl"
        aria-label={t('apps.center.open', { name: app.name })}
      />
      <div className="pointer-events-none relative flex items-start justify-between gap-3">
        <AppBadge icon={app.icon} accent={app.accent} />
        <div className="pointer-events-auto flex items-center">
          {app.canManage && (
            <a
              href={appBuilderHref(app.id)}
              className="relative z-10 inline-flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg sm:h-8 sm:w-8"
              aria-label={t('apps.center.edit', { name: app.name })}
              title={t('apps.center.edit', { name: app.name })}
            >
              <Pencil size={14} />
            </a>
          )}
          <IconButton
            label={pinned ? t('apps.center.unpin', { name: app.name }) : t('apps.center.pin', { name: app.name })}
            tooltipMode="portal"
            onClick={() => void togglePin()}
            disabled={busy}
            wrapperClassName="relative z-10"
            className="sm:h-8 sm:w-8"
          >
            {pinned ? <PinOff size={14} /> : <Pin size={14} />}
          </IconButton>
        </div>
      </div>
      <h3 className="pointer-events-none relative mt-3 truncate text-sm font-semibold text-fg" title={app.name}>
        {app.name}
      </h3>
      <p className="pointer-events-none relative mt-1 line-clamp-2 min-h-8 text-xs leading-4 text-fg-muted">
        {app.description || t('apps.center.noDescription')}
      </p>
      <div className="pointer-events-none relative mt-3 flex items-center justify-between gap-2 border-t border-edge pt-2.5 text-[11px] text-fg-faint">
        <span className="flex min-w-0 items-center gap-1.5">
          <Tag tone={app.status === 'published' ? 'primary' : 'neutral'}>{t(`apps.status.${app.status}`)}</Tag>
          <span className="truncate">
            {app.publishedVersion !== null
              ? t('apps.center.version', { version: app.publishedVersion })
              : t('apps.center.notPublished')}
          </span>
        </span>
        <span className="flex-shrink-0">{formatDay(app.updatedAt)}</span>
      </div>
    </div>
  );
}

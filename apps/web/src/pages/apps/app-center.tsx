/**
 * The app center (`#/apps`, spec 20261011-tables-apps §6): the member's three
 * shelves — managed by me, shared with me, featured — from `GET /api/apps`,
 * with server-side pins (D9). Creating an app (new / ask a Bot / from a
 * template) is listed but disabled with its reason until the builder and the
 * Agent slices ship; nothing here is sample data.
 */

import { useEffect, useId, useState } from 'react';
import type { AppSummary } from '@greenhouse/types/apps';
import { ModulePage } from '../../components/app/module-page';
import { AppBadge } from '../../components/apps';
import { Button, EmptyState, IconButton, Spinner, Tag, toast } from '../../components/ui';
import { appBuilderHref, appHref } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { Bot, LayoutGrid, LayoutTemplate, Pencil, Pin, PinOff, Plus } from '../../lib/icons';
import { formatDay } from '../../lib/utils';
import { useAppsStore } from '../../stores/apps-store';

const SHELVES = ['managed', 'shared', 'featured'] as const;

function AppCard({ app, pinned }: { app: AppSummary; pinned: boolean }) {
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

function EntryPoints() {
  const t = useT();
  const reasonId = useId();
  // Each entry is real once its slice lands (builder: new app; Agent: Bot-built apps and templates).
  const entries = [
    { key: 'new', icon: Plus, label: t('apps.center.newApp') },
    { key: 'bot', icon: Bot, label: t('apps.center.askBot') },
    { key: 'template', icon: LayoutTemplate, label: t('apps.center.fromTemplate') },
  ] as const;
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center" data-testid="app-center-entries">
      {entries.map(({ key, icon: Icon, label }) => (
        <Button
          key={key}
          variant={key === 'new' ? 'default' : 'outline'}
          size="sm"
          disabled
          aria-describedby={reasonId}
          className="gap-1.5"
        >
          <Icon size={14} />
          {label}
        </Button>
      ))}
      <p id={reasonId} className="text-xs text-fg-faint">
        {t('apps.center.entryUnavailable')}
      </p>
    </div>
  );
}

export function AppCenterPage() {
  const t = useT();
  const catalog = useAppsStore((state) => state.catalog);
  const pinnedIds = useAppsStore((state) => state.pinnedIds);
  const status = useAppsStore((state) => state.status);
  const load = useAppsStore((state) => state.load);

  // Opening the center always asks again: shelves change as people share and publish.
  useEffect(() => {
    void load(true);
  }, [load]);

  const pinned = new Set(pinnedIds);
  const shelves = SHELVES.map((key) => ({ key, apps: catalog?.[key] ?? [] })).filter((shelf) => shelf.apps.length > 0);

  return (
    <ModulePage
      moduleId="workspace.apps"
      layout="list"
      toolbar={<EntryPoints />}
      notice={
        status === 'error' ? (
          <div className="flex items-center justify-between gap-3 rounded-md border border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
            <span>{t('apps.center.loadFailed')}</span>
            <Button variant="ghost" size="sm" onClick={() => void load(true)}>
              {t('common.retry')}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!catalog && status !== 'error' ? (
        <div className="flex justify-center py-20">
          <Spinner className="h-6 w-6 text-fg-faint" />
        </div>
      ) : shelves.length === 0 ? (
        catalog && (
          <EmptyState
            icon={LayoutGrid}
            title={t('apps.center.emptyTitle')}
            description={t('apps.center.emptyDescription')}
          />
        )
      ) : (
        <div className="space-y-8">
          {shelves.map((shelf) => (
            <section key={shelf.key} aria-labelledby={`app-shelf-${shelf.key}`} data-testid={`app-shelf-${shelf.key}`}>
              <div className="mb-3">
                <h2 id={`app-shelf-${shelf.key}`} className="text-sm font-semibold text-fg">
                  {t(`apps.center.shelf.${shelf.key}`)}
                </h2>
                <p className="text-xs text-fg-faint">{t(`apps.center.shelf.${shelf.key}Hint`)}</p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shelf.apps.map((app) => (
                  <AppCard key={app.id} app={app} pinned={pinned.has(app.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </ModulePage>
  );
}

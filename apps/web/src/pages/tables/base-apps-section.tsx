/**
 * A Base's Apps section (spec 20261011-tables-apps §6 Base 页「应用」分区): the
 * apps built on this Base that the member can open or manage — from the same
 * shelves as the app center (`useAppsStore`), filtered to this Base — and, for
 * its owners and builders, "New app", which creates a draft and opens the
 * builder. Shown only to members with the `apps` feature.
 */

import { useEffect, useState } from 'react';
import type { AppSummary } from '@greenhouse/types/apps';
import { AppBadge } from '../../components/apps';
import { Button, Dialog, EmptyState, Spinner, Tag } from '../../components/ui';
import { appBuilderHref, appHref } from '../../lib/app-routes';
import { canUseFeature } from '../../lib/features';
import { useT } from '../../lib/i18n';
import { LayoutGrid, Pencil, Plus } from '../../lib/icons';
import { useAuthStore } from '../../stores';
import { catalogApps, useAppsStore } from '../../stores/apps-store';
import { CreateAppDialog } from '../apps/builder/create-app-dialog';

/** The apps of one Base, active first, each once. */
export function appsOfBase(apps: readonly AppSummary[], baseId: number): AppSummary[] {
  return apps
    .filter((app) => app.baseId === baseId && app.status !== 'archived')
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function BaseAppsSection({
  baseId,
  baseName,
  canBuild,
}: {
  baseId: number;
  baseName: string;
  canBuild: boolean;
}) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const catalog = useAppsStore((state) => state.catalog);
  const status = useAppsStore((state) => state.status);
  const load = useAppsStore((state) => state.load);
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const enabled = canUseFeature(currentUser, 'apps');

  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);

  if (!enabled) return null;
  const apps = appsOfBase(catalogApps(catalog), baseId);

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)} data-testid="base-apps-button">
        <LayoutGrid size={13} className="sm:mr-1.5" />
        <span className="sr-only sm:not-sr-only">{t('apps.builder.baseSection.button')}</span>
        {apps.length > 0 && <span className="ml-1 text-fg-faint">{apps.length}</span>}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('apps.builder.baseSection.title', { base: baseName })}
        size="lg"
      >
        <div className="space-y-4" data-testid="base-apps">
          <p className="text-xs leading-5 text-fg-muted">{t('apps.builder.baseSection.intro')}</p>
          {canBuild && (
            <Button size="sm" onClick={() => setCreating(true)} data-testid="base-apps-new">
              <Plus size={13} className="mr-1.5" />
              {t('apps.builder.baseSection.new')}
            </Button>
          )}
          {!catalog && status !== 'error' ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5 text-fg-faint" />
            </div>
          ) : status === 'error' && !catalog ? (
            <p className="text-sm text-danger">{t('apps.builder.baseSection.loadFailed')}</p>
          ) : apps.length === 0 ? (
            <EmptyState
              variant="compact"
              icon={LayoutGrid}
              title={t('apps.builder.baseSection.empty')}
              description={canBuild ? t('apps.builder.baseSection.emptyBuilder') : undefined}
            />
          ) : (
            <ul className="divide-y divide-edge rounded-lg border border-edge">
              {apps.map((app) => (
                <li
                  key={app.id}
                  className="flex flex-wrap items-center gap-3 px-3 py-2"
                  data-testid={`base-app-${app.id}`}
                >
                  <AppBadge icon={app.icon} accent={app.accent} size="sm" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg" title={app.name}>
                      {app.name}
                    </p>
                    <p className="flex items-center gap-1.5 text-[11px] text-fg-faint">
                      <Tag tone={app.status === 'published' ? 'primary' : 'neutral'}>
                        {t(`apps.status.${app.status}`)}
                      </Tag>
                      {app.publishedVersion !== null &&
                        t('apps.builder.status.live', { version: app.publishedVersion })}
                    </p>
                  </div>
                  {app.publishedVersion !== null && (
                    <a
                      href={appHref(app.id)}
                      className="inline-flex min-h-11 items-center rounded-lg px-3 text-xs font-semibold text-primary-fg hover:bg-surface-muted md:min-h-8"
                    >
                      {t('apps.builder.baseSection.open')}
                    </a>
                  )}
                  {app.canManage && (
                    <a
                      href={appBuilderHref(app.id)}
                      className="inline-flex min-h-11 items-center gap-1 rounded-lg px-3 text-xs font-semibold text-fg-secondary hover:bg-surface-muted md:min-h-8"
                    >
                      <Pencil size={12} />
                      {t('apps.builder.baseSection.edit')}
                    </a>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Dialog>
      <CreateAppDialog
        open={creating}
        onClose={() => setCreating(false)}
        baseId={baseId}
        onCreated={(view) => {
          setCreating(false);
          setOpen(false);
          void load(true);
          window.location.hash = appBuilderHref(view.app.id);
        }}
      />
    </>
  );
}

/**
 * An app as its viewer uses it (`#/apps/<id>[/<pageId>]`) — the shell only:
 * the app's identity and role from `GET /api/apps/:id`, its pages as tabs, and
 * an honest empty page body until the card renderer (slice R) lands. It also
 * names the app, page and role for the Assistant (`app-page` context).
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppPage, AppRuntimeView } from '@greenhouse/types/apps';
import { useAgentContext } from '../../components/agent-context';
import { AppBadge } from '../../components/apps';
import { Button, EmptyState, Spinner, Tag } from '../../components/ui';
import { getApp } from '../../lib/api/apps';
import { TablesRequestError } from '../../lib/api/tables';
import { APP_CENTER_HREF, appBuilderHref, appHref } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { ArrowLeft, LayoutGrid, Lock, appIcon } from '../../lib/icons';
import { catalogApps, useAppsStore } from '../../stores/apps-store';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: AppRuntimeView }
  | { kind: 'missing' }
  | { kind: 'failed' };

/** The page a viewer lands on: the route's, else the spec's home, else the first page the role sees. */
export function currentAppPage(view: AppRuntimeView, pageId: string | undefined): AppPage | null {
  const pages = view.spec.pages;
  if (pageId) return pages.find((page) => page.id === pageId) ?? null;
  return pages.find((page) => page.id === view.spec.home) ?? pages[0] ?? null;
}

function BackToCenter() {
  const t = useT();
  return (
    <a
      href={APP_CENTER_HREF}
      className="inline-flex min-h-11 items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-fg md:min-h-0"
    >
      <ArrowLeft size={12} />
      {t('apps.runtime.backToCenter')}
    </a>
  );
}

export function AppRuntimePage({ appId, pageId }: { appId: number; pageId?: string }) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const summary = useAppsStore((store) => catalogApps(store.catalog).find((app) => app.id === appId));
  const loadCatalog = useAppsStore((store) => store.load);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      setState({ kind: 'ready', view: await getApp(appId) });
    } catch (error) {
      if (error instanceof TablesRequestError && (error.status === 404 || error.status === 403)) {
        setState({ kind: 'missing' });
      } else {
        setState({ kind: 'failed' });
      }
    }
  }, [appId]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  // A manager's never-published draft has nothing to open; everyone else asks the gateway.
  const unpublished = summary?.publishedVersion === null;
  useEffect(() => {
    if (!unpublished) void load();
  }, [load, unpublished]);

  const view = state.kind === 'ready' ? state.view : null;
  const page = view ? currentAppPage(view, pageId) : null;
  useEffect(() => {
    const name = view?.app.name ?? summary?.name;
    if (!name) return;
    enrichPageContext({
      appName: name,
      ...(view
        ? {
            version: view.version,
            roleName: view.role.key === '__manager__' ? t('apps.runtime.managerView') : view.role.name,
            ...(page ? { pageId: page.id, pageTitle: page.title } : {}),
          }
        : {}),
    });
    return () => enrichPageContext(null);
  }, [enrichPageContext, page, summary?.name, t, view]);

  if (unpublished && summary) {
    return (
      <div className="h-full overflow-y-auto px-3 py-3 sm:px-6">
        <BackToCenter />
        <EmptyState
          icon={appIcon(summary.icon)}
          variant="page"
          title={t('apps.runtime.notPublishedTitle')}
          description={t('apps.runtime.notPublishedDescription')}
          action={
            summary.canManage ? (
              <Button size="sm" onClick={() => (window.location.hash = appBuilderHref(appId))}>
                {t('apps.center.edit', { name: summary.name })}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  if (state.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  }
  if (state.kind === 'missing' || state.kind === 'failed') {
    return (
      <div className="h-full overflow-y-auto px-3 py-3 sm:px-6">
        <BackToCenter />
        <EmptyState
          icon={state.kind === 'missing' ? Lock : LayoutGrid}
          variant="page"
          tone={state.kind === 'missing' ? 'neutral' : 'danger'}
          title={state.kind === 'missing' ? t('apps.runtime.notFoundTitle') : t('apps.runtime.loadFailed')}
          description={state.kind === 'missing' ? t('apps.runtime.notFoundDescription') : undefined}
          action={
            state.kind === 'failed' ? (
              <Button variant="outline" size="sm" onClick={() => void load()}>
                {t('common.retry')}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const { app, role, version, spec } = state.view;
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-canvas" data-testid="app-runtime">
      <header className="flex-shrink-0 border-b border-edge bg-surface-raised px-3 pt-3 sm:px-6">
        <div className="flex items-start gap-3">
          <AppBadge icon={app.icon} accent={app.accent} size="md" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-semibold text-fg md:text-lg" title={app.name}>
              {app.name}
            </h1>
            {app.description && (
              <p className="truncate text-xs text-fg-muted" title={app.description}>
                {app.description}
              </p>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1.5">
            <Tag tone="neutral">{role.key === '__manager__' ? t('apps.runtime.managerView') : role.name}</Tag>
            <Tag tone="primary">{t('apps.center.version', { version })}</Tag>
          </div>
        </div>
        <nav aria-label={t('apps.runtime.pagesTitle')} className="-mb-px mt-2 flex gap-1 overflow-x-auto">
          {spec.pages.map((entry) => {
            const active = entry.id === page?.id;
            const Icon = appIcon(entry.icon);
            return (
              <a
                key={entry.id}
                href={appHref(app.id, entry.id)}
                aria-current={active ? 'page' : undefined}
                className={`inline-flex min-h-11 flex-shrink-0 items-center gap-1.5 border-b-2 px-2.5 text-xs font-medium transition-colors md:min-h-9 ${
                  active ? 'border-primary-500 text-fg' : 'border-transparent text-fg-muted hover:text-fg'
                }`}
              >
                <Icon size={13} aria-hidden="true" />
                {entry.title}
              </a>
            );
          })}
        </nav>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6">
        {page ? (
          <EmptyState
            icon={appIcon(page.icon)}
            tone="neutral"
            title={t('apps.runtime.pagesUnavailableTitle')}
            description={t('apps.runtime.pagesUnavailableDescription')}
          />
        ) : (
          <EmptyState icon={LayoutGrid} tone="neutral" title={t('apps.runtime.pageMissing')} />
        )}
      </div>
    </div>
  );
}

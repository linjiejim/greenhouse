/**
 * An app as its viewer uses it (`#/apps/<id>[/<pageId>]`, spec §6): the app
 * as `GET /api/apps/:id` gives it to this person — the published version
 * trimmed to their role, or, for a manager, in full (`?previewRole=<key>`
 * shows one role's trim). The shell draws the header, the pages (tabs or a
 * side list, `nav.layout`), the managers' preview and issues bars, and the
 * current page (`AppPageView`). `?record=<id>` opens that record (the link a
 * notification carries). The Assistant is told which app, page, role and
 * filters are on screen (`app-page` context).
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppPage, AppRuntimeView } from '@greenhouse/types/apps';
import { useAgentContext } from '../../../components/agent-context';
import { AppBadge } from '../../../components/apps';
import { Button, EmptyState, Spinner, Tag } from '../../../components/ui';
import { getApp } from '../../../lib/api/apps';
import { TablesRequestError } from '../../../lib/api/tables';
import { APP_CENTER_HREF, appBuilderHref, appPreviewHref } from '../../../lib/app-routes';
import { useT } from '../../../lib/i18n';
import { ArrowLeft, LayoutGrid, Lock, Pencil, appIcon } from '../../../lib/icons';
import { catalogApps, useAppsStore } from '../../../stores/apps-store';
import { AppPageView } from './app-page-view';
import { AppPageSidebar, AppPageTabs } from './page-nav';
import { IssuesBar, PreviewBar } from './runtime-banners';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; view: AppRuntimeView }
  | { kind: 'missing' }
  | { kind: 'failed' };

const MANAGER_ROLE = '__manager__';

/** The page a viewer lands on: the route's, else the spec's home, else the first page the role sees. */
export function currentAppPage(view: AppRuntimeView, pageId: string | undefined): AppPage | null {
  const pages = view.spec.pages;
  if (pageId) return pages.find((page) => page.id === pageId) ?? null;
  return pages.find((page) => page.id === view.spec.home) ?? pages[0] ?? null;
}

/** `?record=<id>[&card=<cardId>]` — a link to one record (notifications). */
export function recordLink(params: URLSearchParams | undefined): { recordId: number; cardId?: string } | undefined {
  const recordId = Number(params?.get('record'));
  if (!Number.isInteger(recordId) || recordId <= 0) return undefined;
  const cardId = params?.get('card') || undefined;
  return cardId ? { recordId, cardId } : { recordId };
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

export function AppRuntimePage({
  appId,
  pageId,
  params,
}: {
  appId: number;
  pageId?: string;
  params?: URLSearchParams;
}) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const previewRole = params?.get('previewRole') || undefined;
  const deepLink = recordLink(params);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  /** Every role of the app — what a manager may preview as (the previewed view lists only its own). */
  const [roles, setRoles] = useState<Array<{ key: string; name: string }>>([]);
  const [filters, setFilters] = useState<Array<{ label: string; value: string }>>([]);
  const summary = useAppsStore((store) => catalogApps(store.catalog).find((app) => app.id === appId));
  const loadCatalog = useAppsStore((store) => store.load);

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const view = await getApp(appId, previewRole ? { previewRole } : {});
      setState({ kind: 'ready', view });
      if (view.role.key === MANAGER_ROLE) setRoles(view.spec.roles.map((role) => ({ key: role.key, name: role.name })));
    } catch (error) {
      if (error instanceof TablesRequestError && (error.status === 404 || error.status === 403)) {
        setState({ kind: 'missing' });
      } else {
        setState({ kind: 'failed' });
      }
    }
  }, [appId, previewRole]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);
  // A manager's never-published draft has nothing to open; everyone else asks the gateway.
  const unpublished = summary?.publishedVersion === null;
  useEffect(() => {
    if (!unpublished) void load();
  }, [load, unpublished]);
  // Opened straight into a preview: learn the roles to switch between from the full view.
  const previewing = Boolean(previewRole) && state.kind === 'ready' && state.view.app.canManage;
  useEffect(() => {
    if (!previewing || roles.length > 0) return;
    void getApp(appId)
      .then((full) => setRoles(full.spec.roles.map((role) => ({ key: role.key, name: role.name }))))
      .catch(() => undefined);
  }, [appId, previewing, roles.length]);

  const view = state.kind === 'ready' ? state.view : null;
  const page = view ? currentAppPage(view, pageId) : null;
  const managerView = view?.role.key === MANAGER_ROLE;
  const roleName = view ? (managerView ? t('apps.runtime.managerView') : view.role.name) : undefined;

  useEffect(() => {
    const name = view?.app.name ?? summary?.name;
    if (!name) return;
    enrichPageContext({
      appName: name,
      ...(view
        ? {
            version: view.version,
            roleName,
            ...(page ? { pageId: page.id, pageTitle: page.title } : {}),
            ...(filters.length > 0 ? { filters } : {}),
          }
        : {}),
    });
    return () => enrichPageContext(null);
  }, [enrichPageContext, filters, page, roleName, summary?.name, view]);

  const hrefFor = useCallback((target: string) => appPreviewHref(appId, previewRole, target), [appId, previewRole]);
  const openPage = useCallback((target: string) => (window.location.hash = hrefFor(target)), [hrefFor]);
  const clearDeepLink = useCallback(() => {
    // The drawer is open now; the address loses `record` so the same link opens it again later.
    window.location.replace(appPreviewHref(appId, previewRole, pageId));
  }, [appId, pageId, previewRole]);

  // Never published: the shelves say so, or the gateway answered a manager with the draft (the
  // runtime shows published versions; the builder shows drafts).
  const draftApp = unpublished ? summary : view?.draft ? view.app : undefined;
  if (draftApp) {
    return (
      <div className="h-full overflow-y-auto px-3 py-3 sm:px-6">
        <BackToCenter />
        <EmptyState
          icon={appIcon(draftApp.icon)}
          variant="page"
          title={t('apps.runtime.notPublishedTitle')}
          description={t('apps.runtime.notPublishedDescription')}
          action={
            draftApp.canManage ? (
              <Button size="sm" onClick={() => (window.location.hash = appBuilderHref(appId))}>
                {t('apps.center.edit', { name: draftApp.name })}
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

  const { app, version, spec } = state.view;
  const sidebarLayout = spec.nav?.layout === 'sidebar';
  const navProps = { pages: spec.pages, currentPageId: page?.id, hrefFor };
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-canvas" data-testid="app-runtime">
      <header className="flex-shrink-0 border-b border-edge bg-surface-raised px-3 pt-3 sm:px-6">
        <div className="flex items-start gap-3 pb-2">
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
          <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-1.5">
            <Tag tone="neutral">{roleName}</Tag>
            <Tag tone="primary">{t('apps.center.version', { version })}</Tag>
            {app.canManage && (
              <a
                href={appBuilderHref(app.id)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg md:h-8 md:w-8"
                aria-label={t('apps.runtime.openBuilder')}
                title={t('apps.runtime.openBuilder')}
              >
                <Pencil size={14} />
              </a>
            )}
          </div>
        </div>
        <AppPageTabs {...navProps} className={sidebarLayout ? 'md:hidden' : ''} />
      </header>
      <div className="flex min-h-0 flex-1">
        {sidebarLayout && <AppPageSidebar {...navProps} />}
        <main className="min-h-0 min-w-0 flex-1 space-y-3 overflow-y-auto px-3 py-3 sm:px-6 sm:py-4">
          {app.canManage && (
            <PreviewBar
              roles={roles}
              previewRole={previewRole}
              previewName={managerView ? undefined : state.view.role.name}
              // Another role may not have this page: land on its home.
              onChange={(roleKey) => (window.location.hash = appPreviewHref(app.id, roleKey))}
            />
          )}
          {app.canManage && (
            <IssuesBar
              issues={state.view.issues}
              pages={spec.pages}
              version={version}
              builderHref={appBuilderHref(app.id)}
            />
          )}
          {page ? (
            <AppPageView
              key={`${page.id}:${previewRole ?? ''}`}
              view={state.view}
              page={page}
              previewRole={previewRole}
              deepLink={deepLink}
              onDeepLinkHandled={clearDeepLink}
              onOpenPage={openPage}
              onFiltersChange={setFilters}
            />
          ) : spec.pages.length === 0 ? (
            <EmptyState
              icon={Lock}
              tone="neutral"
              title={t('apps.runtime.noPagesTitle')}
              description={t('apps.runtime.noPagesDescription')}
            />
          ) : (
            <EmptyState icon={LayoutGrid} tone="neutral" title={t('apps.runtime.pageMissing')} />
          )}
        </main>
      </div>
    </div>
  );
}

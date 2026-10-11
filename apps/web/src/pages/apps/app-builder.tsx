/**
 * The builder (`#/apps/<id>/edit`) — a placeholder until slice B: it names the
 * app (from the member's shelves) for the page and the Assistant (`app-page`
 * context in `build` mode) and says plainly that editing is not available.
 * The gateway, not this page, decides who may edit a draft.
 */

import { useEffect } from 'react';
import { useAgentContext } from '../../components/agent-context';
import { AppBadge } from '../../components/apps';
import { Button, EmptyState } from '../../components/ui';
import { APP_CENTER_HREF, appHref } from '../../lib/app-routes';
import { useT } from '../../lib/i18n';
import { ArrowLeft, Wrench } from '../../lib/icons';
import { catalogApps, useAppsStore } from '../../stores/apps-store';

export function AppBuilderPage({ appId }: { appId: number }) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const summary = useAppsStore((store) => catalogApps(store.catalog).find((app) => app.id === appId));
  const load = useAppsStore((store) => store.load);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!summary) return;
    enrichPageContext({ appName: summary.name });
    return () => enrichPageContext(null);
  }, [enrichPageContext, summary]);

  const name = summary?.name ?? t('apps.agent.context.unnamedApp', { id: appId });
  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-canvas" data-testid="app-builder">
      <header className="flex flex-shrink-0 items-center gap-3 border-b border-edge bg-surface-raised px-3 py-3 sm:px-6">
        <a
          href={APP_CENTER_HREF}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg md:h-8 md:w-8"
          aria-label={t('apps.runtime.backToCenter')}
          title={t('apps.runtime.backToCenter')}
        >
          <ArrowLeft size={14} />
        </a>
        {summary && <AppBadge icon={summary.icon} accent={summary.accent} size="sm" />}
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold text-fg" title={name}>
          {t('apps.builder.title', { name })}
        </h1>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-6">
        <EmptyState
          icon={Wrench}
          variant="page"
          tone="neutral"
          title={t('apps.builder.unavailableTitle')}
          description={t('apps.builder.unavailableDescription')}
          action={
            summary && summary.publishedVersion !== null ? (
              <Button variant="outline" size="sm" onClick={() => (window.location.hash = appHref(appId))}>
                {t('apps.builder.openApp')}
              </Button>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

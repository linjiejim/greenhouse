import { CustomReviewsDialog } from './custom-reviews-dialog';
/**
 * The app center (`#/apps`, spec 20261011-tables-apps §6): the member's three
 * shelves — managed by me, shared with me, featured — from `GET /api/apps`,
 * with server-side pins (D9), and the ways to make an app:
 * - **New app** — on a Base the member builds, or a new Base (needs Tables) —
 *   the builder's `CreateAppDialog`, the one way to create an app by hand;
 * - **Ask a Bot** — Chat opens with a request naming the Base (needs Tables);
 * - **From a template** — a new Base + draft app (needs Tables), when the server lists templates.
 */

import { useEffect, useState } from 'react';
import type { AppTemplateSummary } from '@greenhouse/types/apps';
import { ModulePage } from '../../../components/app/module-page';
import { Button, EmptyState, Spinner } from '../../../components/ui';
import { listAppTemplates } from '../../../lib/api/apps';
import { appBuilderHref } from '../../../lib/app-routes';
import { canUseFeature } from '../../../lib/features';
import { useT } from '../../../lib/i18n';
import { Bot, LayoutGrid, LayoutTemplate, Plus } from '../../../lib/icons';
import { useAuthStore } from '../../../stores';
import { useAppsStore } from '../../../stores/apps-store';
import { AppTile } from './app-tile';
import { CreateAppDialog } from '../builder/create-app-dialog';
import { AskBotDialog } from './ask-bot-dialog';
import { TemplateDialog } from './template-dialog';

const SHELVES = ['managed', 'shared', 'featured'] as const;

type OpenDialog = 'new' | 'bot' | 'template' | null;

function EntryPoints({
  canBuild,
  templates,
  onOpen,
}: {
  canBuild: boolean;
  templates: readonly AppTemplateSummary[];
  onOpen: (dialog: Exclude<OpenDialog, null>) => void;
}) {
  const t = useT();
  if (!canBuild) return null;
  return (
    <div className="contents" data-testid="app-center-entries">
      {canBuild && (
        <Button
          size="sm"
          className="min-h-11 gap-1.5 md:min-h-0"
          onClick={() => onOpen('new')}
          data-testid="app-center-new"
        >
          <Plus size={14} />
          {t('apps.center.newApp')}
        </Button>
      )}
      {canBuild && (
        <Button variant="outline" size="sm" className="min-h-11 gap-1.5 md:min-h-0" onClick={() => onOpen('bot')}>
          <Bot size={14} />
          {t('apps.center.askBot.entry')}
        </Button>
      )}
      {canBuild && templates.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="min-h-11 gap-1.5 md:min-h-0"
          onClick={() => onOpen('template')}
          data-testid="app-center-templates"
        >
          <LayoutTemplate size={14} />
          {t('apps.center.fromTemplate')}
        </Button>
      )}
    </div>
  );
}

export function AppCenterPage() {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  // Building an app means building on a Base, which takes the Tables module.
  const canBuild = canUseFeature(currentUser, 'tables');
  const catalog = useAppsStore((state) => state.catalog);
  const pinnedIds = useAppsStore((state) => state.pinnedIds);
  const status = useAppsStore((state) => state.status);
  const load = useAppsStore((state) => state.load);
  const [templates, setTemplates] = useState<AppTemplateSummary[]>([]);
  const [reviews, setReviews] = useState(false);
  const [dialog, setDialog] = useState<OpenDialog>(null);

  // Opening the center always asks again: shelves change as people share and publish.
  useEffect(() => {
    void load(true);
  }, [load]);
  // Installing builds a Tables Base: only Tables members are offered templates. A failed list
  // keeps the entry hidden rather than showing a dead one.
  useEffect(() => {
    if (!canBuild) return;
    let alive = true;
    listAppTemplates()
      .then((list) => alive && setTemplates(list))
      .catch(() => alive && setTemplates([]));
    return () => {
      alive = false;
    };
  }, [canBuild]);

  const pinned = new Set(pinnedIds);
  const shelves = SHELVES.map((key) => ({ key, apps: catalog?.[key] ?? [] })).filter((shelf) => shelf.apps.length > 0);
  const close = () => setDialog(null);

  return (
    <ModulePage
      moduleId="workspace.apps"
      layout="list"
      className="[&>header]:flex-wrap [&>header>div:first-child]:min-w-40 [&_[data-module-page-slot=actions]]:max-w-full"
      actions={
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:w-auto sm:flex-wrap">
          <EntryPoints canBuild={canBuild} templates={templates} onOpen={setDialog} />
          {currentUser?.role === 'super' && (
            <Button variant="ghost" size="sm" onClick={() => setReviews(true)} data-testid="app-center-reviews">
              {t('apps.sandbox.reviews')}
            </Button>
          )}
        </div>
      }
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
            description={canBuild ? t('apps.center.emptyDescription') : t('apps.center.emptyViewerDescription')}
          />
        )
      ) : (
        <div className="space-y-8">
          {shelves.map((shelf) => (
            <section key={shelf.key} aria-labelledby={`app-shelf-${shelf.key}`} data-testid={`app-shelf-${shelf.key}`}>
              <div className="mb-3">
                <h2
                  id={`app-shelf-${shelf.key}`}
                  className="text-sm font-semibold text-fg"
                  title={t(`apps.center.shelf.${shelf.key}Hint`)}
                >
                  {t(`apps.center.shelf.${shelf.key}`)}
                </h2>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {shelf.apps.map((app) => (
                  <AppTile key={app.id} app={app} pinned={pinned.has(app.id)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {reviews && <CustomReviewsDialog onClose={() => setReviews(false)} />}
      {dialog === 'new' && (
        <CreateAppDialog
          open
          onClose={close}
          onCreated={(view) => {
            void load(true);
            close();
            window.location.hash = appBuilderHref(view.app.id);
          }}
        />
      )}
      {dialog === 'bot' && <AskBotDialog open onClose={close} />}
      {dialog === 'template' && <TemplateDialog open templates={templates} onClose={close} />}
    </ModulePage>
  );
}

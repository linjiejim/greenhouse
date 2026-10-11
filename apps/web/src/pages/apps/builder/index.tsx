/**
 * The app builder (`#/apps/<id>/edit`, spec 20261011-tables-apps §6 构建器):
 * the draft of one app, edited in four tabs —
 *
 * - **Pages**: the page list, the canvas (cards on the shared `WidgetGrid`,
 *   added from the card catalog) and the properties of a card or the page;
 * - **Roles**: what each role sees and may change (the Phase 0 rule editor);
 * - **Sharing**: who gets which role (the Base owner edits; others read);
 * - **Settings**: name and look, page navigation, usage, hand-over, archive.
 *
 * The draft autosaves (`useAppDraft`: debounced, CAS on `draftRevision`; a
 * 409 asks to reload). The server's validation problems show where they
 * belong and in one list. "Preview" opens the draft as a role; "Publish"
 * (Base owner / super, D2) shows what changes before it goes live;
 * "Versions" restores an old version into the draft (D5).
 *
 * Who may be here is the server's call: a draft the caller cannot manage
 * answers 404 / 403 and the page says so.
 */

import { useEffect, useMemo, useState } from 'react';
import type { AppSpecError } from '@greenhouse/types/apps';
import { useAgentContext } from '../../../components/agent-context';
import { AppBadge } from '../../../components/apps';
import { ContextMenu, useContextMenu } from '../../../components/app/context-menu';
import { Button, Dialog, EmptyState, Spinner, Tabs, Tag, toast } from '../../../components/ui';
import { APP_CENTER_HREF, appPreviewHref } from '../../../lib/app-routes';
import { useT } from '../../../lib/i18n';
import { AlertTriangle, ArrowLeft, Eye, History, Lock, RefreshCw, Send, Wrench } from '../../../lib/icons';
import { useAppsStore } from '../../../stores/apps-store';
import { AudiencesTab } from './audiences-tab';
import { PagesTab, type BuilderSelection } from './pages-tab';
import { PublishDialog } from './publish-dialog';
import { RolesTab } from './roles-tab';
import { SettingsTab } from './settings-tab';
import { appErrors } from './spec-errors';
import { useAppDraft, type DraftSaveState } from './use-app-draft';
import { useBuilderBase } from './use-builder-schema';
import { VersionsDrawer } from './versions-drawer';

type BuilderTab = 'pages' | 'roles' | 'audiences' | 'settings';

const SAVE_TONE: Record<DraftSaveState, 'neutral' | 'warning' | 'danger' | 'success'> = {
  saved: 'success',
  pending: 'neutral',
  saving: 'neutral',
  invalid: 'danger',
  conflict: 'danger',
  failed: 'danger',
};

function SaveStatus({ state, onRetry }: { state: DraftSaveState; onRetry: () => void }) {
  const t = useT();
  return (
    <span className="flex items-center gap-1.5" data-testid="app-save-state" data-state={state} aria-live="polite">
      <Tag tone={SAVE_TONE[state]}>{t(`apps.builder.save.${state}`)}</Tag>
      {state === 'failed' && (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          {t('apps.builder.save.retry')}
        </Button>
      )}
    </span>
  );
}

function ProblemsDialog({
  open,
  onClose,
  errors,
  invalid,
  describe,
  onShow,
}: {
  open: boolean;
  onClose: () => void;
  errors: readonly AppSpecError[];
  invalid: boolean;
  describe: (error: AppSpecError) => string;
  onShow: (error: AppSpecError) => void;
}) {
  const t = useT();
  return (
    <Dialog open={open} onClose={onClose} title={t('apps.builder.problems.title')} size="lg">
      <p className="mb-3 text-xs text-fg-muted">
        {invalid ? t('apps.builder.problems.invalidIntro') : t('apps.builder.problems.intro')}
      </p>
      <ul className="divide-y divide-edge rounded-lg border border-edge" data-testid="app-problems">
        {errors.map((error, index) => (
          <li key={`${error.path}-${index}`} className="flex flex-wrap items-start gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium text-fg-secondary">{describe(error)}</p>
              <p className="break-words text-xs text-danger">{error.message}</p>
            </div>
            {(error.pageId || error.roleKey) && (
              <Button variant="ghost" size="sm" onClick={() => onShow(error)}>
                {t('apps.builder.problems.show')}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

export function AppBuilderPage({ appId }: { appId: number }) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const reloadCatalog = useAppsStore((store) => store.load);
  const draft = useAppDraft(appId);
  const ready = draft.load.kind === 'ready' ? draft.load : null;
  const app = ready?.app;
  const spec = ready?.spec;
  const base = useBuilderBase(app?.baseId, app?.canPublish ?? false);
  const [tab, setTab] = useState<BuilderTab>('pages');
  const [selection, setSelection] = useState<BuilderSelection | null>(null);
  const [publishing, setPublishing] = useState(false);
  const [versions, setVersions] = useState(false);
  const [problems, setProblems] = useState(false);
  const [focusRole, setFocusRole] = useState<string | undefined>(undefined);
  const { menu, openMenu, closeMenu } = useContextMenu();

  // The selection follows the spec: a deleted page or card falls back to the first page.
  const current: BuilderSelection | null = useMemo(() => {
    if (!spec || spec.pages.length === 0) return null;
    const page = spec.pages.find((entry) => entry.id === selection?.pageId) ?? spec.pages[0]!;
    const cardId =
      selection?.pageId === page.id && page.cards.some((card) => card.id === selection.cardId)
        ? selection.cardId
        : null;
    return { pageId: page.id, cardId };
  }, [selection, spec]);

  // The Assistant sees the builder of this app and the draft's pages (by id and title).
  const name = app?.name;
  const pagesKey = JSON.stringify(spec?.pages.map((page) => ({ id: page.id, title: page.title })) ?? []);
  useEffect(() => {
    if (!name) return;
    const pages = JSON.parse(pagesKey) as Array<{ id: string; title: string }>;
    enrichPageContext({ mode: 'build', appName: name, ...(pages.length > 0 ? { pages } : {}) });
    return () => enrichPageContext(null);
  }, [enrichPageContext, name, pagesKey]);

  if (draft.load.kind === 'loading') {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  }
  if (draft.load.kind === 'missing' || draft.load.kind === 'failed') {
    const missing = draft.load.kind === 'missing';
    return (
      <div className="h-full overflow-y-auto px-3 py-3 sm:px-6">
        <a
          href={APP_CENTER_HREF}
          className="inline-flex min-h-11 items-center gap-1.5 text-xs text-fg-muted hover:text-fg md:min-h-0"
        >
          <ArrowLeft size={12} />
          {t('apps.builder.back')}
        </a>
        <EmptyState
          icon={missing ? Lock : Wrench}
          variant="page"
          tone={missing ? 'neutral' : 'danger'}
          title={missing ? t('apps.builder.notFoundTitle') : t('apps.builder.loadFailed')}
          description={missing ? t('apps.builder.notFoundDescription') : undefined}
          action={
            missing ? undefined : (
              <Button variant="outline" size="sm" onClick={() => void draft.reload()}>
                {t('common.retry')}
              </Button>
            )
          }
        />
      </div>
    );
  }
  if (!app || !spec || !current) return null;

  const pageTitle = (pageId: string) => spec.pages.find((page) => page.id === pageId)?.title ?? pageId;
  const describe = (error: AppSpecError) => {
    if (error.cardId && error.pageId) {
      const card = spec.pages
        .find((page) => page.id === error.pageId)
        ?.cards.find((entry) => entry.id === error.cardId);
      const cardName = card?.title || (card ? t(`apps.builder.catalog.kinds.${card.kind}.name`) : error.cardId);
      return t('apps.builder.problems.card', { card: cardName, page: pageTitle(error.pageId) });
    }
    if (error.pageId) return t('apps.builder.problems.page', { page: pageTitle(error.pageId) });
    if (error.roleKey) {
      return t('apps.builder.problems.role', {
        role: spec.roles.find((role) => role.key === error.roleKey)?.name ?? error.roleKey,
      });
    }
    return t('apps.builder.problems.app');
  };
  const showProblem = (error: AppSpecError) => {
    setProblems(false);
    if (error.pageId) {
      setTab('pages');
      setSelection({ pageId: error.pageId, cardId: error.cardId ?? null });
    } else if (error.roleKey) {
      setFocusRole(error.roleKey);
      setTab('roles');
    }
  };

  const preview = async (roleKey: string) => {
    if (!(await draft.flush())) return toast(t('apps.builder.preview.saveFirst'), 'warning');
    // The runtime, on the draft, as that role (managers only; the gateway checks).
    window.location.hash = appPreviewHref(appId, { previewRole: roleKey, draft: true });
  };

  const tabs = [
    { key: 'pages', label: t('apps.builder.tabs.pages'), testId: 'app-tab-pages' },
    { key: 'roles', label: t('apps.builder.tabs.roles'), testId: 'app-tab-roles' },
    { key: 'audiences', label: t('apps.builder.tabs.audiences'), testId: 'app-tab-audiences' },
    { key: 'settings', label: t('apps.builder.tabs.settings'), testId: 'app-tab-settings' },
  ];
  const unpublishable = draft.errors.length > 0 || draft.saveState === 'invalid' || draft.saveState === 'conflict';

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-canvas" data-testid="app-builder">
      <header className="flex flex-shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-edge bg-surface-raised px-3 py-2.5 sm:px-6">
        <a
          href={APP_CENTER_HREF}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-muted hover:text-fg md:h-8 md:w-8"
          aria-label={t('apps.builder.back')}
          title={t('apps.builder.back')}
        >
          <ArrowLeft size={14} />
        </a>
        <AppBadge icon={app.icon} accent={app.accent} size="sm" />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold text-fg" title={app.name}>
            {t('apps.builder.title', { name: app.name })}
          </h1>
          <p className="flex flex-wrap items-center gap-1.5 text-[11px] text-fg-faint">
            <span data-testid="app-builder-status">
              {app.status === 'archived'
                ? t('apps.status.archived')
                : app.publishedVersion !== null
                  ? t('apps.builder.status.live', { version: app.publishedVersion })
                  : t('apps.builder.status.notPublished')}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SaveStatus state={draft.saveState} onRetry={() => void draft.flush()} />
          {draft.errors.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => setProblems(true)} data-testid="app-problems-button">
              <AlertTriangle size={13} className="mr-1.5 text-danger" />
              {t('apps.builder.problems.button', { count: draft.errors.length })}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={(event) =>
              openMenu(
                event,
                spec.roles.map((role) => ({
                  label: t('apps.builder.preview.as', { role: role.name }),
                  icon: Eye,
                  onClick: () => void preview(role.key),
                })),
              )
            }
            data-testid="app-preview"
          >
            <Eye size={13} className="mr-1.5" />
            {t('apps.builder.preview.button')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setVersions(true)} data-testid="app-versions-button">
            <History size={13} className="mr-1.5" />
            {t('apps.builder.versions.button')}
          </Button>
          <Button
            size="sm"
            disabled={!app.canPublish || app.status === 'archived'}
            title={
              !app.canPublish
                ? t('apps.builder.publish.ownerOnly')
                : unpublishable
                  ? t('apps.builder.publish.fixFirst')
                  : undefined
            }
            onClick={() => setPublishing(true)}
            data-testid="app-publish"
          >
            <Send size={13} className="mr-1.5" />
            {t('apps.builder.publish.button')}
          </Button>
        </div>
      </header>

      {draft.saveState === 'conflict' && (
        <div
          className="flex flex-shrink-0 flex-wrap items-center justify-between gap-2 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger"
          role="alert"
          data-testid="app-draft-conflict"
        >
          <span>
            <strong className="font-semibold">{t('apps.builder.conflict.title')}</strong>{' '}
            {t('apps.builder.conflict.description')}
          </span>
          <Button variant="outline" size="sm" onClick={() => void draft.reload()}>
            <RefreshCw size={12} className="mr-1.5" />
            {t('apps.builder.conflict.reload')}
          </Button>
        </div>
      )}
      {appErrors(draft.errors).length > 0 && (
        <div className="flex-shrink-0 border-b border-danger bg-danger-subtle px-4 py-2 text-xs text-danger">
          {appErrors(draft.errors)
            .map((error) => error.message)
            .join(' · ')}
        </div>
      )}

      <div className="flex-shrink-0 px-3 pt-3 sm:px-6">
        <Tabs
          tabs={tabs}
          active={tab}
          onChange={(key) => setTab(key as BuilderTab)}
          ariaLabel={t('apps.builder.tabs.label')}
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 py-3 sm:px-6 lg:overflow-hidden">
        {base.load.kind === 'loading' ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6 text-fg-faint" />
          </div>
        ) : base.load.kind === 'failed' ? (
          <EmptyState
            icon={Wrench}
            tone="danger"
            title={t('apps.builder.baseLoadFailed')}
            action={
              <Button variant="outline" size="sm" onClick={() => void base.reload()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : tab === 'pages' ? (
          <PagesTab
            spec={spec}
            base={base.load.base}
            errors={draft.errors}
            edit={draft.edit}
            selection={current}
            onSelect={setSelection}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto">
            {tab === 'roles' && (
              <RolesTab
                key={focusRole ?? ''}
                spec={spec}
                base={base.load.base}
                errors={draft.errors}
                edit={draft.edit}
                initialRole={focusRole}
              />
            )}
            {tab === 'audiences' && (
              <AudiencesTab
                appId={appId}
                spec={spec}
                canPublish={app.canPublish}
                published={app.publishedVersion !== null}
              />
            )}
            {tab === 'settings' && (
              <SettingsTab
                app={app}
                spec={spec}
                owners={base.load.base.appOwners}
                edit={draft.edit}
                onApp={draft.setApp}
              />
            )}
          </div>
        )}
      </div>

      {menu && <ContextMenu {...menu} onClose={closeMenu} />}
      <ProblemsDialog
        open={problems}
        onClose={() => setProblems(false)}
        errors={draft.errors}
        invalid={draft.saveState === 'invalid'}
        describe={describe}
        onShow={showProblem}
      />
      {base.load.kind === 'ready' && (
        <PublishDialog
          open={publishing}
          onClose={() => setPublishing(false)}
          app={app}
          spec={spec}
          errors={draft.errors}
          schema={base.load.base.schema}
          flush={draft.flush}
          revision={draft.revision}
          onPublished={(next, version) => {
            setPublishing(false);
            draft.setApp(next);
            void reloadCatalog(true);
            toast(t('apps.builder.publish.published', { version: version.version }), 'success');
          }}
          onConflict={() => {
            setPublishing(false);
            void draft.reload();
            toast(t('apps.builder.conflict.title'), 'warning');
          }}
        />
      )}
      <VersionsDrawer
        open={versions}
        onClose={() => setVersions(false)}
        app={app}
        flush={draft.flush}
        revision={draft.revision}
        onRestored={(view) => {
          draft.adopt(view);
          setVersions(false);
        }}
        onConflict={() => {
          setVersions(false);
          void draft.reload();
          toast(t('apps.builder.conflict.title'), 'warning');
        }}
      />
    </div>
  );
}

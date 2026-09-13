/**
 * Home workbench — the personal, permission-aware dashboard that fills the Chat
 * empty state.
 *
 * Cards store a saved query, never its answer, so this panel re-evaluates
 * everything on mount as the current user: revoking a tool greys the card
 * instead of leaking yesterday's rows. See docs/specs/20260805-home-workbench.md.
 *
 * It renders no composer and no page chrome — the conversation it sits in owns
 * both. Its edit control lives in the TopBar (registered through the
 * ui-store while this panel is mounted), because the empty state's vertical
 * space belongs to the cards.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  DEFAULT_TAB_ID,
  WORKBENCH_LIMITS,
  availableWorkbenchTemplates,
  findNextWidgetPosition,
  instantiateWorkbenchTemplate,
  isDataWidget,
  isNavWidget,
  type WorkbenchTemplate,
  type WorkbenchWidget,
} from '@greenhouse/types/workbench';
import { Button, ConfirmDialog, ErrorBoundary, Tabs, toast } from '../ui';
import { WidgetGrid, type WidgetGridItem } from './widget-grid';
import { AlertTriangle, LayoutDashboard, MessageSquare, Plus, Trash2 } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { evaluateWorkbench } from '../../lib/api/workbench';
import { fetchTools } from '../../lib/api/tools';
import { usePlatformCatalog } from '../../stores/platform-store';
import { useUIStore } from '../../stores';
import { AddWidgetDialog } from './add-widget-dialog';
import { recipeLabels } from '../../lib/workbench/recipes';
import { TemplateDialog } from './template-dialog';
import { WidgetCard, type WidgetState } from './widget-card';
import { onWorkbenchChanged } from '../../lib/workbench/sync';

function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

interface WorkbenchPanelProps {
  /**
   * Rendered instead of the grid when the user has no cards yet. The empty
   * state's job there is to introduce the assistant, not to show an empty
   * dashboard frame, so the host supplies it.
   */
  emptyFallback?: React.ReactNode;
  /** Keep the workbench mounted as a live preview while the composer drives an Agent conversation. */
  conversationMode?: boolean;
  onConversationModeChange?: (enabled: boolean) => void;
}

export function WorkbenchPanel({
  emptyFallback,
  conversationMode = false,
  onConversationModeChange,
}: WorkbenchPanelProps) {
  const t = useT();
  const { applications, preferences, savePreferences, refresh: refreshCatalog, loading } = usePlatformCatalog();
  const setHomeWorkbench = useUIStore((state) => state.setHomeWorkbench);
  const [editing, setEditing] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editingWidget, setEditingWidget] = useState<WorkbenchWidget | null>(null);
  const [clearOpen, setClearOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<WorkbenchTemplate | null>(null);
  const [activeTab, setActiveTab] = useState<string>(DEFAULT_TAB_ID);
  const [states, setStates] = useState<Record<string, WidgetState>>({});
  const [readableToolIds, setReadableToolIds] = useState<ReadonlySet<string>>(new Set());

  const widgets = preferences.widgets;
  const tabs = useMemo(
    () =>
      preferences.tabs.length > 0
        ? preferences.tabs
        : [{ id: DEFAULT_TAB_ID, title: t('home.defaultTab'), position: 0 }],
    [preferences.tabs, t],
  );

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTab)) setActiveTab(tabs[0].id);
  }, [activeTab, tabs]);

  useEffect(() => {
    void fetchTools().then((tools) => {
      setReadableToolIds(new Set(tools.filter((tool) => tool.surface?.workbench === true).map((tool) => tool.id)));
    });
  }, []);

  // Agent tools and other conversations can change the preference row while
  // this browser keeps a cached projection. Refresh on arrival, on a completed
  // local mutation, and when the app becomes active again after another tab or
  // window may have changed it.
  useEffect(() => {
    const refresh = () => void refreshCatalog();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    const unsubscribe = onWorkbenchChanged(refresh);
    window.addEventListener('focus', refresh);
    window.addEventListener('pageshow', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', refresh);
      window.removeEventListener('pageshow', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [refreshCatalog]);

  const visibleWidgets = useMemo(
    () => widgets.filter((widget) => widget.layout.tabId === activeTab),
    [activeTab, widgets],
  );

  const templates = useMemo(
    () =>
      availableWorkbenchTemplates({
        readableToolIds,
        visibleApplicationIds: applications.map((application) => application.id),
      }),
    [applications, readableToolIds],
  );

  /** Evaluate the given cards; text cards never leave the browser. */
  const evaluate = useCallback(async (targets: readonly WorkbenchWidget[]) => {
    const server = targets.filter((widget) => isDataWidget(widget) || isNavWidget(widget));
    if (server.length === 0) return;
    setStates((previous) => {
      const next = { ...previous };
      for (const widget of server) next[widget.id] = { ...next[widget.id], loading: true };
      return next;
    });
    try {
      const results = await evaluateWorkbench(server.map((widget) => ({ widgetId: widget.id })));
      setStates((previous) => {
        const next = { ...previous };
        results.forEach((result) => {
          const widget = server[result.index];
          if (!widget) return;
          if (!result.ok) next[widget.id] = { loading: false, error: result.error };
          else if ('nav' in result) next[widget.id] = { loading: false, nav: result.nav };
          else next[widget.id] = { loading: false, data: result.data };
        });
        return next;
      });
    } catch {
      setStates((previous) => {
        const next = { ...previous };
        for (const widget of server) next[widget.id] = { loading: false, error: 'failed' };
        return next;
      });
    }
  }, []);

  const evaluationKey = useMemo(
    () =>
      JSON.stringify(
        visibleWidgets.map((widget) =>
          isDataWidget(widget)
            ? [widget.id, widget.source]
            : isNavWidget(widget)
              ? [widget.id, widget.target]
              : [widget.id, 'text'],
        ),
      ),
    [visibleWidgets],
  );

  // Load on arrival and whenever a visible card's query/target changes. Layout
  // changes alone do not re-run data sources.
  useEffect(() => {
    void evaluate(visibleWidgets);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evaluate, evaluationKey]);

  // Hand the TopBar its controls for as long as this panel is on screen, and
  // take them back on unmount — in conversational edit mode the live preview
  // remains mounted after sending, so Done can close that mode from the TopBar.
  useEffect(() => {
    setHomeWorkbench({
      editing: editing || conversationMode,
      onToggleEdit: () => {
        if (conversationMode) {
          onConversationModeChange?.(false);
          return;
        }
        setEditing((value) => !value);
      },
    });
    return () => setHomeWorkbench(null);
  }, [conversationMode, editing, onConversationModeChange, setHomeWorkbench]);

  const persist = useCallback(
    async (nextWidgets: WorkbenchWidget[], nextTabs = preferences.tabs): Promise<boolean> => {
      try {
        await savePreferences({ ...preferences, widgets: nextWidgets, tabs: nextTabs });
        return true;
      } catch (error) {
        toast(error instanceof Error ? error.message : t('home.saveFailed'), 'error');
        return false;
      }
    },
    [preferences, savePreferences, t],
  );

  const handleLayoutChange = useCallback(
    (items: WidgetGridItem[]) => {
      const byId = new Map(items.map((item) => [item.id, item]));
      void persist(
        widgets.map((widget) => {
          const item = byId.get(widget.id);
          return item
            ? { ...widget, layout: { ...widget.layout, x: item.x, y: item.y, w: item.w, h: item.h } }
            : widget;
        }),
      );
    },
    [persist, widgets],
  );

  const handleSaveWidget = useCallback(
    (widget: WorkbenchWidget) => {
      const existing = widgets.some((candidate) => candidate.id === widget.id);
      if (!existing && widgets.length >= WORKBENCH_LIMITS.maxWidgets) {
        toast(t('home.limitReached'), 'error');
        return;
      }
      const next = existing
        ? widgets.map((candidate) => (candidate.id === widget.id ? widget : candidate))
        : [...widgets, widget];
      void persist(next).then((saved) => saved && void evaluate([widget]));
      setAddOpen(false);
      setEditingWidget(null);
    },
    [evaluate, persist, t, widgets],
  );

  const applyTemplate = useCallback(
    async (template: WorkbenchTemplate) => {
      const instantiated = instantiateWorkbenchTemplate(template.id, (recipe) => t(recipeLabels(recipe).labelKey));
      if (!instantiated) {
        toast(t('home.saveFailed'), 'error');
        return;
      }
      const saved = await persist(instantiated.widgets, instantiated.tabs);
      if (!saved) return;
      setActiveTab(DEFAULT_TAB_ID);
      setStates({});
      // savePreferences updates the Zustand store optimistically, so the
      // evaluation effect can race ahead of the PUT and ask the server for
      // widget ids it has not stored yet. Re-run after the save resolves to
      // make the committed config, not that harmless early miss, authoritative.
      await evaluate(instantiated.widgets);
      toast(t('home.templateApplied', { template: t(`home.template.${template.id}`) }), 'success');
    },
    [evaluate, persist, t],
  );

  const selectTemplate = useCallback(
    (template: WorkbenchTemplate) => {
      setTemplatesOpen(false);
      if (widgets.length > 0 || preferences.tabs.length > 0) {
        setPendingTemplate(template);
        return;
      }
      void applyTemplate(template);
    },
    [applyTemplate, preferences.tabs.length, widgets.length],
  );

  const gridItems: WidgetGridItem[] = useMemo(
    () =>
      visibleWidgets.map((widget) => ({
        id: widget.id,
        x: widget.layout.x,
        y: widget.layout.y,
        w: widget.layout.w,
        h: widget.layout.h,
        minW: 2,
        minH: isDataWidget(widget) && widget.display === 'kpi' ? 1 : 2,
        mobileH: isDataWidget(widget)
          ? widget.display === 'kpi'
            ? 2
            : widget.display === 'chart'
              ? 4
              : 3
          : isNavWidget(widget)
            ? 2
            : 3,
      })),
    [visibleWidgets],
  );

  const widgetsById = useMemo(() => new Map(widgets.map((widget) => [widget.id, widget])), [widgets]);

  if (loading && widgets.length === 0) {
    return <>{emptyFallback ?? null}</>;
  }

  // No cards and not editing: the host's introduction owns the screen. The Add
  // card entry point is still reachable through the TopBar's Customize toggle,
  // which is why this checks `editing` rather than card count alone.
  if (widgets.length === 0 && !editing && !conversationMode) {
    return <>{emptyFallback ?? null}</>;
  }

  return (
    <div className="animate-fade-in">
      {(tabs.length > 1 || editing || conversationMode) && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {editing && (
            <>
              <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>
                <Plus size={14} />
                {t('home.addCard')}
              </Button>
              {widgets.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setClearOpen(true)}>
                  <Trash2 size={14} />
                  {t('home.clearDashboard')}
                </Button>
              )}
              {templates.length > 0 && (
                <Button size="sm" variant="ghost" onClick={() => setTemplatesOpen(true)}>
                  <LayoutDashboard size={14} />
                  {t('home.templates')}
                </Button>
              )}
              {onConversationModeChange && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setEditing(false);
                    onConversationModeChange(true);
                  }}
                >
                  <MessageSquare size={14} />
                  {t('home.editByChat')}
                </Button>
              )}
            </>
          )}
          {conversationMode && (
            <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-primary-edge bg-primary-subtle px-3 py-2 text-xs text-primary-fg-strong">
              <MessageSquare size={14} className="flex-shrink-0" />
              <span>{t('home.chatEditActive')}</span>
            </div>
          )}
          {tabs.length > 1 && (
            <Tabs
              tabs={tabs.map((tab) => ({ key: tab.id, label: tab.title }))}
              active={activeTab}
              onChange={setActiveTab}
            />
          )}
          <div className="flex-1" />
        </div>
      )}

      <WidgetGrid
        items={gridItems}
        editing={editing}
        onLayoutChange={handleLayoutChange}
        renderItem={(id) => {
          const widget = widgetsById.get(id);
          if (!widget) return null;
          return (
            <ErrorBoundary
              fallback={
                <div className="flex h-full items-center justify-center gap-2 rounded-lg border border-edge bg-surface-card text-xs text-fg-faint">
                  <AlertTriangle size={16} />
                  {t('common.blockRenderFailed')}
                </div>
              }
            >
              <WidgetCard
                widget={widget}
                state={states[id] ?? {}}
                applications={applications}
                editing={editing}
                onEdit={() => {
                  setEditingWidget(widget);
                  setAddOpen(true);
                }}
                onRemove={() => void persist(widgets.filter((candidate) => candidate.id !== widget.id))}
                onRefresh={() => void evaluate([widget])}
              />
            </ErrorBoundary>
          );
        }}
      />

      <AddWidgetDialog
        open={addOpen}
        editing={editingWidget}
        applications={applications}
        readableToolIds={readableToolIds}
        onClose={() => {
          setAddOpen(false);
          setEditingWidget(null);
        }}
        onSave={handleSaveWidget}
        makeId={() => newId('w')}
        nextPosition={(width, height) => findNextWidgetPosition(widgets, activeTab, width, height)}
        tabId={activeTab}
      />

      <TemplateDialog
        open={templatesOpen}
        templates={templates}
        onClose={() => setTemplatesOpen(false)}
        onSelect={selectTemplate}
      />

      <ConfirmDialog
        open={pendingTemplate !== null}
        onClose={() => setPendingTemplate(null)}
        onConfirm={() => {
          const template = pendingTemplate;
          setPendingTemplate(null);
          if (template) void applyTemplate(template);
        }}
        title={t('home.replaceTemplateConfirm')}
        description={
          pendingTemplate
            ? t('home.replaceTemplateDescription', { template: t(`home.template.${pendingTemplate.id}`) })
            : undefined
        }
        confirmLabel={t('home.replaceWithTemplate')}
      />

      <ConfirmDialog
        open={clearOpen}
        onClose={() => setClearOpen(false)}
        onConfirm={() => {
          setClearOpen(false);
          void persist([], []);
        }}
        title={t('home.clearDashboardConfirm')}
        description={t('home.clearDashboardDescription')}
        confirmLabel={t('home.clearDashboard')}
        confirmVariant="destructive"
      />
    </div>
  );
}

export default WorkbenchPanel;

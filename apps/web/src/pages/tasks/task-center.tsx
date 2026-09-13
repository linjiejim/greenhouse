import { isRuntimeRunActive, type RuntimeRun } from '@greenhouse/types/runtime';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, EmptyState, Select, SkeletonCard, Tabs } from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { CheckCircle2, ClipboardList, ListTodo, Plus, RefreshCw, ShieldAlert } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { canUseFeature } from '../../lib/features';
import { missionExecutionHref } from '../../lib/execution-route';
import {
  getRuntimeSummary,
  listRuntimeInterrupts,
  listRuntimeRuns,
  type RuntimeInterruptListItem,
  type RuntimeScope,
  type RuntimeSummary,
} from '../../lib/api/runtime';
import { onRuntimeInvalidated } from '../../lib/runtime-invalidation';
import { wsClient } from '../../lib/ws';
import { useAuthStore, useWsStore } from '../../stores';
import { ApprovalInbox } from './approval-inbox';
import {
  filterTaskCenterRuns,
  taskCenterCounts,
  taskCenterKinds,
  type TaskCenterKindFilter,
  type TaskCenterTab,
} from './model';
import { TaskRunList } from './task-list';
import { NewRunDialog } from '../../components/cloud-agent/new-run-dialog';

const FALLBACK_REFRESH_MS = 15_000;

function SummaryStrip({ summary }: { summary: RuntimeSummary | null }) {
  const t = useT();
  const counts = taskCenterCounts(summary);
  const cards = [
    { key: 'attention', label: t('taskCenter.tab.attention'), count: counts.attention, icon: ShieldAlert },
    { key: 'active', label: t('taskCenter.tab.active'), count: counts.active, icon: ListTodo },
    { key: 'completed', label: t('taskCenter.tab.completed'), count: counts.completed, icon: CheckCircle2 },
    { key: 'all', label: t('taskCenter.tab.all'), count: counts.all, icon: ClipboardList },
  ];
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4" aria-label={t('taskCenter.summary')}>
      {cards.map((card) => {
        const Icon = card.icon;
        return (
          <Card key={card.key} className="flex items-center gap-3 p-3">
            <div className="rounded-lg bg-primary-subtle p-2 text-primary-fg">
              <Icon size={16} aria-hidden="true" />
            </div>
            <div>
              <div className="text-lg font-semibold leading-tight text-fg">{card.count}</div>
              <div className="text-[11px] text-fg-muted">{card.label}</div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

export function TaskCenter({
  initialKind = 'all',
  initialTab = 'active',
}: {
  initialKind?: TaskCenterKindFilter;
  initialTab?: TaskCenterTab;
}) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const connection = useWsStore((state) => state.status);
  const isSuper = currentUser?.role === 'super';
  const [scope, setScope] = useState<RuntimeScope>('own');
  const [kind, setKind] = useState<TaskCenterKindFilter>(initialKind);
  const [tab, setTab] = useState<TaskCenterTab>(initialTab);
  const [runs, setRuns] = useState<RuntimeRun[]>([]);
  const [interruptItems, setInterruptItems] = useState<RuntimeInterruptListItem[]>([]);
  const [summary, setSummary] = useState<RuntimeSummary | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [nextInterruptCursor, setNextInterruptCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadingMoreInterrupts, setLoadingMoreInterrupts] = useState(false);
  const [error, setError] = useState('');
  const [approvalUnavailable, setApprovalUnavailable] = useState('');
  const [createMissionOpen, setCreateMissionOpen] = useState(false);
  const canCreateMission = canUseFeature(currentUser, 'cloud-agent');

  const kinds = useMemo(() => taskCenterKinds(kind), [kind]);
  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [runPage, inboxResult, nextSummary] = await Promise.all([
          listRuntimeRuns({ scope, kinds, limit: 50 }),
          listRuntimeInterrupts({ scope, kinds, status: 'pending', limit: 100 })
            .then((page) => ({ page, unavailable: '' }))
            .catch((cause: unknown) => {
              const message = cause instanceof Error ? cause.message : '';
              if (!message.includes('Approval Inbox is unavailable')) throw cause;
              return { page: { items: [], next_cursor: null }, unavailable: message };
            }),
          getRuntimeSummary({ scope, kinds }),
        ]);
        setRuns(runPage.runs);
        setNextCursor(runPage.next_cursor);
        setInterruptItems(inboxResult.page.items);
        setNextInterruptCursor(inboxResult.page.next_cursor);
        setApprovalUnavailable(inboxResult.unavailable);
        setSummary(nextSummary);
        setError('');
      } catch (cause) {
        if (!silent) setError(cause instanceof Error ? cause.message : t('taskCenter.loadFailed'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [kinds, scope, t],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const hasActive = useMemo(() => runs.some((run) => isRuntimeRunActive(run.status)), [runs]);
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => void load(true), FALLBACK_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [hasActive, load]);

  useEffect(
    () =>
      wsClient.onEvent((event) => {
        if (event.type === 'mission:run' || event.type === 'workflow:progress') {
          void load(true);
        }
      }),
    [load],
  );
  useEffect(() => onRuntimeInvalidated(() => void load(true)), [load]);

  const counts = taskCenterCounts(summary);
  const tabs = [
    { key: 'attention', label: t('taskCenter.tab.attention'), count: counts.attention },
    { key: 'active', label: t('taskCenter.tab.active'), count: counts.active },
    { key: 'completed', label: t('taskCenter.tab.completed'), count: counts.completed },
    { key: 'failed', label: t('taskCenter.tab.failed'), count: counts.failed },
    { key: 'all', label: t('taskCenter.tab.all'), count: counts.all },
  ];
  const pendingInterrupts = useMemo(() => interruptItems.map((item) => item.interrupt), [interruptItems]);
  const visibleRuns = useMemo(() => filterTaskCenterRuns(runs, pendingInterrupts, tab), [pendingInterrupts, runs, tab]);
  const taskCenterUnavailable =
    !loading &&
    runs.length === 0 &&
    (error.includes('Execution Center is unavailable') || error.includes('Task Center is unavailable'));

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await listRuntimeRuns({ scope, kinds, cursor: nextCursor, limit: 50 });
      setRuns((current) => {
        const known = new Set(current.map((run) => run.id));
        return [...current, ...page.runs.filter((run) => !known.has(run.id))];
      });
      setNextCursor(page.next_cursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskCenter.loadFailed'));
    } finally {
      setLoadingMore(false);
    }
  }, [kinds, loadingMore, nextCursor, scope, t]);

  const loadMoreInterrupts = useCallback(async () => {
    if (!nextInterruptCursor || loadingMoreInterrupts) return;
    setLoadingMoreInterrupts(true);
    try {
      const page = await listRuntimeInterrupts({
        scope,
        kinds,
        status: 'pending',
        cursor: nextInterruptCursor,
        limit: 100,
      });
      setInterruptItems((current) => {
        const known = new Set(current.map((item) => item.interrupt.id));
        return [...current, ...page.items.filter((item) => !known.has(item.interrupt.id))];
      });
      setNextInterruptCursor(page.next_cursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('taskCenter.loadFailed'));
    } finally {
      setLoadingMoreInterrupts(false);
    }
  }, [kinds, loadingMoreInterrupts, nextInterruptCursor, scope, t]);

  if (taskCenterUnavailable) {
    return (
      <ModulePage moduleId="workspace.executions" layout="list">
        <EmptyState
          icon={ClipboardList}
          variant="page"
          tone="danger"
          title={t('taskCenter.unavailableTitle')}
          description={error}
          action={
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('common.tryAgain')}
            </Button>
          }
        />
      </ModulePage>
    );
  }

  return (
    <ModulePage
      moduleId="workspace.executions"
      layout="list"
      actions={
        <>
          {canCreateMission && (
            <Button variant="outline" size="sm" onClick={() => setCreateMissionOpen(true)}>
              <Plus size={13} className="mr-1.5" aria-hidden="true" />
              {t('taskCenter.newMission')}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={13} className="mr-1.5" aria-hidden="true" />
            {t('common.refresh')}
          </Button>
        </>
      }
      notice={
        error ? (
          <div className="flex flex-wrap items-center gap-2 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
            <span className="min-w-0 flex-1">{error}</span>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              {t('common.tryAgain')}
            </Button>
          </div>
        ) : undefined
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <div className="min-w-0 flex-1 overflow-x-auto scrollbar-hide">
            <Tabs
              tabs={tabs}
              active={tab}
              onChange={(value) => setTab(value as TaskCenterTab)}
              ariaLabel={t('taskCenter.filters')}
            />
          </div>
          <Select
            size="sm"
            inline
            value={kind}
            aria-label={t('taskCenter.kindFilter')}
            onChange={(event) => setKind(event.target.value as TaskCenterKindFilter)}
          >
            <option value="all">{t('taskCenter.kind.all')}</option>
            <option value="mission">{t('taskCenter.kind.mission')}</option>
            <option value="workflow">{t('taskCenter.kind.workflow')}</option>
            <option value="automation">{t('taskCenter.kind.automation')}</option>
            <option value="subagent">{t('taskCenter.kind.subagent')}</option>
          </Select>
          {isSuper && (
            <Select
              size="sm"
              inline
              value={scope}
              aria-label={t('taskCenter.scopeFilter')}
              onChange={(event) => setScope(event.target.value as RuntimeScope)}
            >
              <option value="own">{t('taskCenter.scope.own')}</option>
              <option value="all">{t('taskCenter.scope.all')}</option>
            </Select>
          )}
        </div>
      }
    >
      <SummaryStrip summary={summary} />

      <div className="mt-3">
        {loading && runs.length === 0 && interruptItems.length === 0 ? (
          <div className="grid gap-2">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : tab === 'attention' ? (
          <ApprovalInbox items={interruptItems} unavailable={approvalUnavailable} />
        ) : (
          <TaskRunList runs={visibleRuns} interrupts={pendingInterrupts} connection={connection} />
        )}
      </div>

      {tab !== 'attention' && nextCursor && (
        <div className="flex justify-center py-4">
          <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? t('common.loading') : t('taskCenter.loadMore')}
          </Button>
        </div>
      )}
      {tab === 'attention' && nextInterruptCursor && (
        <div className="flex justify-center py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void loadMoreInterrupts()}
            disabled={loadingMoreInterrupts}
          >
            {loadingMoreInterrupts ? t('common.loading') : t('taskCenter.loadMore')}
          </Button>
        </div>
      )}
      <NewRunDialog
        open={createMissionOpen}
        onClose={() => setCreateMissionOpen(false)}
        onCreated={(runId) => {
          setCreateMissionOpen(false);
          window.location.hash = missionExecutionHref(runId);
        }}
      />
    </ModulePage>
  );
}

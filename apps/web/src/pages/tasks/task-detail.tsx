import type { RuntimeInterrupt, RuntimeRunCommandType } from '@greenhouse/types/runtime';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DetailHeader, DetailSection, Field, FieldGrid } from '../../components/detail';
import { Button, ConfirmDialog, EmptyState, Spinner, toast } from '../../components/ui';
import { ClipboardList, FlaskConical, Pause, Play, RefreshCw, RotateCcw, Square } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import {
  commandRuntimeInterrupt,
  commandRuntimeRun,
  getRuntimeRun,
  type RuntimeRunDetail,
} from '../../lib/api/runtime';
import { notifyRuntimeInvalidated, onRuntimeInvalidated } from '../../lib/runtime-invalidation';
import { formatDate } from '../../lib/utils';
import { wsClient } from '../../lib/ws';
import { useAgentContext } from '../../components/agent-context';
import { RuntimeInterruptsSection } from './interrupts-section';
import { runtimeRunTitle, runtimeTransport } from './model';
import { RuntimePayloadPanel } from './payload-panel';
import {
  RuntimeArtifactsSection,
  RuntimeEventsSection,
  RuntimeStepsSection,
  RuntimeToolCallsSection,
} from './runtime-detail-sections';
import { RuntimeKindTag, RuntimeStatusAxes } from './status-axes';
import { useAuthStore, useWsStore } from '../../stores';
import { TraceDatasetDialog } from './trace-dataset-dialog';

const COMMAND_ICONS = {
  start: Play,
  pause: Pause,
  resume: Play,
  cancel: Square,
  retry: RotateCcw,
} satisfies Record<RuntimeRunCommandType, typeof Play>;

export function TaskRunDetail({ runId, backHref = '#/executions' }: { runId: string; backHref?: string }) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const connection = useWsStore((state) => state.status);
  const isSuper = useAuthStore((state) => state.currentUser?.role === 'super');
  const [detail, setDetail] = useState<RuntimeRunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [traceDatasetOpen, setTraceDatasetOpen] = useState(false);

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        setDetail(await getRuntimeRun(runId));
        setError('');
      } catch (cause) {
        if (!silent) setError(cause instanceof Error ? cause.message : t('taskCenter.loadFailed'));
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [runId, t],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!detail) return;
    enrichPageContext({
      runTitle: runtimeRunTitle(detail.run),
      lifecycle: detail.projection.lifecycle,
      attention: detail.projection.attention,
    });
    return () => enrichPageContext(null);
  }, [detail, enrichPageContext]);
  useEffect(
    () =>
      wsClient.onEvent((event) => {
        if (
          (event.type === 'mission:run' && event.runId === runId) ||
          (event.type === 'workflow:progress' && event.runId === runId)
        ) {
          void load(true);
        }
      }),
    [load, runId],
  );
  useEffect(
    () =>
      onRuntimeInvalidated((invalidatedRunId) => (!invalidatedRunId || invalidatedRunId === runId) && void load(true)),
    [load, runId],
  );

  const runCommand = useCallback(
    async (type: RuntimeRunCommandType) => {
      if (!detail) return;
      setBusy(type);
      try {
        const updated = await commandRuntimeRun(detail.run, type);
        setDetail((current) => (current ? { ...current, run: updated } : current));
        notifyRuntimeInvalidated(detail.run.id);
        toast(t('taskCenter.commandSucceeded'), 'success');
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : t('taskCenter.commandFailed'), 'error');
      } finally {
        setBusy(null);
      }
    },
    [detail, t],
  );

  const decide = useCallback(
    async (interrupt: RuntimeInterrupt, decision: 'approve' | 'reject') => {
      setBusy(interrupt.id);
      try {
        await commandRuntimeInterrupt(interrupt, decision);
        notifyRuntimeInvalidated(interrupt.run_id);
        toast(decision === 'approve' ? t('taskCenter.approved') : t('taskCenter.rejected'), 'success');
      } catch (cause) {
        toast(cause instanceof Error ? cause.message : t('taskCenter.decisionFailed'), 'error');
      } finally {
        setBusy(null);
      }
    },
    [t],
  );

  const commandButtons = useMemo(() => {
    if (!detail) return null;
    return (
      <>
        {isSuper && (
          <Button variant="outline" size="sm" onClick={() => setTraceDatasetOpen(true)} disabled={!!busy}>
            <FlaskConical size={13} className="mr-1.5" aria-hidden="true" />
            {t('taskCenter.traceDataset.action')}
          </Button>
        )}
        {detail.capabilities.commands.map((command) => {
          const Icon = COMMAND_ICONS[command];
          if (command === 'cancel') {
            return (
              <Button
                key={command}
                variant="outline"
                size="sm"
                onClick={() => setCancelConfirm(true)}
                disabled={!!busy}
              >
                <Icon size={13} className="mr-1.5" aria-hidden="true" />
                {t(`taskCenter.command.${command}`)}
              </Button>
            );
          }
          return (
            <Button
              key={command}
              variant="outline"
              size="sm"
              onClick={() => void runCommand(command)}
              disabled={!!busy}
            >
              <Icon size={13} className="mr-1.5" aria-hidden="true" />
              {t(`taskCenter.command.${command}`)}
            </Button>
          );
        })}
      </>
    );
  }, [busy, detail, isSuper, runCommand, t]);

  if (loading && !detail) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-canvas">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  }
  if (!detail) {
    return (
      <div className="h-full overflow-y-auto bg-surface-canvas px-4 py-6">
        <EmptyState
          icon={ClipboardList}
          variant="page"
          tone="danger"
          title={t('taskCenter.notFound')}
          description={error || undefined}
          action={
            <>
              <Button variant="outline" size="sm" onClick={() => (window.location.hash = backHref)}>
                {t('common.back')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => void load()}>
                <RefreshCw size={13} className="mr-1" /> {t('common.tryAgain')}
              </Button>
            </>
          }
        />
      </div>
    );
  }

  const { run } = detail;
  const title = runtimeRunTitle(run);
  const projection = {
    ...detail.projection,
    transport: runtimeTransport(run, Date.now(), connection),
  };
  return (
    <div className="h-full overflow-y-auto bg-surface-canvas">
      <div className="mx-auto w-full max-w-5xl px-3 pb-[max(1rem,env(safe-area-inset-bottom))] pt-4 md:px-6 md:pt-6">
        <DetailHeader
          onBack={() => (window.location.hash = backHref)}
          backLabel={t('common.back')}
          icon={
            <div className="rounded-lg bg-primary-subtle p-2 text-primary-fg">
              <ClipboardList size={18} aria-hidden="true" />
            </div>
          }
          title={title}
          titlePrefix={<RuntimeKindTag kind={run.kind} />}
          subtitle={<RuntimeStatusAxes projection={projection} />}
          meta={
            <>
              <span className="selectable" title={run.id}>
                {run.id}
              </span>
              <span>{formatDate(run.created_at)}</span>
            </>
          }
          actions={commandButtons}
        />

        {error && (
          <div className="mt-4 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}

        <DetailSection title={t('taskCenter.runDetails')} className="mt-6">
          <FieldGrid cols={4}>
            <Field label={t('taskCenter.source')} value={`${run.source_kind} / ${run.source_id}`} span={2} />
            <Field label={t('taskCenter.owner')} value={run.owner_user_id} />
            <Field label={t('taskCenter.initiator')} value={run.initiated_by_user_id} />
            <Field label={t('taskCenter.attempts')} value={`${run.attempt} / ${run.max_attempts}`} />
            <Field label={t('taskCenter.desiredState')} value={run.desired_state} />
            <Field label={t('taskCenter.startedAt')} value={run.started_at ? formatDate(run.started_at) : undefined} />
            <Field label={t('taskCenter.endedAt')} value={run.ended_at ? formatDate(run.ended_at) : undefined} />
            <Field label={t('taskCenter.rootRun')} value={run.root_run_id} />
            <Field label={t('taskCenter.parentRun')} value={run.parent_run_id} />
            <Field
              label={t('taskCenter.session')}
              value={
                run.session_id ? (
                  <a
                    href={`#/chat?session=${encodeURIComponent(run.session_id)}`}
                    className="text-primary-600 hover:underline"
                  >
                    {run.session_id}
                  </a>
                ) : undefined
              }
            />
            <Field label={t('taskCenter.waitReason')} value={run.wait_reason} />
          </FieldGrid>
          {(run.error_code || run.error_message) && (
            <p className="selectable mt-3 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">
              {[run.error_code, run.error_message].filter(Boolean).join(' — ')}
            </p>
          )}
          <div className="mt-3 space-y-2">
            <RuntimePayloadPanel title={t('taskCenter.runInput')} value={run.input} open />
            <RuntimePayloadPanel title={t('taskCenter.runOutput')} value={run.output} open />
          </div>
        </DetailSection>

        <RuntimeInterruptsSection
          interrupts={detail.interrupts}
          actions={detail.capabilities.actions}
          busyId={busy}
          onDecision={decide}
        />
        <RuntimeStepsSection steps={detail.steps} />
        <RuntimeToolCallsSection calls={detail.tool_calls} />
        <RuntimeArtifactsSection artifacts={detail.artifacts} />
        <RuntimeEventsSection events={detail.events} />
      </div>

      <ConfirmDialog
        open={cancelConfirm}
        onClose={() => setCancelConfirm(false)}
        onConfirm={() => {
          setCancelConfirm(false);
          void runCommand('cancel');
        }}
        title={t('taskCenter.cancelTitle')}
        description={t('taskCenter.cancelDescription')}
        confirmLabel={t('taskCenter.command.cancel')}
        confirmVariant="destructive"
      />
      {isSuper && (
        <TraceDatasetDialog runId={run.id} open={traceDatasetOpen} onClose={() => setTraceDatasetOpen(false)} />
      )}
    </div>
  );
}

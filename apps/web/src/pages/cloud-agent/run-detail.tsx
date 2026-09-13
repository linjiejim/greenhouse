/**
 * Mission — run detail: header (status/usage/cancel), event timeline,
 * artifacts.
 *
 * The timeline replays agent_run_events via incremental polling
 * (`GET /runs/:id/events?after=<lastSeq>`, every 2s while the run is active;
 * the response's run_status stops the loop on terminal states). Artifacts
 * download through the authenticated helper — plain <a href> has no Bearer.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, ConfirmDialog, EmptyState, IconButton, Spinner, toast } from '../../components/ui';
import { useAgentContext } from '../../components/agent-context';
import { DetailHeader, DetailSection, Field, FieldGrid } from '../../components/detail';
import { Markdown } from '../../components/markdown';
import { ClipboardList, Cloud, Download, FileText, Square } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate, formatTokens, safeParse } from '../../lib/utils';
import { downloadAuthenticatedFile, formatFileSize } from '../../lib/file-download';
import {
  cancelCloudAgentRun,
  cloudAgentArtifactDownloadUrl,
  cloudAgentJournalDownloadUrl,
  decideCloudAgentApproval,
  getCloudAgentRun,
  isCloudAgentRunActive,
  listCloudAgentRunEvents,
  mergeCloudAgentEvents,
  type CloudAgentArtifact,
  type CloudAgentApproval,
  type CloudAgentEvent,
  type CloudAgentRun,
} from '../../lib/api/cloud-agent';
import {
  RunStatusTag,
  RunTimeline,
  formatRunDuration,
  missionModelName,
  useMissionModels,
} from '../../components/cloud-agent';

const EVENT_POLL_INTERVAL_MS = 2_000;
const FAILURE_LABELS: Record<string, TranslationKey> = {
  runtime_start_failed: 'cloudAgent.failureRuntimeStart',
  wall_budget_exceeded: 'cloudAgent.failureWallBudget',
  request_budget_exceeded: 'cloudAgent.failureRequestBudget',
  workspace_quota_unverified: 'cloudAgent.failureWorkspaceQuotaUnverified',
  workspace_quota_exceeded: 'cloudAgent.failureWorkspaceQuota',
  container_exited: 'cloudAgent.failureContainerExited',
  container_missing: 'cloudAgent.failureContainerMissing',
  container_exited_during_restart: 'cloudAgent.failureContainerExited',
  container_lost_during_restart: 'cloudAgent.failureContainerMissing',
  approval_denied: 'cloudAgent.failureApprovalDenied',
  approval_expired: 'cloudAgent.failureApprovalExpired',
  runner_fatal: 'cloudAgent.failureRunner',
  runner_failed: 'cloudAgent.failureRunner',
};

export function CloudAgentRunDetail({
  runId,
  backHref = '#/executions',
  runtimeDetailsHref,
}: {
  runId: string;
  backHref?: string;
  runtimeDetailsHref?: string;
}) {
  const t = useT();
  const { enrichPageContext } = useAgentContext();
  const models = useMissionModels();
  const [run, setRun] = useState<CloudAgentRun | null>(null);
  const [artifacts, setArtifacts] = useState<CloudAgentArtifact[]>([]);
  const [approvals, setApprovals] = useState<CloudAgentApproval[]>([]);
  const [events, setEvents] = useState<CloudAgentEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [canceling, setCanceling] = useState(false);
  const [decidingApproval, setDecidingApproval] = useState<string | null>(null);
  const lastSeqRef = useRef(0);

  const mergeEvents = useCallback((incoming: CloudAgentEvent[]) => {
    if (incoming.length === 0) return;
    setEvents((prev) => {
      const next = mergeCloudAgentEvents(prev, incoming);
      lastSeqRef.current = next[next.length - 1]?.seq ?? lastSeqRef.current;
      return next;
    });
  }, []);

  /** Re-read run + artifacts (status transitions, usage counters, new uploads). */
  const loadRun = useCallback(async () => {
    const data = await getCloudAgentRun(runId);
    setRun(data.run);
    setArtifacts(data.artifacts);
    setApprovals(data.approvals);
    return data.run;
  }, [runId]);

  // Initial load: run detail + full event replay from seq 0.
  useEffect(() => {
    let disposed = false;
    lastSeqRef.current = 0;
    setEvents([]);
    setRun(null);
    setLoading(true);
    setError('');
    void (async () => {
      try {
        await loadRun();
        const res = await listCloudAgentRunEvents(runId, 0);
        if (disposed) return;
        mergeEvents(res.events);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : '');
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [runId, loadRun, mergeEvents]);

  // Incremental event polling while the run is active.
  const active = run !== null && isCloudAgentRunActive(run.status);
  useEffect(() => {
    if (!run) return;
    enrichPageContext({
      runTitle: run.title,
      lifecycle: run.status,
      attention: approvals.some((approval) => approval.status === 'pending') ? 'approval' : 'none',
    });
    return () => enrichPageContext(null);
  }, [approvals, enrichPageContext, run]);

  // A terminal CAS is visible before journal/outbox/workspace reconciliation
  // finishes. Keep polling until settled_at so the diagnostics button and
  // final metadata cannot disappear due to that short, real race.
  const polling = run !== null && (active || run.settled_at === null);
  // Keep the duration field alive between sparse step events. This is a local
  // clock only; status/usage/artifacts continue to come from the server row.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setClockTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!polling) return;
    let inFlight = false;
    const timer = window.setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      void (async () => {
        try {
          const res = await listCloudAgentRunEvents(runId, lastSeqRef.current);
          mergeEvents(res.events);
          // Any server-side status change (queued→running, terminal…) means the
          // run row moved — re-read it for usage/summary/artifacts and let the
          // `polling` decides whether terminal reconciliation is still due.
          await loadRun();
        } catch {
          /* transient poll failure — next tick retries */
        } finally {
          inFlight = false;
        }
      })();
    }, EVENT_POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [polling, runId, loadRun, mergeEvents]);

  const handleCancel = useCallback(async () => {
    setCancelConfirm(false);
    setCanceling(true);
    try {
      const updated = await cancelCloudAgentRun(runId);
      setRun(updated);
      toast(t('cloudAgent.canceled'), 'success');
      // Polling stops on the terminal status — sweep the tail events once so
      // the run.canceled timeline row still shows up.
      const res = await listCloudAgentRunEvents(runId, lastSeqRef.current).catch(() => null);
      if (res) mergeEvents(res.events);
    } catch (err) {
      toast(err instanceof Error ? err.message : t('cloudAgent.cancelFailed'), 'error');
    } finally {
      setCanceling(false);
    }
  }, [runId, t, mergeEvents]);

  const handleDownload = useCallback(
    async (artifact: CloudAgentArtifact) => {
      const filename = artifact.path.split('/').pop() || 'artifact';
      try {
        await downloadAuthenticatedFile(cloudAgentArtifactDownloadUrl(runId, artifact.id), filename);
      } catch {
        toast(t('cloudAgent.downloadFailed'), 'error');
      }
    },
    [runId, t],
  );

  const handleApproval = useCallback(
    async (approval: CloudAgentApproval, decision: 'approve' | 'deny') => {
      setDecidingApproval(approval.id);
      try {
        const updated = await decideCloudAgentApproval(runId, approval.id, decision);
        setApprovals((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        toast(decision === 'approve' ? t('cloudAgent.approvalApproved') : t('cloudAgent.approvalDenied'), 'success');
      } catch (err) {
        toast(err instanceof Error ? err.message : t('cloudAgent.approvalFailed'), 'error');
      } finally {
        setDecidingApproval(null);
      }
    },
    [runId, t],
  );

  const handleJournalDownload = useCallback(async () => {
    try {
      await downloadAuthenticatedFile(cloudAgentJournalDownloadUrl(runId), `${runId}-journal.jsonl`);
    } catch {
      toast(t('cloudAgent.downloadFailed'), 'error');
    }
  }, [runId, t]);

  const tokensText = useMemo(() => {
    if (!run) return '';
    return `${formatTokens(run.input_tokens)} in / ${formatTokens(run.output_tokens)} out`;
  }, [run]);
  const failureLabel = run?.failure_code ? FAILURE_LABELS[run.failure_code] : undefined;

  if (loading && !run) {
    return (
      <div className="flex h-full items-center justify-center bg-surface-canvas">
        <Spinner className="h-6 w-6 text-fg-faint" />
      </div>
    );
  }

  if (!run) {
    return (
      <div className="h-full overflow-y-auto bg-surface-canvas">
        <div className="mx-auto max-w-4xl px-4 py-6 md:px-6">
          <EmptyState
            icon={Cloud}
            tone="danger"
            variant="page"
            title={t('cloudAgent.notFound')}
            description={error || undefined}
            action={
              <Button variant="outline" size="sm" onClick={() => (window.location.hash = backHref)}>
                {t('common.back')}
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-surface-canvas">
      <div className="mx-auto max-w-4xl px-4 py-5 md:px-6">
        <DetailHeader
          onBack={() => (window.location.hash = backHref)}
          backLabel={t('common.back')}
          icon={
            <div className="rounded-lg bg-primary-subtle p-2 text-primary-fg">
              <Cloud size={18} />
            </div>
          }
          title={run.title}
          titleSuffix={<RunStatusTag status={run.status} size="sm" />}
          meta={
            <>
              <span title={run.id}>{run.id}</span>
              <span>
                {t('cloudAgent.queuedAt')} {formatDate(run.queued_at)}
              </span>
              {run.status === 'queued' && run.queue_position && (
                <span>{t('cloudAgent.queuePosition', { position: run.queue_position })}</span>
              )}
            </>
          }
          actions={
            <>
              {runtimeDetailsHref && (
                <Button variant="outline" size="sm" onClick={() => (window.location.hash = runtimeDetailsHref)}>
                  <ClipboardList size={13} className="mr-1.5" />
                  {t('taskCenter.runtimeDiagnostics')}
                </Button>
              )}
              {active ? (
                <Button variant="outline" size="sm" onClick={() => setCancelConfirm(true)} disabled={canceling}>
                  <Square size={13} className="mr-1.5" />
                  {t('cloudAgent.cancel')}
                </Button>
              ) : run.journal_storage_key ? (
                <Button variant="outline" size="sm" onClick={() => void handleJournalDownload()}>
                  <Download size={13} className="mr-1.5" />
                  {t('cloudAgent.downloadDiagnostics')}
                </Button>
              ) : null}
            </>
          }
        />

        <DetailSection className="mt-6">
          <FieldGrid cols={4}>
            <Field
              label={t('cloudAgent.model')}
              value={
                run.fallback_model
                  ? `${missionModelName(run.model, models)} → ${missionModelName(run.fallback_model, models)}`
                  : missionModelName(run.model, models)
              }
            />
            <Field label={t('cloudAgent.tokens')} value={tokensText} />
            <Field label={t('cloudAgent.requests')} value={`${run.used_requests} / ${run.max_requests}`} />
            <Field label={t('cloudAgent.duration')} value={formatRunDuration(run)} />
            <Field label={t('cloudAgent.startedAt')} value={run.started_at ? formatDate(run.started_at) : undefined} />
            <Field label={t('cloudAgent.endedAt')} value={run.ended_at ? formatDate(run.ended_at) : undefined} />
          </FieldGrid>
        </DetailSection>

        {run.status === 'queued' && run.queue_reason && (
          <div className="mt-4 rounded-md border border-edge bg-surface-muted px-3 py-2 text-xs text-fg-secondary">
            {run.queue_reason === 'user_active'
              ? t('cloudAgent.queueUserActive')
              : run.queue_reason === 'global_capacity'
                ? t('cloudAgent.queueGlobalCapacity')
                : t('cloudAgent.queueReady')}
          </div>
        )}

        <DetailSection title={t('cloudAgent.originalPrompt')} className="mt-6">
          <Markdown content={run.original_prompt || run.prompt} compact />
        </DetailSection>

        {approvals.some((approval) => approval.status === 'pending' || approval.status === 'approved') && (
          <DetailSection title={t('cloudAgent.approvals')} className="mt-6">
            <div className="space-y-3">
              {approvals
                .filter((approval) => approval.status === 'pending' || approval.status === 'approved')
                .map((approval) => (
                  <div key={approval.id} className="rounded-lg border border-warning bg-warning-subtle p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="text-xs font-semibold text-warning">{t('cloudAgent.approvalRequired')}</div>
                      <code className="rounded bg-surface-raised px-1.5 py-0.5 text-[11px] text-fg-secondary">
                        {approval.tool_id}
                        {approval.action ? ` · ${approval.action}` : ''}
                      </code>
                      {approval.status === 'approved' && (
                        <span className="text-[11px] text-warning">{t('cloudAgent.approvalWaitingExecution')}</span>
                      )}
                    </div>
                    <div className="mt-2 text-[11px] text-fg-muted">{t('cloudAgent.approvalExactInput')}</div>
                    <pre className="mt-1 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-md border border-edge bg-surface-raised p-2 text-[11px] text-fg-secondary">
                      {JSON.stringify(safeParse(approval.input_json, {}), null, 2)}
                    </pre>
                    {approval.status === 'pending' && (
                      <div className="mt-3 flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={decidingApproval === approval.id}
                          onClick={() => void handleApproval(approval, 'deny')}
                        >
                          {t('cloudAgent.denyMutation')}
                        </Button>
                        <Button
                          size="sm"
                          disabled={decidingApproval === approval.id}
                          onClick={() => void handleApproval(approval, 'approve')}
                        >
                          {t('cloudAgent.approveMutation')}
                        </Button>
                      </div>
                    )}
                  </div>
                ))}
            </div>
          </DetailSection>
        )}

        {run.error && (
          <div className="mt-4 rounded-md border border-danger bg-danger-subtle px-3 py-2">
            <div className="mb-0.5 text-[11px] font-medium text-danger">{t('cloudAgent.errorLabel')}</div>
            {failureLabel && <div className="mb-1 text-xs font-medium text-danger">{t(failureLabel)}</div>}
            {run.failure_code && <div className="mb-1 font-mono text-[10px] text-danger">{run.failure_code}</div>}
            <div className="whitespace-pre-wrap break-words text-xs text-danger">{run.error}</div>
          </div>
        )}

        {run.result_summary && (
          <DetailSection title={t('cloudAgent.summary')} className="mt-6">
            <Markdown content={run.result_summary} compact />
          </DetailSection>
        )}

        <DetailSection title={t('cloudAgent.timeline')} className="mt-6">
          {events.length === 0 ? (
            <div className="flex items-center gap-2 py-2 text-xs text-fg-faint">
              {active && <Spinner className="h-3.5 w-3.5" />}
              <span>{active ? t('cloudAgent.timelineWaiting') : t('cloudAgent.timelineEmpty')}</span>
            </div>
          ) : (
            <RunTimeline events={events} />
          )}
        </DetailSection>

        <DetailSection title={t('cloudAgent.artifacts', { count: artifacts.length })} className="mt-6">
          {artifacts.length === 0 ? (
            <div className="py-1 text-xs text-fg-faint">{t('cloudAgent.noArtifacts')}</div>
          ) : (
            <div className="space-y-1.5">
              {artifacts.map((artifact) => (
                <div
                  key={artifact.id}
                  className="flex items-center gap-2 rounded-md border border-edge bg-surface-raised px-3 py-2"
                >
                  <FileText size={14} className="flex-shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1 truncate text-xs text-fg-secondary" title={artifact.path}>
                    {artifact.path}
                  </span>
                  <span className="flex-shrink-0 text-[10px] text-fg-faint">{formatFileSize(artifact.size_bytes)}</span>
                  <IconButton label={t('cloudAgent.download')} onClick={() => void handleDownload(artifact)}>
                    <Download size={14} />
                  </IconButton>
                </div>
              ))}
            </div>
          )}
        </DetailSection>
      </div>

      <ConfirmDialog
        open={cancelConfirm}
        onClose={() => setCancelConfirm(false)}
        onConfirm={() => void handleCancel()}
        title={t('cloudAgent.cancelConfirmTitle')}
        description={t('cloudAgent.cancelConfirmDesc')}
        confirmLabel={t('cloudAgent.cancel')}
        confirmVariant="destructive"
      />
    </div>
  );
}

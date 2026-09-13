/**
 * Task dock — the session-level instrument panel, docked above the composer.
 *
 * A background task lives for many minutes while the transcript keeps growing,
 * so its state does not belong to a message: one collapsed line per task
 * (type icon, name, status, elapsed), expandable into the full instrument.
 * Delivery stays in the message flow — a workflow's deliverable and a mission's
 * outcome are both written there as assistant messages, because a deliverable
 * is something you read, not a gauge (workflow v2 D13, session-modes D6).
 *
 * Generalized from the workflow-only dock: both execution bases render here so
 * the user has ONE place to look at "what is running for me in this
 * conversation", regardless of which one is doing the work.
 */

import React, { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Cloud, Workflow as WorkflowIcon } from '../../lib/icons';
import type { WorkflowRunView } from '@greenhouse/types/workflow';
import { Button, Spinner } from '../ui';
import { useT } from '../../lib/i18n';
import { ACTIVE_RUN_STATUSES } from '../../lib/workflow-constants';
import { useWorkflowRun } from '../workflow/use-workflow-run';
import { WorkflowRunBody } from '../workflow/run-view';
import { RunTimeline, formatRunDuration } from '../cloud-agent';
import type { CloudAgentEvent, CloudAgentRun } from '../../lib/api/cloud-agent';
import { safeParse } from '../../lib/utils';
import type { MissionSessionState } from './use-mission-run';

const OPEN_KEY_PREFIX = 'task-dock-open:';

function readOpen(kind: string): boolean {
  try {
    return localStorage.getItem(`${OPEN_KEY_PREFIX}${kind}`) === '1';
  } catch {
    return false;
  }
}

function workflowElapsed(run: WorkflowRunView): string | null {
  if (!run.started_at) return null;
  const end = run.finished_at ? Date.parse(run.finished_at) : Date.now();
  const secs = Math.max(0, Math.round((end - Date.parse(run.started_at)) / 1000));
  if (!Number.isFinite(secs)) return null;
  return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
}

/** Count observed tool steps and identify the one still running, if any. */
export function missionDockProgress(events: CloudAgentEvent[]): { stepCount: number; currentTool: string | null } {
  const openTools: string[] = [];
  let stepCount = 0;
  for (const event of events) {
    if (event.type !== 'tool.started' && event.type !== 'tool.completed') continue;
    const payload = safeParse<Record<string, unknown>>(event.payload, {});
    const tool = typeof payload.tool === 'string' && payload.tool ? payload.tool : 'tool';
    if (event.type === 'tool.started') {
      stepCount += 1;
      openTools.push(tool);
      continue;
    }
    const index = openTools.indexOf(tool);
    if (index >= 0) openTools.splice(index, 1);
  }
  return { stepCount, currentTool: openTools.at(-1) ?? null };
}

export function TaskDock({
  sessionId,
  mission,
  workflowEnabled,
  onTaskSettled,
  onAddMissionInstruction,
}: {
  sessionId: string;
  mission: MissionSessionState;
  workflowEnabled: boolean;
  /** A workflow run just finished — the caller reloads the transcript to show
   *  the outcome message the engine wrote beside that transition. (Missions
   *  already report this through the shared mission hook.) */
  onTaskSettled?: () => void;
  /** Route the next composer send directly to this Mission workspace. */
  onAddMissionInstruction?: (run: CloudAgentRun) => void;
}) {
  const { run: workflowRun, refresh: refreshWorkflow } = useWorkflowRun({
    sessionId,
    enabled: workflowEnabled,
    onSettled: onTaskSettled,
  });
  const missionRun = mission.latestRun;

  if (!workflowRun && !missionRun) return null;

  return (
    <div className="relative z-0 -mb-1 translate-y-0.5 space-y-2" data-testid="task-dock">
      {workflowEnabled && workflowRun && <WorkflowRow run={workflowRun} onChanged={refreshWorkflow} />}
      {missionRun && <MissionRow run={missionRun} mission={mission} onAddInstruction={onAddMissionInstruction} />}
    </div>
  );
}

// ─── Shared row shell ────────────────────────────────────

function DockRow({
  kind,
  testId,
  icon,
  spinning,
  name,
  status,
  meta,
  tone,
  toggleLabel,
  children,
}: {
  kind: string;
  testId: string;
  icon: React.ReactNode;
  spinning: boolean;
  name: string;
  status?: React.ReactNode;
  meta: React.ReactNode;
  tone: string;
  toggleLabel: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(() => readOpen(kind));

  useEffect(() => {
    try {
      localStorage.setItem(`${OPEN_KEY_PREFIX}${kind}`, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [kind, open]);

  return (
    <div className={`overflow-hidden rounded-t-xl rounded-b-lg border border-edge/70 ${tone}`} data-testid={testId}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={toggleLabel}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-surface-muted/40"
      >
        {spinning ? <Spinner className="h-3.5 w-3.5 flex-shrink-0 text-primary-500" /> : icon}
        <span className="hidden max-w-[16rem] truncate text-xs font-medium text-fg md:inline">{name}</span>
        {meta}
        <span className="min-w-0 flex-1" />
        {status ? <span className="flex-shrink-0">{status}</span> : null}
        <span className="flex-shrink-0 text-fg-muted">
          {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
        </span>
      </button>

      {open && (
        <div className="max-h-[46vh] overflow-y-auto border-t border-edge bg-surface-sunken px-3 py-2.5">
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Workflow row ────────────────────────────────────────

function WorkflowRow({ run, onChanged }: { run: WorkflowRunView; onChanged: () => Promise<void> }) {
  const t = useT();
  // Re-render once a second while active so the elapsed clock ticks.
  const [, setTick] = useState(0);
  const active = ACTIVE_RUN_STATUSES.has(run.status);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  const pendingGates = run.gates.filter((g) => g.status === 'pending' && g.kind !== 'confirm_plan');
  const waiting = pendingGates.length > 0;
  const runningNode = run.node_runs.find((r) => r.status === 'running')?.node_id;
  const elapsed = workflowElapsed(run);

  const STATUS_LABELS: Record<string, string> = {
    running: runningNode ? t('workflow.dockRunningNode', { node: runningNode }) : t('workflow.statusRunning'),
    paused: t('workflow.statusUserPaused'),
    paused_for_gate: t('workflow.statusPaused'),
    completed: t('workflow.statusCompleted'),
    failed: t('workflow.statusFailed'),
    canceled: t('workflow.statusCanceled'),
  };
  const statusLabel = waiting ? t('workflow.dockWaiting') : (STATUS_LABELS[run.status] ?? run.status);

  const tone = waiting
    ? 'bg-warning-subtle/50'
    : run.status === 'failed'
      ? 'bg-danger-subtle/35'
      : run.status === 'completed'
        ? 'bg-success-subtle/30'
        : 'bg-surface-sunken';

  return (
    <DockRow
      kind="workflow"
      testId="workflow-dock"
      icon={<WorkflowIcon size={13} className="flex-shrink-0 text-fg-muted" />}
      spinning={active && !waiting}
      name={run.name}
      status={<span className="truncate text-xs text-fg-secondary">{statusLabel}</span>}
      meta={
        <>
          <span className="flex-shrink-0 text-[10px] text-fg-faint">
            {t('workflow.progress', { completed: run.completed, total: run.total })}
          </span>
          {elapsed && <span className="flex-shrink-0 text-[10px] text-fg-faint">· {elapsed}</span>}
          <span className="hidden flex-shrink-0 text-[10px] text-fg-faint sm:inline">
            · {t('workflow.tokensUsed', { tokens: run.tokens_used.toLocaleString() })}
          </span>
        </>
      }
      tone={tone}
      toggleLabel={t('workflow.dockToggle')}
    >
      <WorkflowRunBody run={run} workflowName={run.name} onChanged={() => void onChanged()} />
    </DockRow>
  );
}

// ─── Mission row ─────────────────────────────────────────

function MissionRow({
  run,
  mission,
  onAddInstruction,
}: {
  run: CloudAgentRun;
  mission: MissionSessionState;
  onAddInstruction?: (run: CloudAgentRun) => void;
}) {
  const t = useT();
  const active = !!mission.activeRun;
  const progress = missionDockProgress(mission.events);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);

  const tone = run.status === 'failed' ? 'bg-danger-subtle/35' : 'bg-surface-sunken/95';

  return (
    <DockRow
      kind="mission"
      testId="mission-dock"
      icon={<Cloud size={13} className="flex-shrink-0 text-fg-muted" />}
      spinning={active}
      name={t('cloudAgent.dispatchTitle')}
      meta={
        <span className="min-w-0 truncate text-[10px] tabular-nums text-fg-faint">
          {progress.stepCount > 0 ? (
            <>
              {progress.currentTool
                ? t('cloudAgent.dockCurrentStep', {
                    step: progress.currentTool,
                    count: progress.stepCount,
                  })
                : t('cloudAgent.dockSteps', { count: progress.stepCount })}{' '}
              ·{' '}
            </>
          ) : null}
          {formatRunDuration(run)}
        </span>
      }
      tone={tone}
      toggleLabel={t('cloudAgent.dispatchTitle')}
    >
      <div className="space-y-2.5">
        {mission.events.length === 0 ? (
          <div className="flex items-center gap-2 py-1 text-xs text-fg-faint">
            {active && <Spinner className="h-3.5 w-3.5" />}
            <span>{active ? t('cloudAgent.timelineWaiting') : t('cloudAgent.timelineEmpty')}</span>
          </div>
        ) : (
          <RunTimeline events={mission.events} variant="summary" />
        )}
        {onAddInstruction && (
          <div className="flex flex-wrap items-center gap-2 border-t border-edge pt-2.5">
            <p className="min-w-0 flex-1 text-[10px] text-fg-faint">{t('cloudAgent.dockFollowUpHint')}</p>
            <Button type="button" variant="outline" size="sm" onClick={() => onAddInstruction(run)}>
              {t('cloudAgent.dockFollowUp')}
            </Button>
          </div>
        )}
      </div>
    </DockRow>
  );
}

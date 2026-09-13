/**
 * Live run body — DAG canvas + node inspector + pending gates + deliverable.
 *
 * Shared by the message-flow card and the composer dock so there is exactly one
 * implementation of "what a running workflow looks like".
 */

import React, { useCallback, useMemo, useState } from 'react';
import type { WorkflowNodeRunView, WorkflowRunView } from '@greenhouse/types/workflow';
import { toast } from '../ui';
import { useT } from '../../lib/i18n';
import * as api from '../../lib/api';
import { ACTIVE_RUN_STATUSES } from '../../lib/workflow-constants';
import { WorkflowGraphCanvas } from './workflow-graph';
import { WorkflowInspector } from './workflow-inspector';
import { GatePanel } from './gate-panel';
import { DeliverableView } from './deliverable-view';

/** Latest attempt row per node id (rows arrive in attempt order). */
export function latestNodeRuns(run: WorkflowRunView): Map<string, WorkflowNodeRunView> {
  const map = new Map<string, WorkflowNodeRunView>();
  for (const row of run.node_runs) map.set(row.node_id, row);
  return map;
}

export function openWorkflowSession(sessionId: string): void {
  window.location.hash = `#/chat?session=${sessionId}`;
}

export function WorkflowRunBody({
  run,
  workflowName,
  onChanged,
  showProgress = true,
}: {
  run: WorkflowRunView;
  workflowName: string;
  onChanged: () => void;
  showProgress?: boolean;
}) {
  const t = useT();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const active = ACTIVE_RUN_STATUSES.has(run.status);
  const latest = useMemo(() => latestNodeRuns(run), [run]);
  const pendingGates = run.gates.filter((g) => g.status === 'pending' && g.kind !== 'confirm_plan');

  // Default the inspector to whatever needs attention: a gated node, a running
  // node, then a failure — so opening the dock lands on the interesting one.
  const focusNodeId =
    selectedNodeId ??
    pendingGates.find((g) => g.node_id)?.node_id ??
    run.node_runs.find((r) => r.status === 'running')?.node_id ??
    run.node_runs.find((r) => r.status === 'failed')?.node_id ??
    null;

  const selectedNode = focusNodeId ? run.graph.nodes.find((n) => n.id === focusNodeId) : undefined;

  const act = useCallback(
    async (fn: () => Promise<void>) => {
      try {
        await fn();
        onChanged();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'action failed', 'error');
      }
    },
    [onChanged],
  );

  // Requeueing is only meaningful for attempts that did not succeed (D16).
  const selectedRow = selectedNode ? latest.get(selectedNode.id) : undefined;
  const requeueable = selectedRow != null && ['failed', 'skipped', 'returned'].includes(selectedRow.status);

  return (
    <div className="space-y-2.5">
      {showProgress && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-fg-faint">
          <span>{t('workflow.progress', { completed: run.completed, total: run.total })}</span>
          <span>·</span>
          <span>{t('workflow.tokensUsed', { tokens: run.tokens_used.toLocaleString() })}</span>
          <div className="ml-auto flex items-center gap-2">
            {run.status === 'running' && (
              <button onClick={() => act(() => api.pauseWorkflowRun(run.id))} className="hover:underline">
                {t('workflow.pause')}
              </button>
            )}
            {run.status === 'paused' && (
              <button
                onClick={() => act(() => api.resumeWorkflowRun(run.id))}
                className="font-medium text-primary-fg-strong hover:underline"
              >
                {t('workflow.resume')}
              </button>
            )}
            {active && (
              <button onClick={() => act(() => api.cancelWorkflowRun(run.id))} className="text-danger hover:underline">
                {t('workflow.cancelRun')}
              </button>
            )}
          </div>
        </div>
      )}

      <WorkflowGraphCanvas
        graph={run.graph}
        statusOf={(id) => latest.get(id)?.status}
        selectedNodeId={focusNodeId}
        onSelect={(id) => setSelectedNodeId((prev) => (prev === id ? null : id))}
        deliverableLabel={t('workflow.deliverable')}
      />

      {selectedNode && (
        <WorkflowInspector
          node={selectedNode}
          row={selectedRow}
          attempts={run.node_runs.filter((r) => r.node_id === selectedNode.id)}
          isDeliverable={run.graph.deliverable_node === selectedNode.id}
          onOpenSession={openWorkflowSession}
          actions={
            requeueable ? (
              <>
                <InspectorAction
                  label={t('workflow.retry')}
                  onClick={() => act(() => api.retryWorkflowNode(run.id, selectedNode.id))}
                />
                <InspectorAction
                  label={t('workflow.skip')}
                  onClick={() => act(() => api.skipWorkflowNode(run.id, selectedNode.id))}
                />
              </>
            ) : null
          }
        />
      )}

      {pendingGates.map((gate) => (
        <GatePanel key={gate.id} runId={run.id} gate={gate} onDecided={onChanged} />
      ))}

      {run.status === 'completed' && run.summary && (
        <DeliverableView summary={run.summary} workflowName={workflowName} taskInput={run.task_input} />
      )}
      {run.error && <div className="text-[11px] text-danger">{run.error}</div>}
    </div>
  );
}

function InspectorAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
    >
      {label}
    </button>
  );
}

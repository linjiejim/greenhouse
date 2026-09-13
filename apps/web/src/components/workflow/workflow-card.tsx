/**
 * Workflow card — the body artifact behind the `workflow_plan` tool output.
 *
 * Two states in one card:
 *   Plan  — editable confirm surface (graph canvas + task statement + budget);
 *           Confirm is the ONLY way execution starts.
 *   Run   — the same live body the dock renders (DAG + inspector + gates +
 *           deliverable), so scrolling back to the card never shows stale UI.
 *
 * On reload the card re-discovers its run from GET /api/workflows/:id, so the
 * static tool output in messages.pipeline stays the single artifact anchor.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { WorkflowBudget, WorkflowGraph, WorkflowNode, WorkflowPlanArtifact } from '@greenhouse/types/workflow';
import { Button, Spinner, toast } from '../ui';
import { GitBranch } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import * as api from '../../lib/api';
import { WorkflowGraphCanvas } from './workflow-graph';
import { WorkflowInspector } from './workflow-inspector';
import { WorkflowRunBody } from './run-view';
import { useWorkflowRun } from './use-workflow-run';
import { NodeEditor, removeNode } from './node-editor';
import { ArtifactCard } from '../chat/artifact-card';

export function WorkflowCard({ artifact }: { artifact: WorkflowPlanArtifact }) {
  const t = useT();
  const [runId, setRunId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [discovered, setDiscovered] = useState(false);
  // "Not now" — an explicit refusal, so a declined proposal stops looking
  // actionable in the transcript. Nothing is deleted; the draft still exists.
  const [dismissed, setDismissed] = useState(false);
  const [taskInput, setTaskInput] = useState(artifact.task_input ?? '');
  const [budget, setBudget] = useState<WorkflowBudget>(artifact.budget);
  // Plan-time graph edits live here until saved; the artifact payload is frozen.
  const [draftGraph, setDraftGraph] = useState<WorkflowGraph | null>(null);
  const [version, setVersion] = useState(artifact.version);
  const [open, setOpen] = useState(true);
  const { run, refresh } = useWorkflowRun({ runId });

  const terminal = !!run && ['completed', 'failed', 'canceled'].includes(run.status);
  useEffect(() => {
    if (terminal) setOpen(false);
  }, [terminal]);

  // Re-discover an existing run after reload (the tool output itself is static).
  // The stored definition wins over the frozen artifact — it may have been edited.
  useEffect(() => {
    let alive = true;
    (async () => {
      const detail = await api.getWorkflow(artifact.workflow_id);
      if (!alive) return;
      const latest = detail?.runs[0];
      if (latest) setRunId(latest.id);
      if (detail?.workflow.graph?.nodes?.length) {
        setDraftGraph(detail.workflow.graph);
        setVersion(detail.workflow.version);
      }
      setDiscovered(true);
    })();
    return () => {
      alive = false;
    };
  }, [artifact.workflow_id]);

  const handleSaveGraph = useCallback(
    async (next: WorkflowGraph) => {
      const { version: saved } = await api.updateWorkflowGraph(artifact.workflow_id, next);
      setDraftGraph(next);
      setVersion(saved);
    },
    [artifact.workflow_id],
  );

  const handleConfirm = useCallback(async () => {
    if (confirming || taskInput.trim().length === 0) return;
    setConfirming(true);
    try {
      const { run_id } = await api.confirmWorkflow(artifact.workflow_id, taskInput.trim(), budget);
      setRunId(run_id);
      toast(t('workflow.started'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('workflow.confirmFailed'), 'error');
    } finally {
      setConfirming(false);
    }
  }, [artifact.workflow_id, budget, confirming, taskInput, t]);

  const graph = run?.graph?.nodes?.length ? run.graph : (draftGraph ?? artifact.graph);
  const statusLabel = run
    ? ({
        running: t('workflow.statusRunning'),
        paused: t('workflow.statusUserPaused'),
        paused_for_gate: t('workflow.statusPaused'),
        completed: t('workflow.statusCompleted'),
        failed: t('workflow.statusFailed'),
        canceled: t('workflow.statusCanceled'),
      }[run.status] ?? run.status)
    : dismissed
      ? t('workflow.planDismissed')
      : t('workflow.reviewStatus');
  const statusTone = run
    ? run.status === 'completed'
      ? ('success' as const)
      : run.status === 'failed' || run.status === 'canceled'
        ? ('danger' as const)
        : ('info' as const)
    : dismissed
      ? ('neutral' as const)
      : ('primary' as const);

  return (
    <ArtifactCard
      icon={<GitBranch size={14} />}
      title={artifact.name}
      meta={`${t('workflow.nodeCount', { count: graph.nodes.length })} · v${run?.workflow_version ?? version}`}
      status={{ label: statusLabel, tone: statusTone, busy: run?.status === 'running' || confirming }}
      collapsed={!open}
      onToggle={terminal || dismissed ? () => setOpen((value) => !value) : undefined}
      tone={run?.status === 'completed' ? 'success' : run?.status === 'failed' ? 'danger' : 'neutral'}
    >
      {run ? (
        <WorkflowRunBody run={run} workflowName={artifact.name} onChanged={refresh} />
      ) : dismissed ? (
        <div className="text-[10px] text-fg-faint">{t('workflow.planDismissed')}</div>
      ) : discovered ? (
        <PlanBody
          graph={graph}
          onSaveGraph={handleSaveGraph}
          taskInput={taskInput}
          setTaskInput={setTaskInput}
          budget={budget}
          setBudget={setBudget}
          confirming={confirming}
          onConfirm={handleConfirm}
          onDismiss={() => setDismissed(true)}
        />
      ) : (
        <div className="flex items-center gap-2 text-xs text-fg-faint">
          <Spinner className="h-3.5 w-3.5" /> {t('common.loading')}
        </div>
      )}
    </ArtifactCard>
  );
}

// ─── Plan (confirm) body ─────────────────────────────────

function PlanBody({
  graph,
  onSaveGraph,
  taskInput,
  setTaskInput,
  budget,
  setBudget,
  confirming,
  onConfirm,
  onDismiss,
}: {
  graph: WorkflowGraph;
  onSaveGraph: (next: WorkflowGraph) => Promise<void>;
  taskInput: string;
  setTaskInput: (v: string) => void;
  budget: WorkflowBudget;
  setBudget: (b: WorkflowBudget) => void;
  confirming: boolean;
  onConfirm: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<WorkflowGraph | null>(null);
  const [saving, setSaving] = useState(false);

  const shown = draft ?? graph;
  const selectedNode = selectedNodeId ? shown.nodes.find((n) => n.id === selectedNodeId) : undefined;
  const dirty = draft != null;

  // The current graph (saved or edited), reachable from stable callbacks so
  // typing in the editor does not re-create them on every keystroke.
  const shownRef = useRef(shown);
  shownRef.current = shown;

  const patchNode = useCallback((next: WorkflowNode) => {
    const base = shownRef.current;
    setDraft({ ...base, nodes: base.nodes.map((n) => (n.id === next.id ? next : n)) });
  }, []);

  const deleteNode = useCallback((id: string) => {
    setDraft(removeNode(shownRef.current, id));
    setSelectedNodeId(null);
  }, []);

  const save = useCallback(async () => {
    if (!draft || saving) return;
    setSaving(true);
    try {
      await onSaveGraph(draft);
      setDraft(null);
      setEditing(false);
      toast(t('workflow.graphSaved'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('workflow.graphSaveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  }, [draft, saving, onSaveGraph, t]);

  const discard = useCallback(() => {
    setDraft(null);
    setEditing(false);
  }, []);

  return (
    <div className="space-y-3">
      <WorkflowGraphCanvas
        graph={shown}
        selectedNodeId={selectedNodeId}
        onSelect={(id) => setSelectedNodeId((prev) => (prev === id ? null : id))}
        deliverableLabel={t('workflow.deliverable')}
      />

      <div className="flex items-center gap-2 text-[10px]">
        <button
          onClick={() => (editing ? discard() : setEditing(true))}
          className="text-fg-secondary hover:text-fg hover:underline"
        >
          {editing ? t('workflow.doneEditing') : t('workflow.editGraph')}
        </button>
        {dirty && (
          <>
            <span className="text-warning">{t('workflow.unsavedGraph')}</span>
            <button
              onClick={save}
              disabled={saving}
              className="rounded-md bg-primary-500 px-2 py-0.5 font-medium text-white hover:bg-primary-600 disabled:opacity-50"
            >
              {saving ? t('workflow.savingGraph') : t('workflow.saveGraph')}
            </button>
          </>
        )}
      </div>

      {selectedNode &&
        (editing ? (
          <NodeEditor
            graph={shown}
            node={selectedNode}
            onChange={patchNode}
            onDelete={() => deleteNode(selectedNode.id)}
            saving={saving}
          />
        ) : (
          <WorkflowInspector
            node={selectedNode}
            row={undefined}
            attempts={[]}
            isDeliverable={shown.deliverable_node === selectedNode.id}
          />
        ))}

      <div>
        <label className="mb-1 block text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
          {t('workflow.taskInput')}
        </label>
        <textarea
          value={taskInput}
          onChange={(e) => setTaskInput(e.target.value)}
          rows={2}
          className="w-full resize-y rounded-md border border-edge bg-surface-raised px-2 py-1.5 text-xs text-fg focus:border-primary-500 focus:outline-none"
        />
      </div>

      <div className="flex flex-wrap items-end gap-3">
        {(
          [
            ['max_tokens', t('workflow.budgetTokens')],
            ['concurrency', t('workflow.budgetConcurrency')],
          ] as const
        ).map(([key, label]) => (
          <label key={key} className="text-[10px] text-fg-faint">
            <span className="mb-1 block font-semibold uppercase tracking-wider">{label}</span>
            <input
              type="number"
              min={1}
              value={budget[key]}
              onChange={(e) => setBudget({ ...budget, [key]: Number(e.target.value) || budget[key] })}
              className="w-28 rounded-md border border-edge bg-surface-raised px-2 py-1 text-xs text-fg focus:border-primary-500 focus:outline-none"
            />
          </label>
        ))}
        <Button size="sm" variant="ghost" onClick={onDismiss} className="ml-auto">
          {t('workflow.planDismiss')}
        </Button>
        <Button
          size="sm"
          onClick={onConfirm}
          // Confirming with unsaved edits would run the previously saved graph.
          disabled={confirming || dirty || taskInput.trim().length === 0}
          title={dirty ? t('workflow.saveGraphFirst') : undefined}
        >
          {confirming ? t('workflow.confirming') : t('workflow.confirm')}
        </Button>
      </div>
      <p className="text-[10px] text-fg-faint">{dirty ? t('workflow.saveGraphFirst') : t('workflow.confirmHint')}</p>
    </div>
  );
}

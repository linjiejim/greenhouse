/**
 * Plan-time node editor — the graph is only editable BEFORE confirmation.
 *
 * Everything here is a pre-flight edit of the definition: which agent runs the
 * node, what it is asked to do, and what it waits on. Saving PATCHes the whole
 * graph (version+1); the server re-validates it, so the client-side guards
 * below are only there to keep obviously-broken options out of the UI.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Trash2 } from '../../lib/icons';
import type { WorkflowGraph, WorkflowNode } from '@greenhouse/types/workflow';
import { WORKFLOW_ROLE_ADDENDUM_MAX_CHARS } from '@greenhouse/types/workflow';
import { useProfileStore } from '../../stores';
import { useT } from '../../lib/i18n';

/** Node ids reachable FROM `nodeId` — depending on any of them would close a cycle. */
export function descendantsOf(nodes: WorkflowNode[], nodeId: string): Set<string> {
  const out = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes) {
      if (out.has(n.id)) continue;
      if ((n.depends_on ?? []).some((d) => d === nodeId || out.has(d))) {
        out.add(n.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Remove a node and every reference to it from the remaining `depends_on` lists. */
export function removeNode(graph: WorkflowGraph, nodeId: string): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => ({ ...n, depends_on: (n.depends_on ?? []).filter((d) => d !== nodeId) })),
  };
}

export function NodeEditor({
  graph,
  node,
  onChange,
  onDelete,
  saving,
}: {
  graph: WorkflowGraph;
  node: WorkflowNode;
  onChange: (next: WorkflowNode) => void;
  onDelete: () => void;
  saving: boolean;
}) {
  const t = useT();
  const profiles = useProfileStore((s) => s.profiles);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isDeliverable = graph.deliverable_node === node.id;

  const candidates = useMemo(() => {
    const blocked = descendantsOf(graph.nodes, node.id);
    return graph.nodes.filter((n) => n.id !== node.id && !blocked.has(n.id));
  }, [graph.nodes, node.id]);

  const toggleDep = useCallback(
    (depId: string) => {
      const current = node.depends_on ?? [];
      const next = current.includes(depId) ? current.filter((d) => d !== depId) : [...current, depId];
      onChange({ ...node, depends_on: next });
    },
    [node, onChange],
  );

  // The planner may bind a node to a profile the picker does not list (custom or
  // hidden) — keep it selectable so editing another field cannot silently drop it.
  const agentOptions = profiles.some((p) => p.id === node.agent)
    ? profiles
    : [{ id: node.agent, name: node.agent }, ...profiles];

  return (
    <div className="space-y-2 rounded-md border border-primary-500/40 bg-surface-sunken px-2.5 py-2">
      <div className="flex items-center gap-1.5">
        <span className="text-xs font-semibold text-fg">{node.id}</span>
        {isDeliverable && (
          <span className="rounded bg-primary-subtle px-1 py-px text-[9px] text-primary-fg-strong">
            {t('workflow.deliverable')}
          </span>
        )}
        <div className="ml-auto">
          {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={onDelete}
                disabled={saving}
                className="rounded-md border border-danger/40 px-1.5 py-0.5 text-[10px] text-danger hover:bg-danger-subtle disabled:opacity-50"
              >
                {t('workflow.confirmDelete')}
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-fg-secondary hover:bg-surface-muted"
              >
                {t('common.cancel')}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              disabled={isDeliverable || saving}
              title={isDeliverable ? t('workflow.deliverableNotDeletable') : t('workflow.deleteNode')}
              className="inline-flex items-center gap-1 rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-fg-secondary transition-colors hover:bg-surface-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Trash2 size={11} />
              {t('workflow.deleteNode')}
            </button>
          )}
        </div>
      </div>

      <Labeled label={t('workflow.editAgent')}>
        <select
          value={node.agent}
          onChange={(e) => onChange({ ...node, agent: e.target.value })}
          className="w-full rounded-md border border-edge bg-surface-raised px-2 py-1 text-[11px] text-fg focus:border-primary-500 focus:outline-none"
        >
          {agentOptions.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.id})
            </option>
          ))}
        </select>
      </Labeled>

      <Labeled label={t('workflow.editObjective')}>
        <textarea
          value={node.brief.objective}
          onChange={(e) => onChange({ ...node, brief: { ...node.brief, objective: e.target.value } })}
          rows={3}
          className="w-full resize-y rounded-md border border-edge bg-surface-raised px-2 py-1 text-[11px] leading-relaxed text-fg focus:border-primary-500 focus:outline-none"
        />
      </Labeled>

      <Labeled label={t('workflow.editAddendum')}>
        <input
          value={node.role_addendum ?? ''}
          maxLength={WORKFLOW_ROLE_ADDENDUM_MAX_CHARS}
          placeholder={t('workflow.editAddendumHint')}
          onChange={(e) => onChange({ ...node, role_addendum: e.target.value || undefined })}
          className="w-full rounded-md border border-edge bg-surface-raised px-2 py-1 text-[11px] text-fg focus:border-primary-500 focus:outline-none"
        />
      </Labeled>

      <Labeled label={t('workflow.editDepends')}>
        {candidates.length === 0 ? (
          <div className="text-[10px] text-fg-faint">{t('workflow.editNoDepends')}</div>
        ) : (
          <div className="flex flex-wrap gap-1">
            {candidates.map((cand) => {
              const on = (node.depends_on ?? []).includes(cand.id);
              return (
                <button
                  key={cand.id}
                  onClick={() => toggleDep(cand.id)}
                  className={`rounded-md border px-1.5 py-0.5 text-[10px] transition-colors ${
                    on
                      ? 'border-primary-500 bg-primary-subtle text-primary-fg-strong'
                      : 'border-edge bg-surface-raised text-fg-secondary hover:bg-surface-muted'
                  }`}
                >
                  {on ? '✓ ' : ''}
                  {cand.id}
                </button>
              );
            })}
          </div>
        )}
      </Labeled>
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[9px] font-semibold uppercase tracking-wider text-fg-faint">{label}</span>
      {children}
    </label>
  );
}

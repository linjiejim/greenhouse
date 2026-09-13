/**
 * Workflow DAG canvas — layered left→right, one column per dependency depth.
 *
 * Edges are drawn in a single absolutely-positioned SVG; nodes are real DOM
 * elements on top of it, so truncation, hover, focus rings and i18n text all
 * behave like the rest of the UI. Geometry comes from `layout.ts` (unit-tested
 * separately) — this file only paints.
 */

import React from 'react';
import type { WorkflowGraph, WorkflowNodeRunStatus } from '@greenhouse/types/workflow';
import { layoutGraph, NODE_H, NODE_W } from './layout';

export type NodeStatusOf = (nodeId: string) => WorkflowNodeRunStatus | undefined;

const NODE_STYLE: Record<string, string> = {
  running: 'border-primary-500 bg-primary-subtle text-fg shadow-sm',
  passed: 'border-success/50 bg-success-subtle/60 text-fg',
  failed: 'border-danger/60 bg-danger-subtle/60 text-fg',
  returned: 'border-warning/60 bg-warning-subtle/50 text-fg',
  awaiting_gate: 'border-warning/70 bg-warning-subtle/60 text-fg',
  skipped: 'border-dashed border-edge bg-surface-raised text-fg-faint',
  pending: 'border-edge bg-surface-raised text-fg-muted',
};

const STATUS_MARK: Record<string, string> = {
  passed: '✓',
  failed: '✗',
  returned: '↩',
  awaiting_gate: '⏸',
  skipped: '⤼',
};

export function WorkflowGraphCanvas({
  graph,
  statusOf,
  selectedNodeId,
  onSelect,
  deliverableLabel,
}: {
  graph: WorkflowGraph;
  statusOf?: NodeStatusOf;
  selectedNodeId?: string | null;
  onSelect?: (nodeId: string) => void;
  deliverableLabel: string;
}) {
  const layout = React.useMemo(() => layoutGraph(graph), [graph]);
  if (layout.nodes.length === 0) return null;

  const satisfied = (id: string) => {
    const s = statusOf?.(id);
    return s === 'passed' || s === 'skipped';
  };

  return (
    <div className="overflow-x-auto">
      <div className="relative" style={{ width: layout.width, height: layout.height }}>
        <svg
          width={layout.width}
          height={layout.height}
          className="absolute inset-0 pointer-events-none"
          aria-hidden="true"
        >
          {layout.edges.map((edge) => {
            const done = satisfied(edge.from);
            const feeding = statusOf?.(edge.to) === 'running';
            return (
              <path
                key={`${edge.from}->${edge.to}`}
                d={edge.path}
                fill="none"
                strokeWidth={done || feeding ? 1.75 : 1.25}
                strokeDasharray={feeding ? '5 4' : undefined}
                className={
                  feeding
                    ? 'stroke-primary-500 animate-workflow-flow'
                    : done
                      ? 'stroke-success/60'
                      : 'stroke-edge-strong'
                }
              />
            );
          })}
        </svg>

        {layout.nodes.map(({ node, x, y }) => {
          const status = statusOf?.(node.id);
          const selected = selectedNodeId === node.id;
          const isDeliverable = graph.deliverable_node === node.id;
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => onSelect?.(node.id)}
              aria-pressed={selected}
              title={node.brief.objective}
              style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
              className={`absolute flex flex-col justify-center gap-0.5 rounded-lg border px-2 text-left transition-shadow ${
                NODE_STYLE[status ?? 'pending'] ?? NODE_STYLE.pending
              } ${selected ? 'ring-2 ring-primary-500 ring-offset-1 ring-offset-surface-sunken' : 'hover:shadow-md'}`}
            >
              <div className="flex items-center gap-1">
                {status === 'running' ? (
                  <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-primary-500" />
                ) : (
                  status &&
                  STATUS_MARK[status] && (
                    <span className="flex-shrink-0 text-[10px] leading-none">{STATUS_MARK[status]}</span>
                  )
                )}
                <span className="truncate text-[11px] font-medium">{node.id}</span>
              </div>
              <div className="flex items-center gap-1 overflow-hidden">
                <span className="flex-shrink-0 rounded bg-surface-muted px-1 py-px text-[9px] text-fg-faint">
                  {node.agent}
                </span>
                {isDeliverable && (
                  <span className="flex-shrink-0 rounded bg-primary-subtle px-1 py-px text-[9px] text-primary-fg-strong">
                    {deliverableLabel}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

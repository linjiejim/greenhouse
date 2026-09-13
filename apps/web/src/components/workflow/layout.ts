/**
 * DAG layout for the workflow canvas — pure geometry, no rendering.
 *
 * Layered left→right: a node sits one column right of its deepest dependency,
 * so nodes that can run in parallel share a column. Graphs are capped at 15
 * nodes (WORKFLOW_BUDGET_LIMITS.max_nodes), which is why a hand-rolled longest-
 * path layering is enough and no general layout engine is pulled in (D12).
 *
 * The graph is validated server-side (acyclic, deps exist), but layering is
 * written to terminate on malformed input anyway — the canvas must never hang.
 */

import type { WorkflowGraph, WorkflowNode } from '@greenhouse/types/workflow';

export const NODE_W = 172;
export const NODE_H = 54;
const GAP_X = 60;
const GAP_Y = 16;
const PAD = 14;

export interface LaidOutNode {
  node: WorkflowNode;
  layer: number;
  x: number;
  y: number;
}

export interface LaidOutEdge {
  from: string;
  to: string;
  /** SVG cubic-bezier `d` attribute. */
  path: string;
}

export interface GraphLayout {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/** Longest-path layering: layer(n) = 0 if no deps, else 1 + max(layer(deps)). */
export function computeLayers(nodes: WorkflowNode[]): Map<string, number> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const layers = new Map<string, number>();

  const visit = (id: string, seen: Set<string>): number => {
    const cached = layers.get(id);
    if (cached !== undefined) return cached;
    // Cycle or dangling dep (server-rejected, but keep the canvas alive).
    if (seen.has(id)) return 0;
    const node = byId.get(id);
    if (!node) return 0;
    seen.add(id);
    const deps = (node.depends_on ?? []).filter((d) => byId.has(d));
    const layer = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((d) => visit(d, seen)));
    seen.delete(id);
    layers.set(id, layer);
    return layer;
  };

  for (const n of nodes) visit(n.id, new Set());
  return layers;
}

export function layoutGraph(graph: WorkflowGraph): GraphLayout {
  const nodes = graph.nodes ?? [];
  if (nodes.length === 0) return { nodes: [], edges: [], width: 0, height: 0 };

  const layers = computeLayers(nodes);
  const columns = new Map<number, WorkflowNode[]>();
  for (const node of nodes) {
    const layer = layers.get(node.id) ?? 0;
    const col = columns.get(layer);
    if (col) col.push(node);
    else columns.set(layer, [node]);
  }

  const layerCount = Math.max(...columns.keys()) + 1;
  const tallest = Math.max(...[...columns.values()].map((c) => c.length));
  const height = PAD * 2 + tallest * NODE_H + (tallest - 1) * GAP_Y;
  const width = PAD * 2 + layerCount * NODE_W + (layerCount - 1) * GAP_X;

  const placed: LaidOutNode[] = [];
  const positions = new Map<string, LaidOutNode>();
  for (const [layer, col] of columns) {
    // Center each column vertically against the tallest one.
    const colHeight = col.length * NODE_H + (col.length - 1) * GAP_Y;
    const top = PAD + (height - PAD * 2 - colHeight) / 2;
    col.forEach((node, i) => {
      const entry: LaidOutNode = {
        node,
        layer,
        x: PAD + layer * (NODE_W + GAP_X),
        y: top + i * (NODE_H + GAP_Y),
      };
      placed.push(entry);
      positions.set(node.id, entry);
    });
  }

  const edges: LaidOutEdge[] = [];
  for (const node of nodes) {
    for (const dep of node.depends_on ?? []) {
      const from = positions.get(dep);
      const to = positions.get(node.id);
      if (!from || !to) continue;
      const x1 = from.x + NODE_W;
      const y1 = from.y + NODE_H / 2;
      const x2 = to.x;
      const y2 = to.y + NODE_H / 2;
      const dx = Math.max(24, (x2 - x1) / 2);
      edges.push({ from: dep, to: node.id, path: `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}` });
    }
  }

  return { nodes: placed, edges, width, height };
}

import { describe, it, expect } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@greenhouse/types/workflow';
import { computeLayers, layoutGraph, NODE_W, NODE_H } from './layout';

function node(id: string, deps?: string[]): WorkflowNode {
  return { id, agent: 'team', brief: { objective: `do ${id}` }, depends_on: deps };
}

function graph(nodes: WorkflowNode[], deliverable = nodes.at(-1)!.id): WorkflowGraph {
  return { nodes, deliverable_node: deliverable };
}

describe('computeLayers', () => {
  it('puts every dependency-free node in layer 0', () => {
    const layers = computeLayers([node('a'), node('b'), node('c', ['a'])]);
    expect(layers.get('a')).toBe(0);
    expect(layers.get('b')).toBe(0);
    expect(layers.get('c')).toBe(1);
  });

  it('layers a chain sequentially', () => {
    const layers = computeLayers([node('a'), node('b', ['a']), node('c', ['b'])]);
    expect([layers.get('a'), layers.get('b'), layers.get('c')]).toEqual([0, 1, 2]);
  });

  it('uses the DEEPEST dependency (diamond joins at the far side)', () => {
    // a → b → d, a → c → … so d must sit after the longest path, not the first.
    const layers = computeLayers([node('a'), node('b', ['a']), node('c', ['b']), node('d', ['a', 'c'])]);
    expect(layers.get('d')).toBe(3);
  });

  it('is order-independent (definition order does not affect layers)', () => {
    const forward = computeLayers([node('a'), node('b', ['a']), node('c', ['b'])]);
    const reversed = computeLayers([node('c', ['b']), node('b', ['a']), node('a')]);
    expect([...reversed.entries()].sort()).toEqual([...forward.entries()].sort());
  });

  it('terminates on a cycle instead of hanging', () => {
    const layers = computeLayers([node('a', ['b']), node('b', ['a'])]);
    expect(layers.size).toBe(2);
  });

  it('ignores dangling dependencies', () => {
    const layers = computeLayers([node('a', ['ghost'])]);
    expect(layers.get('a')).toBe(0);
  });
});

describe('layoutGraph', () => {
  it('returns an empty layout for an empty graph', () => {
    expect(layoutGraph({ nodes: [], deliverable_node: '' })).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });

  it('places parallel nodes in the same column and dependents to the right', () => {
    const layout = layoutGraph(graph([node('a'), node('b'), node('c', ['a', 'b'])]));
    const at = (id: string) => layout.nodes.find((n) => n.node.id === id)!;
    expect(at('a').x).toBe(at('b').x);
    expect(at('a').y).not.toBe(at('b').y);
    expect(at('c').x).toBeGreaterThan(at('a').x);
  });

  it('emits one edge per dependency with a cubic path', () => {
    const layout = layoutGraph(graph([node('a'), node('b'), node('c', ['a', 'b'])]));
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.every((e) => e.to === 'c')).toBe(true);
    expect(layout.edges[0]!.path).toMatch(/^M[\d.-]+,[\d.-]+ C/);
  });

  it('sizes the canvas to fit every node', () => {
    const layout = layoutGraph(graph([node('a'), node('b'), node('c', ['a', 'b'])]));
    for (const n of layout.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(layout.width);
      expect(n.y + NODE_H).toBeLessThanOrEqual(layout.height);
    }
  });

  it('centers a short column against the tallest one', () => {
    const layout = layoutGraph(graph([node('a'), node('b'), node('c', ['a', 'b'])]));
    const c = layout.nodes.find((n) => n.node.id === 'c')!;
    expect(c.y + NODE_H / 2).toBeCloseTo(layout.height / 2, 5);
  });
});

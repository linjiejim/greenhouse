import { describe, it, expect } from 'vitest';
import type { WorkflowGraph, WorkflowNode } from '@greenhouse/types/workflow';
import { descendantsOf, removeNode } from './node-editor';

function node(id: string, deps?: string[]): WorkflowNode {
  return { id, agent: 'team', brief: { objective: id }, depends_on: deps };
}

const CHAIN: WorkflowNode[] = [node('a'), node('b', ['a']), node('c', ['b'])];

describe('descendantsOf', () => {
  it('collects transitive dependents', () => {
    expect([...descendantsOf(CHAIN, 'a')].sort()).toEqual(['b', 'c']);
    expect([...descendantsOf(CHAIN, 'b')].sort()).toEqual(['c']);
    expect([...descendantsOf(CHAIN, 'c')]).toEqual([]);
  });

  it('never includes the node itself (self-dependency is caught elsewhere)', () => {
    expect(descendantsOf(CHAIN, 'a').has('a')).toBe(false);
  });

  it('handles a diamond without double counting', () => {
    const diamond = [node('root'), node('l', ['root']), node('r', ['root']), node('join', ['l', 'r'])];
    expect([...descendantsOf(diamond, 'root')].sort()).toEqual(['join', 'l', 'r']);
  });
});

describe('removeNode', () => {
  it('drops the node and every reference to it', () => {
    const graph: WorkflowGraph = { nodes: CHAIN, deliverable_node: 'c' };
    const next = removeNode(graph, 'b');
    expect(next.nodes.map((n) => n.id)).toEqual(['a', 'c']);
    expect(next.nodes.find((n) => n.id === 'c')!.depends_on).toEqual([]);
  });

  it('leaves unrelated dependencies intact', () => {
    const graph: WorkflowGraph = {
      nodes: [node('a'), node('b'), node('c', ['a', 'b'])],
      deliverable_node: 'c',
    };
    const next = removeNode(graph, 'b');
    expect(next.nodes.find((n) => n.id === 'c')!.depends_on).toEqual(['a']);
  });
});

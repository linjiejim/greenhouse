/**
 * Graph definition validation — structure, cycles, references, budget caps.
 */

import { describe, it, expect } from 'vitest';
import type { WorkflowGraph } from '@greenhouse/types/workflow';
import { validateWorkflowGraph, parseWorkflowGraph, topoOrder, ancestorsOf } from '../graph.js';

function makeGraph(overrides: Partial<WorkflowGraph> = {}): WorkflowGraph {
  return {
    nodes: [
      { id: 'research', agent: 'team', brief: { objective: '调研市场' } },
      {
        id: 'draft',
        agent: 'team',
        brief: { objective: '起草报告', inputs: { findings: '$nodes.research.outputs' } },
        depends_on: ['research'],
      },
      {
        id: 'deliver',
        agent: 'team',
        brief: { objective: '交付', inputs: { doc: '$nodes.draft.outputs.doc', task: '$run.input' } },
        depends_on: ['draft'],
      },
    ],
    deliverable_node: 'deliver',
    ...overrides,
  };
}

describe('validateWorkflowGraph', () => {
  it('accepts a valid linear graph', () => {
    expect(validateWorkflowGraph(makeGraph())).toEqual([]);
  });

  it('accepts snake_case node ids, in the schema AND in references', () => {
    // Models reach for snake_case first, and the id charset used to be written
    // out three times — the schema, the resolver, and this validator. Widening
    // only two of them turned "rejected" into the worse failure of a reference
    // that validates in one place and is treated as a literal in another, so
    // this asserts a graph that exercises both at once.
    const g: WorkflowGraph = {
      nodes: [
        { id: 'research_clickgrow', agent: 'team', brief: { objective: '调研' } },
        {
          id: 'synthesis',
          agent: 'team',
          brief: { objective: '汇总', inputs: { cg: '$nodes.research_clickgrow.outputs.price' } },
          depends_on: ['research_clickgrow'],
        },
      ],
      deliverable_node: 'synthesis',
    };
    expect(validateWorkflowGraph(g)).toEqual([]);
  });

  it('rejects empty node list and missing deliverable', () => {
    expect(validateWorkflowGraph({ nodes: [], deliverable_node: 'x' })).not.toEqual([]);
    const g = makeGraph({ deliverable_node: 'nope' });
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/deliverable/);
  });

  it('rejects duplicate node ids', () => {
    const g = makeGraph();
    g.nodes.push({ id: 'research', agent: 'team', brief: { objective: 'dup' } });
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/duplicate/i);
  });

  it('rejects unknown depends_on targets', () => {
    const g = makeGraph();
    g.nodes[1]!.depends_on = ['ghost'];
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/ghost/);
  });

  it('rejects cycles', () => {
    const g = makeGraph();
    g.nodes[0]!.depends_on = ['deliver'];
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/cycle/i);
  });

  it('rejects a deliverable node that has dependents (not a sink)', () => {
    const g = makeGraph({ deliverable_node: 'draft' });
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/sink|dependents/i);
  });

  it('rejects blackboard references to nodes that are not ancestors', () => {
    const g = makeGraph();
    // 'research' referencing 'draft' (its own dependent) is not allowed
    g.nodes[0]!.brief.inputs = { x: '$nodes.draft.outputs' };
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/ancestor/i);
  });

  it('enforces role_addendum length and node count budget', () => {
    const g = makeGraph();
    g.nodes[0]!.role_addendum = 'x'.repeat(501);
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/role_addendum/);

    const big = makeGraph({ budget: { max_nodes: 2 } });
    expect(validateWorkflowGraph(big).join(' ')).toMatch(/max_nodes/);
  });

  it('enforces policy limits', () => {
    const g = makeGraph();
    g.nodes[0]!.policy = { max_steps: 99 };
    expect(validateWorkflowGraph(g).join(' ')).toMatch(/max_steps/);
  });
});

describe('parseWorkflowGraph', () => {
  it('parses a JSON string and throws with readable errors on invalid input', () => {
    const parsed = parseWorkflowGraph(JSON.stringify(makeGraph()));
    expect(parsed.nodes).toHaveLength(3);
    expect(() => parseWorkflowGraph('{"nodes": "nope"}')).toThrow();
    expect(() => parseWorkflowGraph(JSON.stringify(makeGraph({ deliverable_node: 'ghost' })))).toThrow(/deliverable/);
  });
});

describe('topoOrder / ancestorsOf', () => {
  it('orders dependencies before dependents', () => {
    const order = topoOrder(makeGraph());
    expect(order.indexOf('research')).toBeLessThan(order.indexOf('draft'));
    expect(order.indexOf('draft')).toBeLessThan(order.indexOf('deliver'));
  });

  it('computes transitive ancestors', () => {
    expect(ancestorsOf(makeGraph(), 'deliver')).toEqual(new Set(['research', 'draft']));
    expect(ancestorsOf(makeGraph(), 'research')).toEqual(new Set());
  });
});

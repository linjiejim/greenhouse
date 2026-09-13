/**
 * Blackboard reference resolution — how node inputs read upstream outputs.
 */

import { describe, it, expect } from 'vitest';
import { NODE_ID_PATTERN, resolveInputs } from '../blackboard.js';

const ctx = {
  taskInput: '为 LPH64 写上市方案',
  outputs: new Map<string, unknown>([
    ['research', { market: { size: 'large', regions: ['EU', 'US'] }, score: 8 }],
    ['skipped-node', null],
    ['research_clickgrow', { price: 99 }],
  ]),
};

describe('resolveInputs', () => {
  it('resolves $run.input to the task statement', () => {
    const { resolved, errors } = resolveInputs({ task: '$run.input' }, ctx);
    expect(errors).toEqual([]);
    expect(resolved.task).toBe('为 LPH64 写上市方案');
  });

  it('resolves whole-output and dot-path references', () => {
    const { resolved, errors } = resolveInputs(
      { all: '$nodes.research.outputs', size: '$nodes.research.outputs.market.size' },
      ctx,
    );
    expect(errors).toEqual([]);
    expect(resolved.all).toEqual({ market: { size: 'large', regions: ['EU', 'US'] }, score: 8 });
    expect(resolved.size).toBe('large');
  });

  it('resolves references to snake_case node ids', () => {
    // The reference regex and the graph schema's id rule are two copies of one
    // charset. When they disagree the failure is silent, not loud: the schema
    // accepts the node, this regex does not match, and the reference is handed
    // to the node as the literal string "$nodes.research_clickgrow.outputs.price".
    expect(NODE_ID_PATTERN.test('research_clickgrow')).toBe(true);
    const { resolved, errors } = resolveInputs({ price: '$nodes.research_clickgrow.outputs.price' }, ctx);
    expect(errors).toEqual([]);
    expect(resolved.price).toBe(99);
  });

  it('passes literals untouched', () => {
    const { resolved, errors } = resolveInputs({ note: '直接给的字面值' }, ctx);
    expect(errors).toEqual([]);
    expect(resolved.note).toBe('直接给的字面值');
  });

  it('reports unknown node / missing path as errors', () => {
    const { errors } = resolveInputs({ a: '$nodes.ghost.outputs', b: '$nodes.research.outputs.no.such' }, ctx);
    expect(errors.join(' ')).toMatch(/ghost/);
    expect(errors.join(' ')).toMatch(/no\.such/);
  });

  it('resolves a skipped upstream (null outputs) to null without error', () => {
    const { resolved, errors } = resolveInputs({ x: '$nodes.skipped-node.outputs' }, ctx);
    expect(errors).toEqual([]);
    expect(resolved.x).toBeNull();
  });
});

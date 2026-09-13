import { describe, expect, it } from 'vitest';
import { resolveUrlContext } from './agent-context';

describe('Agent Execution Center route context', () => {
  it('resolves the Execution Center list and canonical kind/id detail routes', () => {
    expect(resolveUrlContext('#/executions')).toEqual({
      type: 'execution-center',
      runKind: undefined,
      runId: undefined,
    });
    expect(resolveUrlContext('#/executions/mission/run%2F42')).toEqual({
      type: 'execution-center',
      runKind: 'mission',
      runId: 'run/42',
    });
  });

  it('keeps a legacy kind-less detail usable without inventing a Runtime kind', () => {
    expect(resolveUrlContext('#/executions/run-1')).toEqual({
      type: 'execution-center',
      runKind: undefined,
      runId: 'run-1',
    });
  });
});

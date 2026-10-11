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

describe('Agent app-page route context', () => {
  it('gives the app center no page context', () => {
    expect(resolveUrlContext('#/apps')).toBeNull();
  });

  it('resolves an app page, its home, and the builder', () => {
    expect(resolveUrlContext('#/apps/12')).toEqual({ type: 'app-page', appId: 12, mode: 'use', pageId: undefined });
    expect(resolveUrlContext('#/apps/12/approvals?record=4')).toEqual({
      type: 'app-page',
      appId: 12,
      mode: 'use',
      pageId: 'approvals',
    });
    expect(resolveUrlContext('#/apps/12/edit')).toEqual({ type: 'app-page', appId: 12, mode: 'build' });
  });

  it('gives a malformed app address no context instead of a broken one', () => {
    expect(resolveUrlContext('#/apps/abc')).toBeNull();
    expect(resolveUrlContext('#/apps/0/edit')).toBeNull();
  });
});

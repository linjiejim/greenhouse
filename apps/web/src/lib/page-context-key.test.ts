import { describe, expect, it } from 'vitest';
import { pageContextKey } from './page-context-key';

describe('pageContextKey', () => {
  it('distinguishes a new Chat surface from a persisted session', () => {
    expect(pageContextKey({ type: 'chat' })).toBe('chat:');
    expect(pageContextKey({ type: 'chat', sessionId: 'session-1' })).toBe('chat:session-1');
  });

  it('rotates when a route-scoped entity changes', () => {
    expect(pageContextKey({ type: 'project-detail', projectId: 1 })).not.toBe(
      pageContextKey({ type: 'project-detail', projectId: 2 }),
    );
  });

  it('rotates between Execution Center and each durable run detail', () => {
    expect(pageContextKey({ type: 'execution-center' })).toBe('execution-center::');
    expect(pageContextKey({ type: 'execution-center', runKind: 'mission', runId: 'run-1' })).toBe(
      'execution-center:mission:run-1',
    );
  });
});

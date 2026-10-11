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

  it('rotates between apps, their pages and the builder of the same app', () => {
    const page = pageContextKey({ type: 'app-page', appId: 3, mode: 'use', pageId: 'orders' });
    expect(page).toBe('app-page:3:use:orders');
    expect(pageContextKey({ type: 'app-page', appId: 3, mode: 'use', pageId: 'stats' })).not.toBe(page);
    expect(pageContextKey({ type: 'app-page', appId: 4, mode: 'use', pageId: 'orders' })).not.toBe(page);
    expect(pageContextKey({ type: 'app-page', appId: 3, mode: 'build' })).toBe('app-page:3:build:');
    // Enrichment (names, role) never rotates the key — only the route does.
    expect(
      pageContextKey({ type: 'app-page', appId: 3, mode: 'use', appName: 'Procurement', roleName: 'Approver' }),
    ).toBe(pageContextKey({ type: 'app-page', appId: 3, mode: 'use' }));
  });

  it('rotates between Execution Center and each durable run detail', () => {
    expect(pageContextKey({ type: 'execution-center' })).toBe('execution-center::');
    expect(pageContextKey({ type: 'execution-center', runKind: 'mission', runId: 'run-1' })).toBe(
      'execution-center:mission:run-1',
    );
  });
});

import { describe, expect, it } from 'vitest';

import { matchKnowledgeAction } from './http-adapter.js';

describe('Knowledge HTTP capability map', () => {
  it.each([
    ['GET', '/api/knowledge/docs/templates', 'listDocuments'],
    ['GET', '/api/knowledge/docs/id/12', 'readDocument'],
    ['POST', '/api/knowledge/docs/12/editing-presence', 'updateDocument'],
    ['POST', '/api/knowledge/tree/reorder', 'updateDocument'],
    ['GET', '/api/knowledge/export', 'listDocuments'],
  ])('maps %s %s to %s', (method, path, actionId) => {
    expect(matchKnowledgeAction(method, path)?.actionId).toBe(actionId);
  });

  it('marks routes that share updateDocument with the kind of change they make', () => {
    expect(matchKnowledgeAction('POST', '/api/knowledge/docs/12/editing-presence')?.change).toBe('presence');
    expect(matchKnowledgeAction('PUT', '/api/knowledge/docs/12')?.change).toBeUndefined();
  });

  it('leaves unknown routes unmatched for the middleware fail-closed branch', () => {
    expect(matchKnowledgeAction('GET', '/api/knowledge/new-unregistered-route')).toBeUndefined();
  });
});

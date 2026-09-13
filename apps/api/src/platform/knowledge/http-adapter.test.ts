import { describe, expect, it } from 'vitest';

import { matchKnowledgeAction } from './http-adapter.js';

describe('Knowledge HTTP capability map', () => {
  it.each([
    ['GET', '/api/knowledge/docs/templates', 'listDocuments'],
    ['GET', '/api/knowledge/docs/id/12', 'readDocument'],
    ['GET', '/api/knowledge/docs/12/backlinks', 'readDocument'],
    ['GET', '/api/knowledge/docs/12/comments', 'readDocument'],
    ['POST', '/api/knowledge/docs/12/comments', 'updateDocument'],
    ['DELETE', '/api/knowledge/comments/7', 'updateDocument'],
    ['POST', '/api/knowledge/docs/12/editing-presence', 'updateDocument'],
    ['POST', '/api/knowledge/tree/reorder', 'updateDocument'],
    ['GET', '/api/knowledge/export', 'listDocuments'],
  ])('maps %s %s to %s', (method, path, actionId) => {
    expect(matchKnowledgeAction(method, path)?.actionId).toBe(actionId);
  });

  it('leaves unknown routes unmatched for the middleware fail-closed branch', () => {
    expect(matchKnowledgeAction('GET', '/api/knowledge/new-unregistered-route')).toBeUndefined();
  });
});

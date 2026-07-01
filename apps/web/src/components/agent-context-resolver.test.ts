/**
 * GUARD + BEHAVIOR TEST — the Global-Agent URL→PageContext fork extension point.
 *
 * Core routes still resolve; an unregistered fork route resolves to null upstream;
 * a fork-registered resolver maps its private route to a PageContext — all without
 * editing agent-context.tsx.
 */

import { describe, it, expect } from 'vitest';
import { resolveUrlContext } from './agent-context';
import { registerUrlContextResolver } from '../lib/context-resolvers';

describe('URL context resolver extension seam', () => {
  it('core routes still resolve', () => {
    expect(resolveUrlContext('#/chat?session=abc')).toEqual({ type: 'chat', sessionId: 'abc' });
    expect(resolveUrlContext('#/projects/7')).toEqual({ type: 'project-detail', projectId: 7 });
  });

  it('an unregistered fork route resolves to null upstream', () => {
    expect(resolveUrlContext('#/crm/42')).toBeNull();
  });

  it('a fork resolver maps its private route to a PageContext', () => {
    registerUrlContextResolver('crm', (subPath) => ({ type: 'crm', module: subPath || undefined }));
    expect(resolveUrlContext('#/crm/customers')).toEqual({ type: 'crm', module: 'customers' });
  });
});

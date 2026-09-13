/**
 * usePageActions — declare the agent's available actions for the current page.
 *
 * Declares what the agent can do on this screen. Registers on mount / deps change,
 * unregisters on unmount,
 * so the agent only ever sees actions for the screen the user is actually on.
 *
 * Usage:
 *   usePageActions([
 *     {
 *       name: 'crm_navigate',
 *       description: 'Open a CRM page or record for the user',
 *       parameters: { type: 'object', properties: { module: { type: 'string' } } },
 *       execute: ({ module }) => { window.location.hash = `#/crm/${module}`; },
 *     },
 *   ], [dealId]);
 */

import { useEffect, useState } from 'react';
import { registerClientAction } from '../lib/client-actions/registry';
import type { RegisteredClientAction } from '../lib/client-actions/registry';
import { pageActionScopeId } from '../lib/page-action-scope';

export function usePageActions(actions: RegisteredClientAction[], deps: unknown[] = []): void {
  const [scopeId, setScopeId] = useState(() => pageActionScopeId());

  useEffect(() => {
    const update = () => setScopeId(pageActionScopeId());
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, []);

  useEffect(() => {
    const unregisters = actions.map((action) => registerClientAction(scopeId, action));
    return () => unregisters.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeId, ...deps]);
}

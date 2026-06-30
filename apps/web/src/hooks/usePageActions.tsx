/**
 * usePageActions — declare the agent's available actions for the current page.
 *
 * Symmetric to usePageContext (which declares "what this screen IS"); this declares
 * "what this screen CAN DO". Registers on mount / deps change, unregisters on unmount,
 * so the agent only ever sees actions for the screen the user is actually on.
 *
 * Usage:
 *   usePageActions([
 *     {
 *       name: 'navigate',
 *       description: 'Open a page or record for the user',
 *       parameters: { type: 'object', properties: { module: { type: 'string' } } },
 *       execute: ({ module }) => { window.location.hash = `#/${module}`; },
 *     },
 *   ], [itemId]);
 */

import { useEffect } from 'react';
import { registerClientAction } from '../lib/client-actions/registry';
import type { RegisteredClientAction } from '../lib/client-actions/registry';

export function usePageActions(actions: RegisteredClientAction[], deps: unknown[] = []): void {
  useEffect(() => {
    const unregisters = actions.map(registerClientAction);
    return () => unregisters.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

/**
 * @vitest-environment happy-dom
 */

/**
 * Which client actions survive a navigation mid-turn.
 *
 * dev frictions 60/62–65: a browsing turn opened tabs and read two pages, then
 * every `browser_*` call — including a no-arg `list_tabs` — came back with "The
 * page context changed", permanently, across retries. The browser bridge is
 * registered globally and is not bound to any route, but execution expired it
 * with the page scope anyway, while `snapshotClientActions` kept advertising it
 * from every scope. The model was told it had a capability that was gone.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { GLOBAL_CLIENT_ACTION_SCOPE, registerClientAction } from './registry';
import { executeClientAction } from './executor';
import { pageActionScopeId } from '../page-action-scope';

function setHash(hash: string): void {
  window.location.hash = hash;
}

describe('executeClientAction scope handling', () => {
  beforeEach(() => {
    setHash('#/chat');
  });

  it('runs a global action after the route changed under it', async () => {
    const unregister = registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, {
      name: 'browser_list_tabs',
      description: 'List open browser tabs',
      parameters: { type: 'object' },
      execute: () => ({ tabs: [] }),
    });
    const scopeId = pageActionScopeId();

    setHash('#/knowledge');
    const result = await executeClientAction('call-1', 'browser_list_tabs', {}, scopeId);

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ tabs: [] });

    unregister();
  });

  it('still refuses a page action once its route is gone', async () => {
    const scopeId = pageActionScopeId();
    const unregister = registerClientAction(scopeId, {
      name: 'crm_navigate',
      description: 'Open a CRM page',
      parameters: { type: 'object' },
      execute: () => ({ navigated: true }),
    });

    setHash('#/knowledge');
    const result = await executeClientAction('call-2', 'crm_navigate', {}, scopeId);

    expect(result.output).toBeNull();
    expect(result.error).toContain('page context changed');

    unregister();
  });

  it('runs a page action while its route is still current', async () => {
    const scopeId = pageActionScopeId();
    const unregister = registerClientAction(scopeId, {
      name: 'crm_navigate',
      description: 'Open a CRM page',
      parameters: { type: 'object' },
      execute: () => ({ navigated: true }),
    });

    const result = await executeClientAction('call-3', 'crm_navigate', {}, scopeId);

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ navigated: true });

    unregister();
  });

  it('survives the session id landing in the URL mid-turn', async () => {
    // The exact sequence from the friction: the turn starts on `#/chat`, a new
    // session is created, and `replaceState` appends `?session=<id>`.
    const unregister = registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, {
      name: 'browser_read_page',
      description: 'Read the current page',
      parameters: { type: 'object' },
      execute: () => ({ text: 'ok' }),
    });
    const scopeId = pageActionScopeId();

    setHash('#/chat?session=1f0d2a');
    const result = await executeClientAction('call-4', 'browser_read_page', {}, scopeId);

    expect(result.error).toBeUndefined();
    expect(result.output).toEqual({ text: 'ok' });

    unregister();
  });

  it('reports an unregistered action as unknown rather than as a stale page', async () => {
    const result = await executeClientAction('call-5', 'nope', {}, pageActionScopeId());
    expect(result.error).toBe('Unknown client action: nope');
  });
});

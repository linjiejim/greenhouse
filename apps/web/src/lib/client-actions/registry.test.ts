import { describe, expect, it } from 'vitest';
import {
  GLOBAL_CLIENT_ACTION_SCOPE,
  getClientAction,
  registerClientAction,
  resolveClientAction,
  snapshotClientActions,
} from './registry';
import { isPageActionScopeActive, pageActionScopeId } from '../page-action-scope';

const action = {
  name: 'crm_navigate',
  description: 'Open a CRM page',
  parameters: { type: 'object' },
  execute: () => ({ ok: true }),
};

describe('page-scoped client action registry', () => {
  it('keeps same-named actions isolated by page scope', () => {
    const first = { ...action, execute: () => ({ page: 'companies' }) };
    const second = { ...action, execute: () => ({ page: 'deals' }) };
    const unregisterFirst = registerClientAction('page:crm/companies', first);
    const unregisterSecond = registerClientAction('page:crm/deals', second);

    expect(getClientAction('page:crm/companies', action.name)).toBe(first);
    expect(getClientAction('page:crm/deals', action.name)).toBe(second);
    expect(snapshotClientActions('page:crm/deals')).toEqual([
      {
        name: action.name,
        description: action.description,
        parameters: action.parameters,
      },
    ]);

    unregisterFirst();
    unregisterSecond();
  });

  it('treats an action scope as stale after navigation', () => {
    const oldScope = pageActionScopeId('#/crm/companies');
    expect(pageActionScopeId('#/crm/companies')).toBe(oldScope);
    expect(isPageActionScopeActive(oldScope, '#/crm/companies')).toBe(true);
    expect(isPageActionScopeActive(oldScope, '#/crm/deals')).toBe(false);
    expect(pageActionScopeId('#/crm/companies')).not.toBe(oldScope);
  });

  it('keeps one scope across a query-string change on the same route', () => {
    // Chat rewrites the URL to `#/chat?session=<id>` mid-turn as soon as a new
    // session exists. That annotates the page instance, it does not replace it,
    // so it must not rotate the scope out from under an in-flight turn.
    const scope = pageActionScopeId('#/chat');
    expect(pageActionScopeId('#/chat?session=abc')).toBe(scope);
    expect(isPageActionScopeActive(scope, '#/chat?session=abc')).toBe(true);
    expect(isPageActionScopeActive(scope, '#/knowledge')).toBe(false);
  });

  it('reports where an action was resolved from', () => {
    const globalAction = { ...action, name: 'browser_list_tabs' };
    const shadowing = { ...action, name: 'browser_list_tabs', execute: () => ({ page: true }) };
    const unregisterGlobal = registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, globalAction);

    expect(resolveClientAction('page:chat', globalAction.name)).toEqual({
      action: globalAction,
      origin: 'global',
    });

    // A page may shadow a global name, and that shadow is page-bound — which is
    // why origin comes from the lookup rather than from the name.
    const unregisterShadow = registerClientAction('page:chat', shadowing);
    expect(resolveClientAction('page:chat', globalAction.name)).toEqual({
      action: shadowing,
      origin: 'page',
    });

    unregisterShadow();
    unregisterGlobal();
  });

  it('advertises global capabilities through the active page scope', () => {
    const globalAction = { ...action, name: 'desktop_read_selection' };
    const unregister = registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, globalAction);

    expect(snapshotClientActions('page:chat')).toContainEqual({
      name: globalAction.name,
      description: globalAction.description,
      parameters: globalAction.parameters,
    });
    expect(getClientAction('page:chat', globalAction.name)).toBe(globalAction);

    unregister();
  });
});

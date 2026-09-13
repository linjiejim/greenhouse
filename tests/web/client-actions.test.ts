/**
 * Web client-action registry + executor — the browser half of the frontend-action
 * round-trip. Verifies pages can register actions, the agent panel can snapshot the
 * serializable descriptors, and an incoming request dispatches to the live handler
 * (with the confirm gate honored).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  registerClientAction,
  getClientAction,
  snapshotClientActions,
} from '../../apps/web/src/lib/client-actions/registry';
import { executeClientAction } from '../../apps/web/src/lib/client-actions/executor';
import { postClientActionResult } from '../../apps/web/src/lib/api/chat';
import { pageActionScopeId } from '../../apps/web/src/lib/page-action-scope';
import {
  onConfirmationChange,
  resolveConfirmation,
} from '../../apps/web/src/lib/client-actions/confirm-gate';

const navAction = {
  name: 'crm_navigate',
  description: 'open a CRM page',
  parameters: { type: 'object', properties: { module: { type: 'string' } }, required: ['module'] },
  safety: 'auto' as const,
  execute: (p: Record<string, unknown>) => ({ ok: true, navigatedTo: `#/crm/${String(p.module)}` }),
};
const unregisters: Array<() => void> = [];

function register(scopeId: string, action = navAction): () => void {
  const unregister = registerClientAction(scopeId, action);
  unregisters.push(unregister);
  return unregister;
}

function activeScope(): string {
  vi.stubGlobal('window', { location: { hash: '#/crm/deals' } });
  return pageActionScopeId('#/crm/deals');
}

/**
 * Answer whatever the confirm gate asks next.
 *
 * The gate is a promise queue rendered by `ActionConfirmDialog`, not
 * `window.confirm` — so a test has to play the user rather than stub a global.
 */
function answerNextConfirmation(allowed: boolean): () => void {
  const off = onConfirmationChange((prompt) => {
    if (prompt) resolveConfirmation(prompt.id, { allowed, rememberSite: false });
  });
  return off;
}

afterEach(() => {
  for (const unregister of unregisters.splice(0)) unregister();
  vi.unstubAllGlobals();
});

describe('client-action registry', () => {
  it('registers, looks up, and snapshots only the serializable fields', () => {
    const scopeId = activeScope();
    register(scopeId);
    expect(getClientAction(scopeId, 'crm_navigate')).toBe(navAction);
    expect(getClientAction(scopeId, 'nope')).toBeUndefined();

    const snap = snapshotClientActions(scopeId);
    const found = snap.find((a) => a.name === 'crm_navigate')!;
    expect(found).toEqual({
      name: navAction.name,
      description: navAction.description,
      parameters: navAction.parameters,
    });
    // execute / safety must NOT cross the wire.
    expect('execute' in found).toBe(false);
    expect('safety' in found).toBe(false);
  });

  it('unregister removes the action', () => {
    const scopeId = activeScope();
    const off = register(scopeId);
    expect(getClientAction(scopeId, 'crm_navigate')).toBe(navAction);
    off();
    expect(getClientAction(scopeId, 'crm_navigate')).toBeUndefined();
  });
});

describe('executeClientAction', () => {
  it('runs an auto action and returns its result keyed by toolCallId', async () => {
    const scopeId = activeScope();
    register(scopeId);
    const res = await executeClientAction('call-1', 'crm_navigate', { module: 'deals' }, scopeId);
    expect(res).toEqual({ toolCallId: 'call-1', output: { ok: true, navigatedTo: '#/crm/deals' } });
  });

  it('returns an error for an unknown action', async () => {
    const scopeId = activeScope();
    const res = await executeClientAction('call-2', 'ghost_action', {}, scopeId);
    expect(res.error).toMatch(/Unknown client action/);
    expect(res.output).toBeNull();
  });

  it('fails closed after the browser navigates away from the advertised scope', async () => {
    const scopeId = activeScope();
    register(scopeId);
    vi.stubGlobal('window', {
      location: { hash: '#/crm/companies' },
      confirm: () => true,
    });

    const res = await executeClientAction('call-stale', 'crm_navigate', { module: 'deals' }, scopeId);
    expect(res.error).toMatch(/page context changed/);
  });

  it('surfaces a thrown handler error as { error }', async () => {
    const scopeId = activeScope();
    register(scopeId, {
      ...navAction,
      name: 'boom',
      execute: () => {
        throw new Error('kaboom');
      },
    });
    const res = await executeClientAction('call-3', 'boom', {}, scopeId);
    expect(res.error).toBe('kaboom');
  });

  it('honors the confirm gate (declined → error, approved → output)', async () => {
    const scopeId = activeScope();
    register(scopeId, { ...navAction, name: 'crm_confirm', safety: 'confirm' });

    const offDeny = answerNextConfirmation(false);
    const declined = await executeClientAction('call-4', 'crm_confirm', { module: 'deals' }, scopeId);
    offDeny();
    expect(declined.error).toMatch(/declined/);

    const offAllow = answerNextConfirmation(true);
    const approved = await executeClientAction('call-5', 'crm_confirm', { module: 'deals' }, scopeId);
    offAllow();
    expect(approved.output).toEqual({ ok: true, navigatedTo: '#/crm/deals' });
  });
});

describe('client-action result round-trip', () => {
  it('posts the result to the authenticated client-action continuation endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);

    await postClientActionResult('session-1', {
      toolCallId: 'call-1',
      output: { navigatedTo: '#/crm/deals' },
    });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/client-actions/tool-result');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body))).toEqual({
      session_id: 'session-1',
      toolCallId: 'call-1',
      output: { navigatedTo: '#/crm/deals' },
    });
  });
});

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
import { isClientAction, executeClientAction } from '../../apps/web/src/lib/client-actions/executor';

const navAction = {
  name: 'navigate_demo',
  description: 'open a page',
  parameters: { type: 'object', properties: { module: { type: 'string' } }, required: ['module'] },
  safety: 'auto' as const,
  execute: (p: Record<string, unknown>) => ({ ok: true, navigatedTo: `#/${String(p.module)}` }),
};

afterEach(() => {
  // Clean the singleton registry between tests: re-registering the live object then
  // calling the returned unregister drops it (identity matches), clearing the map.
  for (const { name } of snapshotClientActions()) {
    const a = getClientAction(name);
    if (a) registerClientAction(a)();
  }
  vi.unstubAllGlobals();
});

describe('client-action registry', () => {
  it('registers, looks up, and snapshots only the serializable fields', () => {
    registerClientAction(navAction);
    expect(isClientAction('navigate_demo')).toBe(true);
    expect(isClientAction('nope')).toBe(false);

    const snap = snapshotClientActions();
    const found = snap.find((a) => a.name === 'navigate_demo')!;
    expect(found).toEqual({ name: navAction.name, description: navAction.description, parameters: navAction.parameters });
    // execute / safety must NOT cross the wire.
    expect('execute' in found).toBe(false);
    expect('safety' in found).toBe(false);
  });

  it('unregister removes the action', () => {
    const off = registerClientAction(navAction);
    expect(isClientAction('navigate_demo')).toBe(true);
    off();
    expect(isClientAction('navigate_demo')).toBe(false);
  });
});

describe('executeClientAction', () => {
  it('runs an auto action and returns its result keyed by toolCallId', async () => {
    registerClientAction(navAction);
    const res = await executeClientAction('call-1', 'navigate_demo', { module: 'projects' });
    expect(res).toEqual({ toolCallId: 'call-1', output: { ok: true, navigatedTo: '#/projects' } });
  });

  it('returns an error for an unknown action', async () => {
    const res = await executeClientAction('call-2', 'ghost_action', {});
    expect(res.error).toMatch(/Unknown client action/);
    expect(res.output).toBeNull();
  });

  it('surfaces a thrown handler error as { error }', async () => {
    registerClientAction({
      ...navAction,
      name: 'boom',
      execute: () => {
        throw new Error('kaboom');
      },
    });
    const res = await executeClientAction('call-3', 'boom', {});
    expect(res.error).toBe('kaboom');
  });

  it('honors the confirm gate (declined → error, approved → output)', async () => {
    registerClientAction({ ...navAction, name: 'navigate_confirm', safety: 'confirm' });

    vi.stubGlobal('window', { confirm: () => false });
    const declined = await executeClientAction('call-4', 'navigate_confirm', { module: 'projects' });
    expect(declined.error).toMatch(/declined/);

    vi.stubGlobal('window', { confirm: () => true });
    const approved = await executeClientAction('call-5', 'navigate_confirm', { module: 'projects' });
    expect(approved.output).toEqual({ ok: true, navigatedTo: '#/projects' });
  });
});

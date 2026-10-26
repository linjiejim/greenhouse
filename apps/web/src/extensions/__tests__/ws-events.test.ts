import { expect, it, vi } from 'vitest';
import type { ServerWsEvent } from '@greenhouse/types/ws';
const hooks = vi.hoisted(() => ({ event: vi.fn(), reconnect: vi.fn() }));
vi.mock('../compiled.generated', () => ({
  COMPILED_PLUGINS: [
    {
      id: 'ws-fixture',
      sdk: 1,
      core: '>=3 <5',
      wsEvents: [hooks.event],
      onReconnect: hooks.reconnect,
      defaultQuickActions: () => [{ icon: 'fixture', label: 'Fixture search', msg: 'Find a note' }],
    },
  ],
}));
import { dispatchExtensionWsEvent, reconnectExtensions } from '../index';
import { getQuickActions } from '../../components/agent-panel/agent-helpers';
import { useExtensionsStore } from '../../stores/extensions-store';
it('dispatches events and reconnects only to the active owner', () => {
  const event = { type: 'knowledge.changed', docId: 'doc', change: 'updated' } satisfies ServerWsEvent;
  useExtensionsStore.setState({ extensions: [] });
  dispatchExtensionWsEvent(event);
  reconnectExtensions();
  expect(getQuickActions(null).some((action) => action.label === 'Fixture search')).toBe(false);
  expect(hooks.event).not.toHaveBeenCalled();
  expect(hooks.reconnect).not.toHaveBeenCalled();
  useExtensionsStore.setState({ extensions: [{ id: 'ws-fixture', name: 'Fixture', description: null }] });
  dispatchExtensionWsEvent(event);
  reconnectExtensions();
  expect(getQuickActions(null).some((action) => action.label === 'Fixture search')).toBe(true);
  expect(hooks.event).toHaveBeenCalledWith(event);
  expect(hooks.reconnect).toHaveBeenCalledOnce();
});

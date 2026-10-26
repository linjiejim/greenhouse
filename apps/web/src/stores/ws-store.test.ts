import { afterEach, describe, expect, it, vi } from 'vitest';
const listeners = vi.hoisted(() => ({
  status: [] as Array<(status: string) => void>,
  event: [] as Array<(event: unknown) => void>,
}));
const hooks = vi.hoisted(() => ({ reconnect: vi.fn(), event: vi.fn() }));
vi.mock('../lib/ws', () => ({
  wsClient: {
    onStatusChange: (listener: (status: string) => void) => {
      listeners.status.push(listener);
      return () => {};
    },
    onEvent: (listener: (event: unknown) => void) => {
      listeners.event.push(listener);
      return () => {};
    },
    connect: () => {},
    disconnect: () => {},
  },
}));
vi.mock('../components/ui', () => ({ toast: () => {} }));
vi.mock('../lib/runtime-invalidation', () => ({ notifyRuntimeInvalidated: () => {} }));
vi.mock('../extensions/index', () => ({ reconnectExtensions: hooks.reconnect, dispatchExtensionWsEvent: hooks.event }));
import { useWsStore } from './ws-store';
afterEach(() => vi.clearAllMocks());
describe('ws store extension hooks', () => {
  it('catches plugins up after reconnect, and delivers events through the active registry', () => {
    useWsStore.getState();
    const status = (value: string) => listeners.status.forEach((fn) => fn(value));
    status('connected');
    expect(hooks.reconnect).not.toHaveBeenCalled();
    status('disconnected');
    status('connected');
    expect(hooks.reconnect).toHaveBeenCalledOnce();
    const event = { type: 'ext:fixture:changed' };
    listeners.event.forEach((fn) => fn(event));
    expect(hooks.event).toHaveBeenCalledWith(event);
  });
});

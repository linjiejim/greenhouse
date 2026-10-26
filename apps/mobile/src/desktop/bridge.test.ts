import { afterEach, expect, it, vi } from 'vitest';
import { desktopLink } from './deep-links';
import { listenNative, type NativeApi } from './native';
import { shortcutTable, SHORTCUTS } from './shortcuts';
import { matchesShortcut } from '../ui/shortcut-model';
import { connectNotifications } from './live-notifications';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it('opens existing conversation, document and project task routes', () => {
  expect(desktopLink('greenhouse://chat?session=chat_123')).toBe('/chat?session=chat_123');
  expect(desktopLink('greenhouse://sheet/doc?id=42')).toBe('/sheet/doc?id=42');
  expect(desktopLink('greenhouse://tasks/42?project=12')).toBe('/sheet/task?id=42&project=12');
  expect(desktopLink('greenhouse://documents/42')).toBe('/sheet/doc?id=42');
  expect(desktopLink('greenhouse://documents/42?station=second')).toBe('/sheet/doc?id=42&station=second');
  expect(desktopLink('greenhouse://knowledge/doc?id=42&station=second')).toBe('/sheet/doc?id=42&station=second');
  expect(desktopLink('greenhouse://projects/task?task=42&project=12&station=second')).toBe(
    '/sheet/task?id=42&project=12&station=second',
  );
  for (const link of [
    'https://example.com/chat?session=1',
    'greenhouse://sheet/doc?id=../secret',
    'greenhouse://tasks/42',
    'greenhouse://user:pass@chat?session=1',
    'greenhouse://evil/../sheet/doc?id=42',
    'greenhouse://chat?session=%3Cscript%3E',
  ])
    expect(desktopLink(link)).toBeNull();
});
it('uses the same accelerators in useShortcut and the native table', () => {
  expect(SHORTCUTS.new).toBe('mod+n');
  expect(SHORTCUTS.settings).toBe('mod+,');
  expect(new Set(shortcutTable.map((s) => s.id)).size).toBe(shortcutTable.length);
  for (const row of shortcutTable) {
    expect(row.accelerator.toLowerCase().replace('cmdorctrl', 'mod')).toBe(row.shortcut);
    expect(
      matchesShortcut(row.shortcut, {
        key: row.shortcut.slice(4),
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
      }),
    ).toBe(true);
  }
});
it('unsubscribes when native listener registration resolves after unmount', async () => {
  let register!: (stop: () => void) => void;
  const unsubscribe = vi.fn(),
    handler = vi.fn();
  const api = {
    event: {
      listen: () =>
        new Promise<() => void>((resolve) => {
          register = resolve;
        }),
    },
  } as unknown as NativeApi;
  const stop = listenNative(api, 'desktop:navigate', handler);
  stop();
  register(unsubscribe);
  await Promise.resolve();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(handler).not.toHaveBeenCalled();
});
it('keeps the WS identity bound, answers heartbeat and cancels reconnect on disposal', () => {
  vi.useFakeTimers();
  let current = true;
  const socket = {
    send: vi.fn(),
    close: vi.fn(),
    onmessage: null,
    onclose: null,
    onopen: null,
  } as unknown as WebSocket;
  const create = vi.fn(() => socket),
    message = vi.fn();
  const stop = connectNotifications({
    url: 'wss://station.test/api/ws',
    current: () => current,
    message,
    socket: create,
  });
  socket.onmessage!({ data: '{"type":"ping"}' } as MessageEvent);
  expect(socket.send).toHaveBeenCalledWith('{"type":"pong"}');
  socket.onmessage!({ data: '{"type":"notification:new","unread":2}' } as MessageEvent);
  expect(message).toHaveBeenCalledOnce();
  current = false;
  socket.onmessage!({ data: '{"type":"notification:new","unread":3}' } as MessageEvent);
  expect(message).toHaveBeenCalledOnce();
  current = true;
  socket.onclose!({ code: 1006 } as CloseEvent);
  stop();
  vi.advanceTimersByTime(60000);
  expect(create).toHaveBeenCalledOnce();
  expect(socket.close).toHaveBeenCalledOnce();
});

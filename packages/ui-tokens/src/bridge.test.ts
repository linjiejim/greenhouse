/** @vitest-environment happy-dom */
import { afterEach, expect, it, vi } from 'vitest';
import { connectGreenhouse } from './index.js';
import { EMBED_PROTOCOL } from '@greenhouse/types/plugins';
const bridges: Array<ReturnType<typeof connectGreenhouse>> = [];
afterEach(() => {
  for (const b of bridges.splice(0)) b.disconnect();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function message(data: object, origin = window.location.origin, source = window.parent) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
}
const init = {
  type: EMBED_PROTOCOL.init,
  theme: 'light',
  tokens: { '--gh-accent': '#123456' },
  locale: 'en',
  user: { id: 'alice', name: 'Alice', role: 'team' },
  route: 'notes',
  token: 'narrow',
  expires_at: '2099-01-01',
};
it('trusts only its parent at the exact origin and follows init and theme changes', () => {
  const onInit = vi.fn(),
    post = vi.spyOn(window.parent, 'postMessage');
  const bridge = connectGreenhouse({ onInit });
  bridges.push(bridge);
  expect(post).toHaveBeenCalledWith({ type: EMBED_PROTOCOL.ready }, window.location.origin);
  message(init, 'https://evil.example');
  expect(bridge.token).toBe('');
  message(init, window.location.origin, {} as Window);
  expect(bridge.token).toBe('');
  message(init);
  expect(bridge.token).toBe('narrow');
  expect(onInit).toHaveBeenCalledOnce();
  expect(document.documentElement.style.getPropertyValue('--gh-accent')).toBe('#123456');
  message({ type: EMBED_PROTOCOL.theme, theme: 'dark', tokens: { '--gh-accent': '#abcdef' } });
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.getPropertyValue('--gh-accent')).toBe('#abcdef');
  bridge.navigate('/p/example/example-note');
  bridge.sendPrompt('draft');
  expect(post).toHaveBeenCalledWith({ type: EMBED_PROTOCOL.sendPrompt, text: 'draft' }, window.location.origin);
});
it('deduplicates refresh requests, updates credentials and rejects a silent host', async () => {
  vi.useFakeTimers();
  const bridge = connectGreenhouse();
  bridges.push(bridge);
  message(init);
  const first = bridge.refresh();
  expect(bridge.refresh()).toBe(first);
  message({ type: EMBED_PROTOCOL.token, token: 'renewed', expires_at: '2099-02-01' });
  expect(await first).toBe('renewed');
  expect(bridge.token).toBe('renewed');
  const refused = expect(bridge.refresh()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(15_000);
  await refused;
});
it('accepts an explicitly configured desktop host without trusting nearby origins', () => {
  vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const bridge = connectGreenhouse({ hostOrigin: 'tauri://localhost' });
  bridges.push(bridge);
  message(init, 'tauri://localhost.evil');
  expect(bridge.token).toBe('');
  message(init, 'tauri://localhost');
  expect(bridge.token).toBe('narrow');
});

it('accepts native WebView injection only in a top-level native bridge', () => {
  const native = window as Window & { ReactNativeWebView?: { postMessage: () => void } };
  native.ReactNativeWebView = { postMessage: () => {} };
  vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  try {
    const bridge = connectGreenhouse();
    bridges.push(bridge);
    window.dispatchEvent(new MessageEvent('message', { data: init, origin: '', source: null }));
    expect(bridge.token).toBe('narrow');
  } finally {
    delete native.ReactNativeWebView;
  }
});
it('paints in the theme the frame URL names before init arrives', () => {
  vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  window.history.replaceState(null, '', '/?theme=dark&locale=zh');
  const onTheme = vi.fn();
  bridges.push(connectGreenhouse({ onTheme }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(document.documentElement.style.colorScheme).toBe('dark');
  expect(onTheme).toHaveBeenCalledWith('dark');
  window.history.replaceState(null, '', '/');
});

it('asks the host to draw confirms and notices and resolves with its replies', async () => {
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const bridge = connectGreenhouse();
  bridges.push(bridge);
  message(init);
  const answer = bridge.confirm({ title: 'Delete it?', confirmLabel: 'Delete', tone: 'danger' });
  const sent = post.mock.calls.at(-1)?.[0] as { type: string; id: string };
  expect(sent).toMatchObject({ type: EMBED_PROTOCOL.confirm, title: 'Delete it?', confirmLabel: 'Delete' });
  message({ type: EMBED_PROTOCOL.confirmResult, id: 'someone-else', ok: true });
  message({ type: EMBED_PROTOCOL.confirmResult, id: sent.id, ok: true });
  expect(await answer).toBe(true);
  const notice = bridge.notify({ kind: 'error', text: 'Failed', actionLabel: 'Retry' });
  const shown = post.mock.calls.at(-1)?.[0] as { id: string };
  message({ type: EMBED_PROTOCOL.notifyAction, id: shown.id });
  expect(await notice).toBe('action');
  expect(await bridge.notify({ kind: 'success', text: 'Saved' })).toBe('dismissed');
});

it('relays header actions, routes and an init timeout', async () => {
  vi.useFakeTimers();
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const onTimeout = vi.fn();
  const bridge = connectGreenhouse({ onTimeout, initTimeoutMs: 1000 });
  bridges.push(bridge);
  const pressed = vi.fn();
  bridge.header([{ id: 'up', label: 'Upload', icon: 'Upload', onPress: pressed }]);
  expect(post).toHaveBeenCalledWith(
    { type: EMBED_PROTOCOL.header, actions: [{ id: 'up', label: 'Upload', icon: 'Upload' }] },
    window.location.origin,
  );
  message({ type: EMBED_PROTOCOL.headerAction, id: 'up' });
  expect(pressed).toHaveBeenCalledOnce();
  bridge.route('#/?q=cat');
  expect(post).toHaveBeenCalledWith({ type: EMBED_PROTOCOL.route, route: '#/?q=cat' }, window.location.origin);
  await vi.advanceTimersByTimeAsync(1000);
  expect(onTimeout).toHaveBeenCalledOnce();
});

it('does not time out once the host answered, and a disconnect declines pending confirms', async () => {
  vi.useFakeTimers();
  vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const onTimeout = vi.fn();
  const bridge = connectGreenhouse({ onTimeout, initTimeoutMs: 1000 });
  message(init);
  await vi.advanceTimersByTimeAsync(2000);
  expect(onTimeout).not.toHaveBeenCalled();
  const pending = bridge.confirm({ title: 'Leave?', confirmLabel: 'Leave' });
  bridge.disconnect();
  expect(await pending).toBe(false);
});

it('settles a notice with an action when the host reports it gone', async () => {
  const post = vi.spyOn(window.parent, 'postMessage').mockImplementation(() => {});
  const bridge = connectGreenhouse();
  bridges.push(bridge);
  message(init);
  const undo = bridge.notify({ kind: 'undo', text: 'Moved', actionLabel: 'undo' });
  const shown = post.mock.calls.at(-1)?.[0] as { id: string };
  message({ type: EMBED_PROTOCOL.notifyDismissed, id: shown.id });
  expect(await undo).toBe('dismissed');
});
it('hands the host its Back while the page shows a sub-view, and runs it on request', () => {
  const post = vi.spyOn(window.parent, 'postMessage');
  const bridge = connectGreenhouse();
  bridges.push(bridge);
  message(init);
  const first = vi.fn(),
    second = vi.fn();
  bridge.back(first);
  bridge.back(second);
  const sent = () => post.mock.calls.filter(([m]) => (m as { type: string }).type === EMBED_PROTOCOL.back);
  // only a change of state goes to the host; a new handler replaces the old one silently
  expect(sent().map(([m]) => m)).toEqual([{ type: EMBED_PROTOCOL.back, enabled: true }]);
  message({ type: EMBED_PROTOCOL.backRequest });
  expect(second).toHaveBeenCalledOnce();
  expect(first).not.toHaveBeenCalled();
  message({ type: EMBED_PROTOCOL.backRequest }, 'https://evil.example');
  expect(second).toHaveBeenCalledOnce();
  // a host that answers a later ready with init again hears the Back once more
  message(init);
  expect(sent()).toHaveLength(2);
  bridge.back(null);
  expect(sent().at(-1)?.[0]).toEqual({ type: EMBED_PROTOCOL.back, enabled: false });
  message({ type: EMBED_PROTOCOL.backRequest });
  expect(second).toHaveBeenCalledOnce();
});

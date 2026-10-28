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

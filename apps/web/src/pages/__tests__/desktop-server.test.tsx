/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { API_VERSION, type Bootstrap } from '@greenhouse/contract';
import { SessionProvider } from '../../app/session';
import { I18nProvider } from '../../lib/i18n';
import { LoginPage } from '../LoginPage';
import { DesktopSection } from '../settings/DesktopSection';

const BOOTSTRAP: Bootstrap = {
  api_version: API_VERSION,
  name: 'Green',
  primary_color: null,
  logo_url: null,
  login_methods: ['password'],
  setup_pending: false,
};

let root: Root | undefined;

async function render(
  page: 'login' | 'desktop',
  settings?: { apiBaseUrl: string; apiBaseLocked: boolean },
  failed = false,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (settings) {
    window.__TAURI_INTERNALS__ = { invoke: vi.fn(async () => undefined) };
    client.setQueryData(['desktop', 'settings'], settings);
  }
  // Unreachable: the bootstrap query runs against the offline fetch below and fails.
  if (!failed) client.setQueryData(['bootstrap'], BOOTSTRAP);
  const host = document.createElement('div');
  document.body.append(host);
  await act(async () => {
    root = createRoot(host);
    root.render(
      <QueryClientProvider client={client}>
        {page === 'login' ? (
          <SessionProvider>
            <LoginPage />
          </SessionProvider>
        ) : (
          <I18nProvider locale="en">
            <DesktopSection />
          </I18nProvider>
        )}
      </QueryClientProvider>,
    );
  });
  if (failed) await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  return host;
}

const serverField = (host: HTMLElement) => host.querySelector('input[name="server"]');
const passwordField = (host: HTMLElement) => host.querySelector('input[type="password"]');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  localStorage.clear();
  // The server is never reached here: a refetch fails as offline.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Promise.reject(new TypeError('offline'))),
  );
});
afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  delete window.__TAURI_INTERNALS__;
});

describe('sign-in and the desktop server', () => {
  it('shows nothing about servers in a browser', async () => {
    const host = await render('login');
    expect(passwordField(host)).not.toBeNull();
    expect(host.querySelector('.app-login-server')).toBeNull();
  });

  it('shows nothing about servers when the build fixed one, even unreachable or on first launch', async () => {
    const locked = { apiBaseUrl: 'http://localhost:3000', apiBaseLocked: true };
    for (const failed of [false, true]) {
      const host = await render('login', locked, failed);
      expect(passwordField(host)).not.toBeNull();
      expect(serverField(host)).toBeNull();
      expect(host.querySelector('.app-login-server')).toBeNull();
    }
  });

  it('asks for a server on the first launch of an unlocked app', async () => {
    const host = await render('login', { apiBaseUrl: 'http://localhost:3000', apiBaseLocked: false });
    expect(serverField(host)).not.toBeNull();
    expect((serverField(host) as HTMLInputElement | null)?.value).toBe('');
    expect(passwordField(host)).toBeNull();
  });

  it('names the chosen server under sign-in and offers to change it', async () => {
    localStorage.setItem('greenhouse.desktop.server', 'https://green.example.com');
    const host = await render('login', { apiBaseUrl: 'https://green.example.com', apiBaseLocked: false });
    expect(passwordField(host)).not.toBeNull();
    expect(host.querySelector('.app-login-server')?.textContent).toContain('green.example.com');
  });

  it('offers another address when the server cannot be reached', async () => {
    localStorage.setItem('greenhouse.desktop.server', 'https://green.example.com');
    const host = await render('login', { apiBaseUrl: 'https://green.example.com', apiBaseLocked: false }, true);
    expect((serverField(host) as HTMLInputElement | null)?.value).toBe('https://green.example.com');
    expect(serverField(host)?.getAttribute('aria-invalid')).toBe('true');
    expect(passwordField(host)).toBeNull();
  });
});

describe('设置 → 桌面端', () => {
  it('shows a fixed server read only', async () => {
    const host = await render('desktop', { apiBaseUrl: 'https://green.example.com', apiBaseLocked: true });
    expect(host.textContent).toContain('https://green.example.com');
    expect(host.textContent).toContain('This app always connects to this server');
    expect(host.textContent).not.toContain('Change server');
  });

  it('lets an unlocked app change its server', async () => {
    const host = await render('desktop', { apiBaseUrl: 'https://green.example.com', apiBaseLocked: false });
    expect(host.textContent).toContain('https://green.example.com');
    expect(host.textContent).toContain('Change server');
    expect(host.textContent).toContain('Check for updates');
  });
});

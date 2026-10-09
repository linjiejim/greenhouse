/** @vitest-environment happy-dom */

/**
 * The OAuth consent screen an MCP client opens (/oauth/authorize). A store
 * selector that mapped the extension list built a new array on every snapshot
 * and re-rendered the page forever ("Maximum update depth exceeded"), so no
 * client could sign in. Pins that it renders the request and its Allow button.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../lib/i18n';
import { OAuthConsentPage } from './oauth-consent';

const api = vi.hoisted(() => ({
  validateOAuthAuthorization: vi.fn(),
  decideOAuthAuthorization: vi.fn(),
}));
vi.mock('../lib/api/oauth', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('OAuthConsentPage', () => {
  it('renders the request with its Allow button (no render loop)', async () => {
    api.validateOAuthAuthorization.mockResolvedValue({
      client: { id: 'lpoa_client_1', name: 'Greenhouse' },
      redirect_uri: 'http://localhost:3100/api/connectors/oauth/callback',
      resource: 'http://localhost:3121/api/mcp',
      scopes: ['mcp:read', 'mcp:knowledge'],
      state: 'state-1234',
    });
    window.history.replaceState(null, '', '/?oauth_authorize=1&client_id=lpoa_client_1&response_type=code');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(OAuthConsentPage) }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(host.textContent).toContain('Greenhouse');
    expect(host.textContent).toContain('Allow connection');
    expect(errors.mock.calls.flat().join(' ')).not.toMatch(/Maximum update depth|getSnapshot should be cached/);
    errors.mockRestore();
  });
});

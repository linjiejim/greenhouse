/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { useExtensionsStore } from '../../stores/extensions-store';
import { McpKeysPanel } from './mcp-keys';

vi.mock('../../lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/auth')>()),
  authFetch: vi.fn(async (url: string) =>
    Response.json(url.endsWith('/clients') ? { clients: [] } : { users: [{ id: 'u1', role: 'super' }] }),
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  useExtensionsStore.getState().reset();
});

describe('McpKeysPanel', () => {
  // A store selector that maps to a fresh array re-renders forever under
  // zustand v5 (React #185) — the page crashed on open in v1.3.1.
  it('renders with active extensions without looping', async () => {
    useExtensionsStore.setState({ extensions: [{ id: 'crm', name: 'CRM', description: null }], loaded: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(McpKeysPanel) }));
    });

    expect(container.textContent).toContain('Machine clients');
  });
});

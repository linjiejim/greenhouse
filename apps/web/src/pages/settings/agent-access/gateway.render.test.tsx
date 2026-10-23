/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayOverview } from '@greenhouse/types/agent-access';
import { I18nProvider } from '../../../lib/i18n';
import { GatewayKeys } from './gateway';
import { ConnectGuide } from './connect';

const overview: GatewayOverview = {
  enabled: false,
  base_url: 'https://hub.example.com/api/gateway/openai/v1',
  models: [{ id: 'flash', name: 'Default model' }],
  keys: [
    {
      id: 'gwk_1',
      name: 'Build script',
      prefix: 'ghgw_AbCdEfG',
      allowed_models: null,
      expires_at: null,
      last_used_at: null,
      revoked_at: null,
      created_at: '2026-10-20T00:00:00.000Z',
      status: 'active',
    },
  ],
};

const fetchGatewayOverview = vi.fn(async () => overview);

vi.mock('../../../lib/api/gateway', () => ({
  fetchGatewayOverview: () => fetchGatewayOverview(),
  createGatewayKey: vi.fn(),
  revokeGatewayKey: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(node: ReturnType<typeof createElement>) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: node }));
  });
  return container;
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  fetchGatewayOverview.mockClear();
});

describe('Settings › Agent connections › Model gateway', () => {
  it('lists keys by name and prefix and says an admin must turn the gateway on', async () => {
    const view = await render(createElement(GatewayKeys, { onOpenGuide: () => undefined }));
    for (let i = 0; i < 20 && !view.textContent?.includes('Build script'); i++) {
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    expect(view.querySelector('[data-testid="gateway-disabled"]')?.textContent).toContain('Runtime Config');
    expect(view.querySelector('[data-testid="gateway-base-url"]')?.textContent).toBe(overview.base_url);
    expect(view.textContent).toContain('Build script');
    expect(view.textContent).toContain('ghgw_AbCdEfG…');
    // One overview load and one list load — no re-render loop.
    expect(fetchGatewayOverview.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('shows copy-ready gateway config in the Connect guide', async () => {
    const view = await render(
      createElement(ConnectGuide, {
        mcpUrl: 'https://hub.example.com/api/mcp',
        gateway: overview,
        onOpenGatewayKeys: () => undefined,
      }),
    );
    const guide = view.querySelector('[data-testid="gateway-guide"]')?.textContent ?? '';
    expect(guide).not.toContain('wire_api');
    expect(guide).toContain(`export OPENAI_BASE_URL=${overview.base_url}`);
    expect(guide).toContain(`curl ${overview.base_url}/chat/completions`);
    expect(guide).toContain('"model":"flash"');
  });
});

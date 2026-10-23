/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GatewayOverview } from '@greenhouse/types/agent-access';
import type { AgentConnectionsCheck } from '@greenhouse/types/hub-context';
import { I18nProvider } from '../../../lib/i18n';
import { ConnectGuide } from './connect';

const api = vi.hoisted(() => ({ fetchAgentConnections: vi.fn() }));
vi.mock('../../../lib/api/agent-access', () => api);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MCP_URL = 'https://hub.example.com/api/mcp';
const gateway: GatewayOverview = {
  enabled: true,
  base_url: 'https://hub.example.com/api/gateway/openai/v1',
  anthropic_base_url: 'https://hub.example.com/api/gateway/anthropic',
  models: [{ id: 'flash', name: 'Default model', openai: true, anthropic: true }],
  keys: [],
};

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ConnectGuide, { mcpUrl: MCP_URL, gateway, onOpenGatewayKeys: () => undefined }),
      }),
    );
  });
  return container;
}

async function click(view: HTMLElement, selector: string) {
  await act(async () => {
    (view.querySelector(selector) as HTMLButtonElement).click();
  });
}

async function settle(view: HTMLElement, selector: string) {
  for (let i = 0; i < 30 && !view.querySelector(selector); i++) {
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
}

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function seen(kind: AgentConnectionsCheck['connections'][number]['kind'], name: string, minutesAgo: number | null) {
  const now = Date.parse('2026-10-24T10:00:00.000Z');
  return {
    client_id: `client-${kind}`,
    client_name: name,
    kind,
    connected_at: '2026-10-01T00:00:00.000Z',
    last_seen_at: minutesAgo === null ? null : new Date(now - minutesAgo * 60_000).toISOString(),
  };
}

describe('Settings › Agent connections › Connect wizard', () => {
  it('asks for the client first, then shows that client’s setup, gateway part, check and tips', async () => {
    const view = await render();
    expect(view.querySelector('[data-testid="connect-step-setup"]')).toBeNull();
    expect(view.textContent).toContain('Pick the agent you use');

    await click(view, '[data-testid="connect-client-claude-code"]');
    expect(view.querySelector('[data-testid="connect-client-claude-code"]')?.getAttribute('aria-checked')).toBe('true');
    expect(view.querySelector('[data-testid="connect-snippet"]')?.textContent).toContain(
      `claude mcp add --transport http greenhouse ${MCP_URL}`,
    );
    expect(view.querySelector('[data-testid="connect-step-setup"]')?.textContent).toContain('/mcp');
    expect(view.querySelector('[data-testid="gateway-guide-claude"]')?.textContent).toContain(
      `export ANTHROPIC_BASE_URL=${gateway.anthropic_base_url}`,
    );
    expect(view.querySelector('[data-testid="gateway-guide-openai"]')).toBeNull();
    expect(view.querySelector('[data-testid="connect-step-tips"]')?.textContent).toContain('team_context');
  });

  it('gives Codex its CLI commands and says it cannot use the gateway yet', async () => {
    const view = await render();
    await click(view, '[data-testid="connect-client-codex"]');
    const snippet = view.querySelector('[data-testid="connect-snippet"]')?.textContent ?? '';
    expect(snippet).toContain(`codex mcp add greenhouse --url ${MCP_URL}`);
    expect(snippet).toContain('codex mcp login greenhouse');
    const guide = view.querySelector('[data-testid="gateway-guide"]')?.textContent ?? '';
    expect(guide).toContain('Responses API');
    expect(view.querySelector('[data-testid="gateway-guide-openai"]')).toBeNull();
    expect(view.querySelector('[data-testid="gateway-guide-claude"]')).toBeNull();
  });

  it('gives Cursor its mcp.json and the OpenAI-compatible gateway setup', async () => {
    const view = await render();
    await click(view, '[data-testid="connect-client-cursor"]');
    expect(view.querySelector('[data-testid="connect-snippet"]')?.textContent).toContain('"mcpServers"');
    expect(view.querySelector('[data-testid="gateway-guide-openai"]')?.textContent).toContain(
      `export OPENAI_BASE_URL=${gateway.base_url}`,
    );
  });

  it('checks whether the picked client reached Greenhouse in the last minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-24T10:00:00.000Z'));
    try {
      api.fetchAgentConnections.mockResolvedValue({
        now: '2026-10-24T10:00:00.000Z',
        connections: [seen('claude-code', 'Claude Code', 2), seen('cursor', 'Cursor', 120)],
      });
      const view = await render();
      await click(view, '[data-testid="connect-client-claude-code"]');
      await click(view, '[data-testid="connect-check"]');
      await settle(view, '[data-testid="connect-check-ok"]');
      expect(view.querySelector('[data-testid="connect-check-ok"]')?.textContent).toContain('Claude Code');

      await click(view, '[data-testid="connect-client-cursor"]');
      await click(view, '[data-testid="connect-check"]');
      await settle(view, '[data-testid="connect-check-stale"]');
      expect(view.querySelector('[data-testid="connect-check-stale"]')?.textContent).toContain('2h ago');

      await click(view, '[data-testid="connect-client-codex"]');
      await click(view, '[data-testid="connect-check"]');
      await settle(view, '[data-testid="connect-check-none"]');
      expect(view.querySelector('[data-testid="connect-check-none"]')).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

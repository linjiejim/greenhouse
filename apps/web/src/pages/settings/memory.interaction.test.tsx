/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores/auth-store';
import { MemoryPanel } from './memory';

const auth = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock('../../lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/auth')>()),
  authFetch: auth.authFetch,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function memory(id: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    category: 'fact',
    title,
    content: `${title} details`,
    status: 'active',
    pinned: false,
    source: 'agent',
    source_session_id: null,
    last_used_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
    ...extra,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(memories: unknown[]) {
  auth.authFetch.mockResolvedValue(new Response(JSON.stringify({ memories }), { status: 200 }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(MemoryPanel) })),
  );
  await flush();
}

const sources = () => [...document.querySelectorAll('[data-testid="memory-source"]')].map((node) => node.textContent);

beforeEach(() => {
  auth.authFetch.mockReset();
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'super', nickname: 'Mia' } as never });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('Settings → Memory source', () => {
  it('labels shared memories "All Bots" and a Bot-private one with its Bot', async () => {
    await render([
      memory(1, 'Prefers Python', { bot_id: null, bot_name: null }),
      memory(2, 'Sage tracks the vendor list', { bot_id: 'bot_sage', bot_name: 'Sage' }),
    ]);
    expect(sources()).toEqual(['All Bots', 'Only Sage']);
  });

  it('filters by source', async () => {
    await render([
      memory(1, 'Prefers Python', { bot_id: null, bot_name: null }),
      memory(2, 'Sage tracks the vendor list', { bot_id: 'bot_sage', bot_name: 'Sage' }),
    ]);
    const select = document.querySelector<HTMLSelectElement>('[data-testid="memory-source-filter"]')!;
    await act(async () => {
      select.value = 'bot:bot_sage';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(document.body.textContent).toContain('Sage tracks the vendor list');
    expect(document.body.textContent).not.toContain('Prefers Python');
  });

  it('stays out of the way for a server that does not send the source', async () => {
    await render([memory(1, 'Prefers Python')]);
    expect(document.body.textContent).toContain('Prefers Python');
    expect(sources()).toEqual([]);
    expect(document.querySelector('[data-testid="memory-source-filter"]')).toBeNull();
  });
});

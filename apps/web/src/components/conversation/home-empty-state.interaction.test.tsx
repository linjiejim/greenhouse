/**
 * @vitest-environment happy-dom
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore, useUIStore, useWsStore } from '../../stores';
import { HomeEmptyState, orderRecentConversations } from './home-empty-state';

const mocks = vi.hoisted(() => ({ listSessions: vi.fn(), fetchNotifications: vi.fn() }));

vi.mock('../../lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api')>()),
  listSessions: mocks.listSessions,
  fetchNotifications: mocks.fetchNotifications,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = (id: string, updated_at: string, extra: Record<string, unknown> = {}) =>
  ({ id, title: `Chat ${id}`, updated_at, created_at: updated_at, ...extra }) as never;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

async function render(props: Parameters<typeof HomeEmptyState>[0]) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(I18nProvider, { initialLocale: 'en', children: createElement(HomeEmptyState, props) }));
  });
  // Let the session / notification fetches settle.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  mocks.listSessions.mockReset();
  mocks.fetchNotifications.mockReset();
  mocks.listSessions.mockResolvedValue(
    Array.from({ length: 8 }, (_, i) => session(`s${i}`, `2026-10-2${i % 10}T10:00:00Z`)),
  );
  mocks.fetchNotifications.mockResolvedValue({ notifications: [], next_cursor: null });
  useAuthStore.setState({ currentUser: { id: 'u1', email: 'jim@example.test', nickname: 'Jim Lin', role: 'team' } });
  useWsStore.setState({ notificationCount: 0, shareCount: 0 });
  useUIStore.setState({ inboxOpen: false, inboxTab: 'notifications' });
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('HomeEmptyState', () => {
  it('greets by first name and lists five recent conversations by default', async () => {
    await render({ composer: createElement('textarea', { 'aria-label': 'composer' }) });
    expect(container!.querySelector('h1')?.textContent).toMatch(/, Jim\??$/);
    const rows = container!.querySelectorAll('[data-testid="home-recent"] li');
    expect(rows).toHaveLength(5);
    expect(rows[0].textContent).toContain('Chat s7');
    expect(container!.querySelector('[data-testid="home-needs-you"]')).toBeNull();
  });

  it('honours the per-device count, and 0 hides the list', async () => {
    localStorage.setItem('home-recent-count', '3');
    await render({});
    expect(container!.querySelectorAll('[data-testid="home-recent"] li')).toHaveLength(3);
    await act(async () => root?.unmount());
    container?.remove();

    localStorage.setItem('home-recent-count', '0');
    await render({});
    expect(container!.querySelector('[data-testid="home-recent"]')).toBeNull();
  });

  it('fades the list while the composer holds text', async () => {
    await render({ hasText: true });
    expect(container!.querySelector('[data-testid="home-recent"]')?.className).toContain('opacity-0');
  });

  it('shows "waiting for you" for unread attention notifications and opens the bell', async () => {
    useWsStore.setState({ notificationCount: 2 });
    mocks.fetchNotifications.mockResolvedValue({
      notifications: [
        { id: 'n1', kind: 'runtime_attention', read_at: null },
        { id: 'n2', kind: 'runtime_completed', read_at: null },
      ],
      next_cursor: null,
    });
    await render({});
    const line = container!.querySelector<HTMLButtonElement>('[data-testid="home-needs-you"]');
    expect(line?.textContent).toContain('1');
    await act(async () => line?.click());
    expect(useUIStore.getState()).toMatchObject({ inboxOpen: true, inboxTab: 'notifications' });
  });

  it('does not list recent conversations on surfaces with their own suggestions', async () => {
    await render({ showRecent: false });
    expect(container!.querySelector('[data-testid="home-recent"]')).toBeNull();
    expect(mocks.listSessions).not.toHaveBeenCalled();
  });
});

describe('orderRecentConversations', () => {
  it('puts pinned first in pinned order, then the newest', () => {
    const ordered = orderRecentConversations([
      session('old', '2026-10-01T00:00:00Z'),
      session('p2', '2026-09-01T00:00:00Z', { pinned: true, pin_sort: 2 }),
      session('new', '2026-10-05T00:00:00Z'),
      session('p1', '2026-08-01T00:00:00Z', { pinned: true, pin_sort: 1 }),
    ] as never);
    expect(ordered.map((s: { id: string }) => s.id)).toEqual(['p1', 'p2', 'new', 'old']);
  });
});

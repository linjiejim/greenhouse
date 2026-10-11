/** @vitest-environment happy-dom */

/**
 * The sidebar's Apps section, mounted for real (the stores are client state —
 * a server render would only ever see their initial values): pinned apps in
 * pin order, then featured; the open app marked; nothing without the feature
 * or without apps; the section loads the shelves itself.
 */

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '@greenhouse/types/apps';
import { I18nProvider } from '../../../lib/i18n';
import { useAuthStore } from '../../../stores';
import { useAppsStore } from '../../../stores/apps-store';
import { AppsSection, AppsSectionCollapsed, MobileAppsSection } from './apps-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function summary(id: number, patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    baseId: 1,
    name: `App ${id}`,
    description: null,
    icon: 'cart',
    accent: 'teal',
    ownerId: 'u1',
    status: 'published',
    publishedVersion: 1,
    featured: false,
    updatedAt: '2026-10-11T00:00:00.000Z',
    canManage: false,
    canPublish: false,
    pinned: false,
    ...patch,
  };
}

const load = vi.fn(async () => {});
const originalLoad = useAppsStore.getState().load;

function seed(features: Record<string, boolean>, pinnedIds: number[], featured: AppSummary[] = []) {
  act(() => {
    useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia', features } as never });
    useAppsStore.setState({
      catalog: {
        managed: [summary(1, { name: 'Procurement' })],
        shared: [summary(2, { name: 'IT tickets' })],
        featured,
      },
      pinnedIds,
      status: 'ready',
      load,
    });
  });
}

let root: Root | null = null;
let container: HTMLDivElement;

function render(node: ReactNode): string {
  act(() => root?.unmount());
  container = document.createElement('div');
  root = createRoot(container);
  act(() => root!.render(<I18nProvider initialLocale="en">{node}</I18nProvider>));
  return container.innerHTML;
}

beforeEach(() => load.mockClear());
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  useAppsStore.getState().clear();
  useAppsStore.setState({ load: originalLoad });
  useAuthStore.setState({ currentUser: null });
});

describe('sidebar Apps section', () => {
  it('lists pinned apps in pin order, then featured, linking each app and the app center', () => {
    seed({ apps: true }, [2, 1], [summary(3, { name: 'Onboarding', featured: true })]);
    const html = render(<AppsSection currentHash="#/apps/1/orders" />);

    expect(html.indexOf('IT tickets')).toBeGreaterThan(-1);
    expect(html.indexOf('IT tickets')).toBeLessThan(html.indexOf('Procurement'));
    expect(html.indexOf('Procurement')).toBeLessThan(html.indexOf('Featured'));
    expect(html.indexOf('Featured')).toBeLessThan(html.indexOf('Onboarding'));
    expect(container.querySelector('a[href="#/apps"]')?.textContent).toBe('All apps');
    // The open app (any of its pages) is the current one.
    expect(container.querySelector('a[href="#/apps/1"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('a[href="#/apps/2"]')?.hasAttribute('aria-current')).toBe(false);
    // Accent and icon come from tokens, through the shared badge.
    expect(html).toContain('bg-accent-teal-subtle');
  });

  it('loads the shelves on its first mount only — a failed load waits for the app center retry', () => {
    seed({ apps: true }, []);
    act(() => useAppsStore.setState({ status: 'idle' }));
    render(<AppsSection currentHash="#/chat" />);
    expect(load).toHaveBeenCalledTimes(1);

    act(() => useAppsStore.setState({ status: 'error' }));
    render(<MobileAppsSection currentHash="#/chat" />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders nothing without the apps feature (and never asks), or with nothing to list', () => {
    seed({ apps: false }, [1]);
    expect(render(<AppsSection currentHash="#/chat" />)).toBe('');
    expect(render(<MobileAppsSection currentHash="#/chat" />)).toBe('');
    expect(load).not.toHaveBeenCalled();

    seed({ apps: true }, []);
    expect(render(<AppsSection currentHash="#/chat" />)).toBe('');
    expect(render(<AppsSectionCollapsed currentHash="#/chat" />)).toBe('');
  });

  it('draws tiles named by the app in the collapsed rail and touch-sized rows on mobile', () => {
    seed({ apps: true }, [1], [summary(3, { name: 'Onboarding', featured: true })]);
    render(<AppsSectionCollapsed currentHash="#/apps/3" />);
    expect(container.querySelector('a[aria-label="Procurement"]')).not.toBeNull();
    expect(container.querySelector('a[href="#/apps/3"]')?.getAttribute('aria-current')).toBe('page');

    const mobile = render(<MobileAppsSection currentHash="#/chat" />);
    expect(mobile).toContain('Procurement');
    expect(mobile).toContain('Onboarding');
    expect(mobile).toContain('min-h-11');
  });
});

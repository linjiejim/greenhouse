/** @vitest-environment happy-dom */

/**
 * A Base's Apps section: the member's apps on this Base (from the same shelves
 * as the app center), "New app" for its builders — a draft with a starter
 * page and role in the builder's language, then the builder — and nothing at
 * all for members without the `apps` feature.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppSummary } from '@greenhouse/types/apps';
import { I18nProvider } from '../../lib/i18n';
import { useAuthStore } from '../../stores';
import { useAppsStore } from '../../stores/apps-store';
import { appsOfBase, BaseAppsSection } from './base-apps-section';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const builderApi = vi.hoisted(() => ({ createApp: vi.fn() }));
vi.mock('../../lib/api/apps-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/apps-builder')>()),
  ...builderApi,
}));

function summary(id: number, patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    baseId: 3,
    name: `App ${id}`,
    description: null,
    icon: 'cart',
    accent: 'amber',
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
const original = { load: useAppsStore.getState().load };
let root: Root | null = null;
let container: HTMLDivElement;

async function mount(canBuild: boolean) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="zh">
        <BaseAppsSection baseId={3} baseName="采购" canBuild={canBuild} />
      </I18nProvider>,
    ),
  );
}

async function click(element: Element | null) {
  await act(async () => (element as HTMLElement).click());
  for (let index = 0; index < 4; index += 1) await act(async () => Promise.resolve());
}

beforeEach(() => {
  window.location.hash = '#/tables/3';
  useAuthStore.setState({
    currentUser: { id: 'u1', nickname: 'Olive', role: 'team', features: { apps: true } },
  });
  useAppsStore.setState({
    catalog: {
      managed: [summary(1, { name: 'Leave', canManage: true, status: 'draft', publishedVersion: null })],
      shared: [summary(2, { name: 'Tickets' }), summary(5, { baseId: 4, name: 'Elsewhere' })],
      featured: [summary(2, { name: 'Tickets' })],
    },
    status: 'ready',
    load,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  useAppsStore.getState().clear();
  useAppsStore.setState(original);
  useAuthStore.setState({ currentUser: null });
  vi.clearAllMocks();
});

describe('BaseAppsSection', () => {
  it('lists this Base’s apps once each, with open and edit where they apply', async () => {
    await mount(false);
    const toggle = container.querySelector('[data-testid="base-apps-button"]')!;
    expect(toggle.textContent).toContain('2');
    await click(toggle);
    expect(document.querySelector('[data-testid="base-app-5"]')).toBeNull();
    const leave = document.querySelector('[data-testid="base-app-1"]')!;
    // A never-published draft has nothing to open; its manager can edit it.
    expect(leave.querySelector('a[href="#/apps/1"]')).toBeNull();
    expect(leave.querySelector('a[href="#/apps/1/edit"]')).not.toBeNull();
    const tickets = document.querySelector('[data-testid="base-app-2"]')!;
    expect(tickets.querySelector('a[href="#/apps/2"]')).not.toBeNull();
    expect(tickets.querySelector('a[href="#/apps/2/edit"]')).toBeNull();
    // Only builders create apps here.
    expect(document.querySelector('[data-testid="base-apps-new"]')).toBeNull();
  });

  it('creates a draft with a starter page and role in the builder’s language, then opens the builder', async () => {
    builderApi.createApp.mockResolvedValue({
      app: summary(12, { canManage: true }),
      spec: {},
      draftRevision: 1,
      errors: [],
    });
    await mount(true);
    await click(container.querySelector('[data-testid="base-apps-button"]'));
    await click(document.querySelector('[data-testid="base-apps-new"]'));
    const name = document.querySelector('[data-testid="app-create-name"]') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, '采购申请');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(document.querySelector('[data-testid="app-create-submit"]'));
    expect(builderApi.createApp).toHaveBeenCalledWith(
      expect.objectContaining({
        baseId: 3,
        name: '采购申请',
        icon: 'app',
        accent: 'brand',
        spec: expect.objectContaining({
          pages: [expect.objectContaining({ id: 'home', title: '首页' })],
          roles: [{ key: 'member', name: '成员', pages: 'all', tables: [] }],
        }),
      }),
    );
    expect(window.location.hash).toBe('#/apps/12/edit');
    expect(load).toHaveBeenCalledWith(true);
  });

  it('is not there for a member without the apps feature', async () => {
    useAuthStore.setState({ currentUser: { id: 'u1', nickname: 'Olive', role: 'team', features: { apps: false } } });
    await mount(true);
    expect(container.querySelector('[data-testid="base-apps-button"]')).toBeNull();
  });

  it('keeps archived apps and other Bases out, sorted by name', () => {
    const apps = [
      summary(1, { name: 'Zeta' }),
      summary(2, { name: 'Alpha' }),
      summary(3, { name: 'Gone', status: 'archived' }),
      summary(4, { name: 'Other', baseId: 9 }),
    ];
    expect(appsOfBase(apps, 3).map((app) => app.name)).toEqual(['Alpha', 'Zeta']);
  });
});

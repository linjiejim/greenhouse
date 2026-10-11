/** @vitest-environment happy-dom */

/**
 * The three Phase 1 app routes as F1 ships them: the app center (real shelves
 * from the store, pins, creation entry points disabled with their reason), the
 * runtime shell (the app as the gateway returns it, pages as tabs, an honest
 * empty body, the Assistant told which app / page / role); the builder is
 * tested in ./builder/.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppRuntimeView, AppSummary } from '@greenhouse/types/apps';
import { I18nProvider } from '../../lib/i18n';
import { useAppsStore } from '../../stores/apps-store';
import { AppsPage } from './index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enrichPageContext = vi.hoisted(() => vi.fn());
vi.mock('../../components/agent-context', () => ({ useAgentContext: () => ({ enrichPageContext }) }));

const api = vi.hoisted(() => ({ getApp: vi.fn<(appId: number) => Promise<AppRuntimeView>>() }));
vi.mock('../../lib/api/apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/apps')>()),
  ...api,
}));

function summary(id: number, patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id,
    baseId: 1,
    name: `App ${id}`,
    description: null,
    icon: 'cart',
    accent: 'amber',
    ownerId: 'u1',
    status: 'published',
    publishedVersion: 2,
    featured: false,
    updatedAt: '2026-10-11T00:00:00.000Z',
    canManage: false,
    canPublish: false,
    pinned: false,
    ...patch,
  };
}

const load = vi.fn(async () => {});
const setPinned = vi.fn(async () => {});
const original = { load: useAppsStore.getState().load, setPinned: useAppsStore.getState().setPinned };

function seed(
  catalog: { managed?: AppSummary[]; shared?: AppSummary[]; featured?: AppSummary[] } | null,
  pinnedIds: number[] = [],
) {
  act(() =>
    useAppsStore.setState({
      catalog: catalog ? { managed: [], shared: [], featured: [], ...catalog } : null,
      pinnedIds,
      status: catalog ? 'ready' : 'loading',
      load,
      setPinned,
    }),
  );
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(subPath: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <AppsPage subPath={subPath} />
      </I18nProvider>,
    ),
  );
}

beforeEach(() => {
  load.mockClear();
  setPinned.mockClear();
  enrichPageContext.mockClear();
  api.getApp.mockReset();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  useAppsStore.getState().clear();
  useAppsStore.setState(original);
});

describe('app center', () => {
  it('shows each non-empty shelf with its apps, and refetches on open', async () => {
    seed(
      { managed: [summary(1, { name: 'Procurement', canManage: true })], shared: [summary(2, { name: 'IT tickets' })] },
      [2],
    );
    await mount('');

    expect(load).toHaveBeenCalledWith(true);
    expect(container.querySelector('[data-testid="app-shelf-managed"]')?.textContent).toContain('Procurement');
    expect(container.querySelector('[data-testid="app-shelf-shared"]')?.textContent).toContain('IT tickets');
    expect(container.querySelector('[data-testid="app-shelf-featured"]')).toBeNull();
    expect(container.querySelector('a[aria-label="Open Procurement"]')?.getAttribute('href')).toBe('#/apps/1');
    // Only a manager gets the edit link.
    expect(container.querySelector('a[href="#/apps/1/edit"]')).not.toBeNull();
    expect(container.querySelector('a[href="#/apps/2/edit"]')).toBeNull();
  });

  it('pins and unpins through the store', async () => {
    seed({ shared: [summary(2, { name: 'IT tickets' }), summary(3, { name: 'Leave' })] }, [2]);
    await mount('');

    await act(async () =>
      (container.querySelector('button[aria-label="Unpin IT tickets"]') as HTMLButtonElement).click(),
    );
    await act(async () =>
      (container.querySelector('button[aria-label="Pin Leave to the sidebar"]') as HTMLButtonElement).click(),
    );
    expect(setPinned.mock.calls).toEqual([
      [2, false],
      [3, true],
    ]);
  });

  it('lists the ways to create an app, disabled with the reason read out', async () => {
    seed({});
    await mount('');

    const entries = [...container.querySelectorAll('[data-testid="app-center-entries"] button')] as HTMLButtonElement[];
    expect(entries.map((button) => button.textContent)).toEqual([
      'New app',
      'Ask a Bot to build one',
      'From a template',
    ]);
    for (const button of entries) {
      expect(button.disabled).toBe(true);
      const reason = document.getElementById(button.getAttribute('aria-describedby')!);
      expect(reason?.textContent).toContain('Not available yet');
    }
    expect(container.textContent).toContain('No apps yet');
  });
});

describe('app runtime shell', () => {
  const view: AppRuntimeView = {
    app: summary(5, { name: 'Procurement' }),
    version: 2,
    role: { key: 'approver', name: 'Approver' },
    spec: {
      version: 1,
      home: 'approvals',
      roles: [{ key: 'approver', name: 'Approver', pages: 'all', tables: [] }],
      pages: [
        { id: 'requests', title: 'My requests', cards: [] },
        { id: 'approvals', title: 'Approvals', icon: 'check', cards: [] },
      ],
    },
    tables: [],
    issues: [],
  };

  it('shows the app, its role and version, the pages as tabs with the home page current, and tells the Assistant', async () => {
    seed({ shared: [view.app] });
    api.getApp.mockResolvedValue(view);
    await mount('5');

    expect(api.getApp).toHaveBeenCalledWith(5);
    expect(container.querySelector('h1')?.textContent).toBe('Procurement');
    expect(container.textContent).toContain('Approver');
    expect(container.textContent).toContain('v2');
    expect(container.querySelector('a[href="#/apps/5/approvals"]')?.getAttribute('aria-current')).toBe('page');
    expect(container.querySelector('a[href="#/apps/5/requests"]')?.hasAttribute('aria-current')).toBe(false);
    expect(container.textContent).toContain('Pages do not render here yet');
    expect(enrichPageContext).toHaveBeenLastCalledWith({
      appName: 'Procurement',
      version: 2,
      roleName: 'Approver',
      pageId: 'approvals',
      pageTitle: 'Approvals',
    });
  });

  it('says a page is not part of the app instead of guessing', async () => {
    seed({ shared: [view.app] });
    api.getApp.mockResolvedValue(view);
    await mount('5/nope');
    expect(container.textContent).toContain('This page is not part of the app.');
  });

  it('treats a refused or missing app the same — no hint which one it was', async () => {
    seed({});
    const { TablesRequestError } = await import('../../lib/api/tables');
    api.getApp.mockRejectedValue(new TablesRequestError('Forbidden', 403, undefined));
    await mount('9');
    expect(container.textContent).toContain('App not available');
  });

  it('does not ask the gateway for a draft that was never published', async () => {
    seed({ managed: [summary(6, { name: 'Leave', canManage: true, status: 'draft', publishedVersion: null })] });
    await mount('6');
    expect(api.getApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Not published yet');
    expect(container.textContent).toContain('Edit Leave');
  });
});

// The builder (`7/edit`) has its own tests in ./builder/.
describe('bad addresses', () => {
  it('rejects an address that is not an app', async () => {
    seed({});
    await mount('abc');
    expect(container.textContent).toContain('This app address is not valid.');
  });
});

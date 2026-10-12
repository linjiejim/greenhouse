/** @vitest-environment happy-dom */

/**
 * The app center: the three shelves with pins, and the ways to make an app —
 * a new app on a Base the member builds (or a new Base), an Agent asked through
 * Chat, a built-in template — each only offered when it can work.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppDraftView,
  AppSpec,
  AppSummary,
  AppTemplateInstallResult,
  AppTemplateSummary,
} from '@greenhouse/types/apps';
import type { TableBaseWithRole } from '@greenhouse/types/tables-wire';
import { I18nProvider } from '../../../lib/i18n';
import { useAuthStore } from '../../../stores';
import { useAppsStore } from '../../../stores/apps-store';
import { AppCenterPage } from './app-center';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  listAppTemplates: vi.fn<() => Promise<AppTemplateSummary[]>>(),
  createApp: vi.fn<(input: unknown) => Promise<AppDraftView>>(),
  installAppTemplate: vi.fn<(key: string) => Promise<AppTemplateInstallResult>>(),
}));
vi.mock('../../../lib/api/apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/apps')>()),
  listAppTemplates: api.listAppTemplates,
  installAppTemplate: api.installAppTemplate,
}));
// "New app" is the builder's create dialog — one way to create an app, here and on a Base's page.
vi.mock('../../../lib/api/apps-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/apps-builder')>()),
  createApp: api.createApp,
}));
const tables = vi.hoisted(() => ({
  listTableBases: vi.fn<() => Promise<TableBaseWithRole[]>>(),
  createTableBase: vi.fn<(input: unknown) => Promise<{ base: { id: number; name: string } }>>(),
}));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  ...tables,
}));
const attach = vi.hoisted(() => ({ publishAttachment: vi.fn() }));
vi.mock('../../../lib/desktop/attach', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/desktop/attach')>()),
  ...attach,
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

function draft(id: number): AppDraftView {
  return {
    app: summary(id, { canManage: true }),
    spec: { version: 1, pages: [], roles: [] },
    draftRevision: 1,
    errors: [],
  };
}

function base(id: number, name: string, role: TableBaseWithRole['role']): TableBaseWithRole {
  return {
    id,
    name,
    description: null,
    visibility: 'private',
    owner_id: 'u1',
    team_role: 'viewer',
    team_custom_role_id: null,
    created_by: 'u1',
    created_at: '2026-10-11T00:00:00.000Z',
    updated_at: '2026-10-11T00:00:00.000Z',
    archived_at: null,
    role,
  };
}

const load = vi.fn(async () => {});
const setPinned = vi.fn(async () => {});
const original = { load: useAppsStore.getState().load, setPinned: useAppsStore.getState().setPinned };

function seed(
  catalog: { managed?: AppSummary[]; shared?: AppSummary[]; featured?: AppSummary[] },
  pinnedIds: number[] = [],
) {
  act(() =>
    useAppsStore.setState({
      catalog: { managed: [], shared: [], featured: [], ...catalog },
      pinnedIds,
      status: 'ready',
      load,
      setPinned,
    }),
  );
}

function signIn(features: Record<string, boolean>) {
  useAuthStore.setState({ currentUser: { id: 'u1', role: 'team', nickname: 'Mia', features } as never });
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(locale: 'en' | 'zh' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale={locale}>
        <AppCenterPage />
      </I18nProvider>,
    ),
  );
}

const button = (label: string) =>
  [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label) as
    | HTMLButtonElement
    | undefined;

async function change(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  const prototype = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

beforeEach(() => {
  load.mockClear();
  setPinned.mockClear();
  api.listAppTemplates.mockReset().mockResolvedValue([]);
  api.createApp.mockReset();
  api.installAppTemplate.mockReset();
  tables.listTableBases.mockReset().mockResolvedValue([]);
  tables.createTableBase.mockReset();
  attach.publishAttachment.mockReset();
  signIn({ tables: true, apps: true });
  window.location.hash = '#/apps';
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  useAppsStore.getState().clear();
  useAppsStore.setState(original);
  useAuthStore.setState({ currentUser: null });
});

describe('app center shelves', () => {
  it('shows each non-empty shelf with its apps, and refetches on open', async () => {
    seed(
      { managed: [summary(1, { name: 'Procurement', canManage: true })], shared: [summary(2, { name: 'IT tickets' })] },
      [2],
    );
    await mount();

    expect(load).toHaveBeenCalledWith(true);
    expect(container.querySelector('[data-testid="app-shelf-managed"]')?.textContent).toContain('Procurement');
    expect(container.querySelector('[data-testid="app-shelf-shared"]')?.textContent).toContain('IT tickets');
    expect(container.querySelector('[data-testid="app-shelf-featured"]')).toBeNull();
    expect(container.querySelector('a[aria-label="Open Procurement"]')?.getAttribute('href')).toBe('#/apps/1');
    expect(container.querySelector('a[href="#/apps/1/edit"]')).not.toBeNull();
    expect(container.querySelector('a[href="#/apps/2/edit"]')).toBeNull();
  });

  it('pins and unpins through the store', async () => {
    seed({ shared: [summary(2, { name: 'IT tickets' }), summary(3, { name: 'Leave' })] }, [2]);
    await mount();
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
});

describe('making an app', () => {
  it('offers new / ask an Agent to Tables members, and templates only when the server lists some', async () => {
    seed({});
    await mount();
    const entries = () =>
      [...container.querySelectorAll('[data-testid="app-center-entries"] button')].map((entry) => entry.textContent);
    expect(entries()).toEqual(['New app', 'Ask an Agent to build one']);
    expect(container.textContent).toContain('Apps turn a Base into pages');

    act(() => root?.unmount());
    container.remove();
    api.listAppTemplates.mockResolvedValue([
      { key: 'it-tickets', name: 'IT tickets', description: 'Report and resolve', icon: 'ticket', accent: 'blue' },
    ]);
    await mount();
    expect(entries()).toEqual(['New app', 'Ask an Agent to build one', 'From a template']);
  });

  it('offers nothing to build to a member without Tables (an app’s audience)', async () => {
    signIn({ apps: true });
    api.listAppTemplates.mockResolvedValue([
      { key: 'it-tickets', name: 'IT tickets', description: 'Report and resolve', icon: 'ticket', accent: 'blue' },
    ]);
    seed({});
    await mount();
    expect(container.querySelector('[data-testid="app-center-entries"]')).toBeNull();
    // Installing a template builds a Tables Base: not even the list is asked for.
    expect(api.listAppTemplates).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Apps shared with you');
  });

  it('creates an app on a Base the member builds and opens the builder', async () => {
    tables.listTableBases.mockResolvedValue([base(4, 'Purchasing', 'builder'), base(5, 'Read only', 'viewer')]);
    api.createApp.mockResolvedValue(draft(12));
    seed({});
    await mount();
    await act(async () => button('New app')!.click());

    const select = document.querySelector('[data-testid="app-create-base"]') as HTMLSelectElement;
    // Only Bases the member builds, then "a new Base".
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Choose a Base you build',
      'Purchasing',
      'A new Base…',
    ]);
    await change(select, '4');
    await change(document.querySelector('[data-testid="app-create-name"]') as HTMLInputElement, 'Purchase requests');
    await act(async () => (document.querySelector('button[aria-label="Ticket"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('button[aria-label="Violet"]') as HTMLButtonElement).click());
    await act(async () => (document.querySelector('[data-testid="app-create-submit"]') as HTMLButtonElement).click());

    expect(tables.createTableBase).not.toHaveBeenCalled();
    expect(api.createApp).toHaveBeenCalledWith({
      baseId: 4,
      name: 'Purchase requests',
      description: null,
      icon: 'ticket',
      accent: 'violet',
      spec: expect.objectContaining({
        pages: [expect.objectContaining({ title: 'Home' })],
        roles: [expect.objectContaining({ name: 'Member' })],
      }),
    });
    expect(load).toHaveBeenCalledWith(true);
    expect(window.location.hash).toBe('#/apps/12/edit');
  });

  it('names the starter page and role in the member’s language', async () => {
    tables.listTableBases.mockResolvedValue([base(4, 'Purchasing', 'builder')]);
    api.createApp.mockResolvedValue(draft(12));
    seed({});
    await mount('zh');
    await act(async () => button('新建应用')!.click());
    await change(document.querySelector('[data-testid="app-create-base"]') as HTMLSelectElement, '4');
    await change(document.querySelector('[data-testid="app-create-name"]') as HTMLInputElement, '采购申请');
    await act(async () => (document.querySelector('[data-testid="app-create-submit"]') as HTMLButtonElement).click());
    const { spec } = api.createApp.mock.calls[0]![0] as { spec: AppSpec };
    expect(spec.pages[0]!.title).toBe('首页');
    expect(spec.roles[0]!.name).toBe('成员');
  });

  it('creates the Base first when the member has none to build on', async () => {
    tables.createTableBase.mockResolvedValue({ base: { id: 30, name: 'Leave' } });
    api.createApp.mockResolvedValue(draft(13));
    seed({});
    await mount();
    await act(async () => button('New app')!.click());
    expect(document.body.textContent).toContain('the app gets a new Base of its own');

    await change(document.querySelector('[data-testid="app-create-base-name"]') as HTMLInputElement, 'Leave');
    await change(document.querySelector('[data-testid="app-create-name"]') as HTMLInputElement, 'Leave requests');
    await act(async () => (document.querySelector('[data-testid="app-create-submit"]') as HTMLButtonElement).click());

    expect(tables.createTableBase).toHaveBeenCalledWith({ name: 'Leave', visibility: 'private' });
    expect(api.createApp).toHaveBeenCalledWith(expect.objectContaining({ baseId: 30, name: 'Leave requests' }));
  });

  it('builds the new Base once: trying again after the app failed reuses it', async () => {
    tables.createTableBase.mockResolvedValue({ base: { id: 30, name: 'Leave' } });
    api.createApp.mockRejectedValueOnce(new Error('Network is down')).mockResolvedValueOnce(draft(13));
    seed({});
    await mount();
    await act(async () => button('New app')!.click());
    await change(document.querySelector('[data-testid="app-create-base-name"]') as HTMLInputElement, 'Leave');
    await change(document.querySelector('[data-testid="app-create-name"]') as HTMLInputElement, 'Leave requests');
    const submit = () => document.querySelector('[data-testid="app-create-submit"]') as HTMLButtonElement;
    await act(async () => submit().click());
    expect(document.querySelector('[data-testid="app-create-dialog"]')?.textContent).toContain('Network is down');
    // The new Base is now the chosen one.
    expect((document.querySelector('[data-testid="app-create-base"]') as HTMLSelectElement).value).toBe('30');

    await act(async () => submit().click());
    expect(tables.createTableBase).toHaveBeenCalledTimes(1);
    expect(api.createApp).toHaveBeenCalledTimes(2);
    expect(api.createApp).toHaveBeenLastCalledWith(expect.objectContaining({ baseId: 30, name: 'Leave requests' }));
    expect(window.location.hash).toBe('#/apps/13/edit');
  });

  it('installs a template and opens the new app’s builder', async () => {
    api.listAppTemplates.mockResolvedValue([
      {
        key: 'procurement',
        name: 'Purchase requests',
        description: 'Apply, approve, report',
        icon: 'cart',
        accent: 'amber',
      },
    ]);
    api.installAppTemplate.mockResolvedValue({ app: summary(21, { canManage: true }), baseId: 40 });
    seed({});
    await mount();
    await act(async () => button('From a template')!.click());
    expect(document.querySelector('[data-testid="template-procurement"]')?.textContent).toContain('Purchase requests');
    await act(async () => button('Use this template')!.click());
    expect(api.installAppTemplate).toHaveBeenCalledWith('procurement');
    expect(window.location.hash).toBe('#/apps/21/edit');
  });

  it('installs once: buttons disabled and the dialog held open while it runs, and a failure is shown', async () => {
    api.listAppTemplates.mockResolvedValue([
      { key: 'procurement', name: 'Purchase requests', description: 'd', icon: 'cart', accent: 'amber' },
      { key: 'it-tickets', name: 'IT tickets', description: 'd', icon: 'ticket', accent: 'blue' },
    ]);
    let fail: (error: Error) => void = () => undefined;
    api.installAppTemplate.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    seed({});
    await mount();
    await act(async () => button('From a template')!.click());
    const install = (key: string) =>
      document.querySelector(`[data-testid="template-${key}-install"]`) as HTMLButtonElement;
    await act(async () => install('procurement').click());
    expect(install('procurement').disabled).toBe(true);
    expect(install('it-tickets').disabled).toBe(true);
    expect(install('procurement').textContent).toBe('Setting it up…');
    // A second click, or another template, does not start another install.
    await act(async () => install('procurement').click());
    await act(async () => install('it-tickets').click());
    // Escape cannot close the dialog mid-install (closing would drop the guard).
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.querySelector('[data-testid="template-dialog"]')).not.toBeNull();
    expect(api.installAppTemplate).toHaveBeenCalledTimes(1);

    await act(async () => fail(new Error('Tables is turned off for you')));
    expect(document.querySelector('[data-testid="template-dialog"]')?.textContent).toContain(
      'Tables is turned off for you',
    );
    expect(install('it-tickets').disabled).toBe(false);
    expect(window.location.hash).toBe('#/apps');
  });

  it('opens Chat with a request naming the chosen Base, without sending it', async () => {
    tables.listTableBases.mockResolvedValue([base(4, 'Purchasing', 'owner')]);
    seed({});
    await mount();
    await act(async () => button('Ask an Agent to build one')!.click());
    await change(document.querySelector('[data-testid="ask-bot-base"]') as HTMLSelectElement, '4');
    await change(
      document.querySelector('[data-testid="ask-bot-dialog"] textarea') as HTMLTextAreaElement,
      'purchase approvals by Finance',
    );
    await act(async () => (document.querySelector('[data-testid="ask-bot-open"]') as HTMLButtonElement).click());
    expect(attach.publishAttachment).toHaveBeenCalledWith({
      target: 'chat',
      draft: 'Build an app on my Base “Purchasing” (Base #4) for: purchase approvals by Finance',
      newConversation: true,
    });
  });
});

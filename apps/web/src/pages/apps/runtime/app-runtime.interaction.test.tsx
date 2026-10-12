/** @vitest-environment happy-dom */

/**
 * The app runtime against the gateway contract (mocked `/api/apps` answers):
 * the shell (pages as tabs or a side list, home page, role and version, the
 * Assistant context), what managers get (preview as a role, the issues bar),
 * what a viewer without pages or access sees, and the page's flows — cards
 * evaluated per page with the viewer's filters, a `?record=` link opening the
 * drawer, the drawer's fields / attachments / actions / edit / activity, an
 * action asking for its required input, a records card creating, a form
 * submitting, a kanban move, and the refresh when records change.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppActionInput,
  AppActionResult,
  AppCardQueryResult,
  AppRecordView,
  AppRuntimeView,
} from '@greenhouse/types/apps';
import {
  CARDS,
  CHAIR,
  LAPTOP,
  appSpec,
  appSummary,
  recordsResult,
  runtimeView,
} from '../../../components/app-cards/test-fixtures';
import { TablesRequestError } from '../../../lib/api/tables';
import { I18nProvider } from '../../../lib/i18n';
import { flush } from '../../tables/views/view-test-fixtures';
import { useAppsStore } from '../../../stores/apps-store';
import { AppsPage } from '../index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enrichPageContext = vi.hoisted(() => vi.fn());
vi.mock('../../../components/agent-context', () => ({ useAgentContext: () => ({ enrichPageContext }) }));

const api = vi.hoisted(() => ({
  getApp: vi.fn<(appId: number, preview?: { previewRole?: string; draft?: true }) => Promise<AppRuntimeView>>(),
  queryAppCard: vi.fn<(appId: number, input: Record<string, unknown>) => Promise<AppCardQueryResult>>(),
  getAppRecord: vi.fn<(appId: number, input: Record<string, unknown>) => Promise<AppRecordView>>(),
  runAppAction: vi.fn<(appId: number, input: AppActionInput) => Promise<AppActionResult>>(),
  runAppActionWithReplay: vi.fn<(appId: number, input: AppActionInput, base?: unknown) => Promise<AppActionResult>>(),
  listAppActivity: vi.fn<(appId: number, input: Record<string, unknown>) => Promise<unknown>>(),
  listAppFieldOptions: vi.fn(async () => ({ options: [] })),
  uploadAppFile: vi.fn(),
}));
vi.mock('../../../lib/api/apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/apps')>()),
  ...api,
}));
const ui = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../../../components/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../components/ui')>()),
  ...ui,
}));
const download = vi.hoisted(() => ({ downloadAuthenticatedFile: vi.fn(async () => undefined) }));
vi.mock('../../../lib/file-download', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/file-download')>()),
  ...download,
}));

type RealtimeListener = { filter: { baseId?: number; tableId?: number }; onChange: () => unknown };
const realtime = vi.hoisted(() => ({ listeners: [] as RealtimeListener[] }));
vi.mock('../../../hooks/use-tables-records-changed', () => ({
  useTablesRecordsChanged: (
    filter: RealtimeListener['filter'],
    onChange: (events: Array<{ tableId: number }>) => unknown,
    options?: { enabled?: boolean },
  ) => {
    if (options?.enabled === false) return;
    realtime.listeners.push({ filter, onChange: () => onChange([{ tableId: 7 }]) });
  },
}));

// The grid measures its container; render cells directly instead.
vi.mock('../../../components/workbench/widget-grid', () => ({
  WIDGET_DRAG_HANDLE_CLASS: 'widget-drag-handle',
  WidgetGrid: ({
    items,
    renderItem,
  }: {
    items: Array<{ id: string }>;
    renderItem: (id: string) => React.ReactNode;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.id}>{renderItem(item.id)}</div>
      ))}
    </div>
  ),
}));

function recordView(patch: Partial<AppRecordView> = {}): AppRecordView {
  return {
    record: LAPTOP,
    refs: recordsResult().refs,
    fieldIds: [1, 2, 3, 4],
    systemFields: ['created_by'],
    editableFieldIds: [3],
    canComment: true,
    ...patch,
  };
}

/** One card per page keeps each scenario readable. */
function viewWith(cards: Array<(typeof CARDS)[keyof typeof CARDS]>, patch: Partial<AppRuntimeView> = {}) {
  return runtimeView({ spec: appSpec(cards), ...patch });
}

let root: Root | null = null;
let container: HTMLDivElement;

async function mount(subPath: string, query = '') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <AppsPage subPath={subPath} params={new URLSearchParams(query)} />
      </I18nProvider>,
    ),
  );
  await flush();
}

const byTestId = (id: string) => document.querySelector(`[data-testid="${id}"]`);
async function click(element: Element | null | undefined) {
  expect(element, 'element to click').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await flush();
}
async function type(element: Element | null, value: string) {
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  realtime.listeners = [];
  api.queryAppCard
    .mockReset()
    .mockImplementation(async (_appId, input) =>
      input.cardId === 'total' ? { kind: 'kpi', value: 1290 } : recordsResult(),
    );
  api.getAppRecord.mockReset().mockResolvedValue(recordView());
  api.runAppAction.mockReset().mockResolvedValue({ outcome: 'created', recordId: 40 });
  api.runAppActionWithReplay.mockReset().mockResolvedValue({ outcome: 'updated', recordId: 11 });
  api.listAppActivity.mockReset().mockResolvedValue({ items: [], nextCursor: null });
  window.location.hash = '#/apps/5';
  useAppsStore.setState({ load: vi.fn(async () => {}) });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  useAppsStore.getState().clear();
  vi.clearAllMocks();
});

describe('the app shell', () => {
  it('shows the app and role, keeps version metadata in context, and selects the home page', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine]));
    await mount('5');

    expect(api.getApp).toHaveBeenCalledWith(5, {});
    expect(document.querySelector('h1')?.textContent).toBe('Purchase requests');
    expect(container.textContent).toContain('Applicant');
    expect(container.textContent).not.toContain('v2');
    expect(document.querySelector('a[href="#/apps/5/apply"]')?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('a[href="#/apps/5/stats"]')?.hasAttribute('aria-current')).toBe(false);
    // The page's cards are evaluated for this viewer and page.
    expect(api.queryAppCard).toHaveBeenCalledWith(5, expect.objectContaining({ pageId: 'apply', cardId: 'mine' }));
    expect(container.textContent).toContain('Laptop');
    // Only managers see the preview bar and the builder link.
    expect(byTestId('app-preview-bar')).toBeNull();
    expect(document.querySelector('a[href="#/apps/5/edit"]')).toBeNull();
    // The Assistant gets the app, the page on screen and every page this role can open.
    expect(enrichPageContext).toHaveBeenLastCalledWith({
      appName: 'Purchase requests',
      version: 2,
      roleName: 'Applicant',
      pageId: 'apply',
      pageTitle: 'Apply',
      pages: [
        { id: 'apply', title: 'Apply' },
        { id: 'stats', title: 'Statistics' },
      ],
    });
  });

  it('lists the pages beside the content when the spec asks for a sidebar', async () => {
    const view = viewWith([CARDS.mine]);
    api.getApp.mockResolvedValue({ ...view, spec: { ...view.spec, nav: { layout: 'sidebar' } } });
    await mount('5/stats');
    expect(byTestId('app-page-sidebar')?.querySelector('a[aria-current="page"]')?.getAttribute('href')).toBe(
      '#/apps/5/stats',
    );
    // On a phone the side list becomes the tab row.
    expect(byTestId('app-page-tabs')?.className).toContain('md:hidden');
  });

  it('treats a refused or missing app the same, and says when the role has no pages', async () => {
    api.getApp.mockRejectedValue(new TablesRequestError('Forbidden', 403, undefined));
    await mount('9');
    expect(container.textContent).toContain('App not available');

    act(() => root?.unmount());
    container.remove();
    api.getApp.mockResolvedValue(runtimeView({ spec: { ...appSpec([]), pages: [] } }));
    await mount('5');
    expect(container.textContent).toContain('Nothing here for your role');
  });

  it('does not ask the gateway for a draft that was never published', async () => {
    useAppsStore.setState({
      catalog: {
        managed: [appSummary({ id: 6, name: 'Leave', canManage: true, status: 'draft', publishedVersion: null })],
        shared: [],
        featured: [],
      },
      status: 'ready',
    });
    await mount('6');
    expect(api.getApp).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Not published yet');
    // Its manager can still open the builder or the draft itself.
    await click(byTestId('app-preview-draft'));
    expect(window.location.hash).toBe('#/apps/6?draft=1');
  });
});

describe('what managers get', () => {
  const manager = (patch: Partial<AppRuntimeView> = {}) =>
    viewWith([CARDS.mine], {
      app: appSummary({ canManage: true, canPublish: true }),
      role: { key: '__manager__', name: 'Manager' },
      ...patch,
    });

  it('previews the app as one of its roles through the address, and says what is broken', async () => {
    const issues = [{ pageId: 'apply', cardId: 'mine', message: 'Field 9 was deleted' }];
    api.getApp.mockResolvedValue(manager({ issues }));
    await mount('5');

    expect(byTestId('app-preview-bar')?.textContent).toContain('Check a role’s view');
    expect(byTestId('app-issues-bar')?.textContent).toContain('Field 9 was deleted');
    expect(document.querySelector('a[href="#/apps/5/edit"]')).not.toBeNull();
    const select = byTestId('app-preview-role') as HTMLSelectElement;
    await act(async () => {
      select.value = 'applicant';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // The role may not have this page: the preview opens at its home.
    expect(window.location.hash).toBe('#/apps/5?previewRole=applicant');

    act(() => root?.unmount());
    container.remove();
    api.getApp.mockImplementation(async (_appId, options) =>
      options?.previewRole ? viewWith([CARDS.mine], { app: appSummary({ canManage: true }) }) : manager(),
    );
    await mount('5', 'previewRole=applicant');
    expect(api.getApp).toHaveBeenCalledWith(5, { previewRole: 'applicant' });
    expect(byTestId('app-preview-bar')?.textContent).toContain('Previewing as Applicant');
    expect(api.queryAppCard).toHaveBeenCalledWith(5, expect.objectContaining({ previewRole: 'applicant' }));
  });

  describe('previewing the draft (the builder’s Preview)', () => {
    const draftView = (patch: Partial<AppRuntimeView> = {}) =>
      viewWith([CARDS.mine], {
        app: appSummary({ canManage: true, canPublish: true, status: 'draft', publishedVersion: null }),
        draft: true,
        version: 0,
        ...patch,
      });

    beforeEach(() => {
      // The shelves know the app was never published: the draft still opens when asked for.
      useAppsStore.setState({
        catalog: {
          managed: [appSummary({ canManage: true, status: 'draft', publishedVersion: null })],
          shared: [],
          featured: [],
        },
        status: 'ready',
      });
      api.getApp.mockImplementation(async (_appId, preview) =>
        preview?.previewRole
          ? draftView({ role: { key: 'applicant', name: 'Applicant' } })
          : draftView({ role: { key: '__manager__', name: 'Manager' } }),
      );
    });

    it('renders the draft’s pages as the role, and every gateway call reads the draft', async () => {
      const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
      await mount('5', 'draft=1&previewRole=applicant&record=11');

      expect(api.getApp).toHaveBeenCalledWith(5, { previewRole: 'applicant', draft: true });
      // The switcher's roles come from the draft too.
      expect(api.getApp).toHaveBeenCalledWith(5, { draft: true });
      expect(container.textContent).not.toContain('Not published yet');
      expect(byTestId('app-runtime')).not.toBeNull();
      const bar = byTestId('app-preview-bar') as HTMLElement;
      expect(bar.dataset.draft).toBe('true');
      expect(bar.textContent).toContain('Unpublished draft as Applicant');
      expect(container.textContent).toContain('Draft');
      expect(api.queryAppCard).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ cardId: 'mine', previewRole: 'applicant', draft: true }),
      );
      // The record link opens through the draft, and the address keeps the preview.
      expect(api.getAppRecord).toHaveBeenCalledWith(5, {
        pageId: 'apply',
        cardId: 'mine',
        recordId: 11,
        previewRole: 'applicant',
        draft: true,
      });
      expect(replace).toHaveBeenCalledWith('#/apps/5?draft=1&previewRole=applicant');
      await click(byTestId('app-record-action-approve'));
      expect(api.runAppActionWithReplay).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ actionId: 'approve', previewRole: 'applicant', draft: true }),
        LAPTOP,
      );
      await click(byTestId('app-record-activity-tab'));
      expect(api.listAppActivity).toHaveBeenCalledWith(5, {
        pageId: 'apply',
        cardId: 'mine',
        recordId: 11,
        previewRole: 'applicant',
        draft: true,
      });
      // Page links stay in the draft preview.
      expect(document.querySelector('a[href="#/apps/5/stats?draft=1&previewRole=applicant"]')).not.toBeNull();
      replace.mockRestore();
    });

    it('keeps the draft when switching roles, and goes back to the builder on exit', async () => {
      await mount('5', 'draft=1&previewRole=applicant');
      const select = byTestId('app-preview-role') as HTMLSelectElement;
      await act(async () => {
        select.value = '';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(window.location.hash).toBe('#/apps/5?draft=1');
      await act(async () => {
        select.value = 'applicant';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
      expect(window.location.hash).toBe('#/apps/5?draft=1&previewRole=applicant');
      await click(byTestId('app-preview-exit'));
      expect(window.location.hash).toBe('#/apps/5/edit');
    });

    it('opens the draft with full access, telling the Assistant no published version is on screen', async () => {
      api.getApp.mockResolvedValue(
        draftView({
          role: { key: '__manager__', name: 'Manager' },
          issues: [{ pageId: 'apply', cardId: 'mine', message: 'Field 9 was deleted' }],
        }),
      );
      await mount('5', 'draft=1');
      // The draft's problems are the draft's, not a "v0" that stopped working.
      expect(byTestId('app-issues-bar')?.textContent).toContain('draft issues before publishing');
      expect(byTestId('app-issues-bar')?.textContent).not.toContain('v0');
      expect(api.getApp).toHaveBeenCalledWith(5, { draft: true });
      expect(byTestId('app-preview-bar')?.textContent).toContain('Draft preview — unpublished layout, live data');
      expect(api.queryAppCard).toHaveBeenCalledWith(5, expect.objectContaining({ draft: true }));
      expect(api.queryAppCard.mock.calls.every(([, input]) => input.previewRole === undefined)).toBe(true);
      const context = enrichPageContext.mock.lastCall?.[0] as Record<string, unknown>;
      expect(context).toMatchObject({ appName: 'Purchase requests', roleName: 'Full access' });
      expect(context).not.toHaveProperty('version');
    });
  });
});

describe('a page in use', () => {
  it('opens the record a link names, with its fields, files, actions and activity', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine]));
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
    await mount('5', 'record=11');

    expect(api.getAppRecord).toHaveBeenCalledWith(5, { pageId: 'apply', cardId: 'mine', recordId: 11 });
    const drawer = byTestId('app-record-drawer')!;
    expect(drawer.textContent).toContain('Laptop');
    expect(drawer.textContent).toContain('Pending');
    expect(drawer.textContent).toContain('Mia');
    // The link is consumed so it can open the record again later.
    expect(replace).toHaveBeenCalledWith('#/apps/5');

    await click(document.querySelector('button[aria-label="Download quote.pdf"]'));
    expect(download.downloadAuthenticatedFile).toHaveBeenCalledWith(
      '/api/apps/5/files/31?pageId=apply&cardId=mine&recordId=11&fieldId=4',
      'quote.pdf',
    );

    await click(byTestId('app-record-action-approve'));
    expect(api.runAppActionWithReplay).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ pageId: 'apply', cardId: 'mine', actionId: 'approve', recordId: 11, revision: 3 }),
      LAPTOP,
    );

    await click(byTestId('app-record-activity-tab'));
    expect(api.listAppActivity).toHaveBeenCalledWith(5, { pageId: 'apply', cardId: 'mine', recordId: 11 });
    expect(document.querySelector('textarea[aria-label="Comment"]')).not.toBeNull();
    replace.mockRestore();
  });

  it('edits the detail’s editable fields with the record’s revision', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine]));
    await mount('5');
    await click(document.querySelector('button[aria-label="Open Laptop"]'));
    await click(byTestId('app-record-edit'));

    const dialog = byTestId('app-edit-dialog')!;
    const amount = dialog.querySelector('input') as HTMLInputElement;
    expect(amount.value).toBe('1200');
    await type(amount, '1100');
    await click(byTestId('app-edit-dialog-submit'));
    expect(api.runAppActionWithReplay).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ actionId: '$edit', recordId: 11, revision: 3, values: [{ fieldId: 3, value: 1100 }] }),
      LAPTOP,
    );
  });

  it('asks for an action’s required input before it runs', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine]));
    await mount('5');
    await click(byTestId('app-action-11-reject'));

    const dialog = byTestId('app-action-dialog')!;
    expect(dialog.textContent).toContain('Say why it is rejected.');
    expect(dialog.textContent).toContain('Reason');
    await click(byTestId('app-action-dialog-submit'));
    expect(api.runAppActionWithReplay).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain('Fill in the required fields.');

    await type(dialog.querySelector('textarea'), 'Over budget');
    await click(byTestId('app-action-dialog-submit'));
    expect(api.runAppActionWithReplay).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ actionId: 'reject', recordId: 11, values: [{ fieldId: 5, value: 'Over budget' }] }),
      LAPTOP,
    );
    expect(byTestId('app-action-dialog')).toBeNull();
    // The cards of that table were evaluated again.
    expect(api.queryAppCard.mock.calls.filter(([, input]) => input.cardId === 'mine').length).toBeGreaterThan(1);
  });

  it('shows a refused action in the viewer’s words', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine]));
    api.runAppActionWithReplay.mockRejectedValue(
      new TablesRequestError('precondition failed', 409, { reason: 'precondition' }),
    );
    await mount('5');
    await click(byTestId('app-action-11-approve'));
    expect(ui.toast).toHaveBeenCalledWith(
      expect.stringContaining('This action no longer applies to the record'),
      'error',
    );
  });

  it('creates through a records card and submits a form card', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine, CARDS.apply]));
    await mount('5');

    await click(byTestId('app-card-mine-new'));
    const create = byTestId('app-create-dialog')!;
    await type(create.querySelector('input'), 'Desk');
    await click(byTestId('app-create-dialog-submit'));
    expect(api.runAppAction).toHaveBeenCalledWith(
      5,
      expect.objectContaining({
        pageId: 'apply',
        cardId: 'mine',
        actionId: '$create',
        values: [{ fieldId: 1, value: 'Desk' }],
      }),
    );
    const firstRequest = api.runAppAction.mock.calls[0]![1].requestId;
    expect(firstRequest).toMatch(/^[\w-]{8,100}$/);

    const form = byTestId('app-form-apply')!;
    await type(form.querySelector('input'), 'Monitor');
    await click(byTestId('app-form-apply-submit'));
    expect(api.runAppAction).toHaveBeenLastCalledWith(
      5,
      expect.objectContaining({
        cardId: 'apply',
        actionId: '$submit',
        // Multi-value fields always travel (an empty attachment list is a value, as in Tables).
        values: [
          { fieldId: 1, value: 'Monitor' },
          { fieldId: 4, value: [] },
        ],
      }),
    );
    expect(api.runAppAction.mock.calls[1]![1].requestId).not.toBe(firstRequest);
  });

  it('leaves fields the role may only read out of the create dialog', async () => {
    // Field 6 (Due) is readable but not editable for this role; the gateway refuses it on a create.
    api.getApp.mockResolvedValue(viewWith([{ ...CARDS.mine, create: { fieldIds: [1, 6, 3] } }]));
    await mount('5');
    await click(byTestId('app-card-mine-new'));
    const create = byTestId('app-create-dialog')!;
    expect(create.textContent).toContain('Title');
    expect(create.textContent).toContain('Amount');
    expect(create.textContent).not.toContain('Due');
  });

  it('acts on a linked record through the page its card is on', async () => {
    const view = runtimeView();
    api.getApp.mockResolvedValue({
      ...view,
      spec: {
        ...view.spec,
        home: 'apply',
        pages: [
          { id: 'apply', title: 'Apply', cards: [CARDS.apply] },
          { id: 'review', title: 'Review', cards: [CARDS.mine] },
        ],
      },
    });
    const replace = vi.spyOn(window.location, 'replace').mockImplementation(() => undefined);
    await mount('5', 'record=11');
    expect(api.getAppRecord).toHaveBeenCalledWith(5, { pageId: 'review', cardId: 'mine', recordId: 11 });
    await click(byTestId('app-record-action-approve'));
    expect(api.runAppActionWithReplay).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ pageId: 'review', cardId: 'mine', actionId: 'approve' }),
      LAPTOP,
    );
    replace.mockRestore();
  });

  it('shows a manager’s never-published draft as not published', async () => {
    api.getApp.mockResolvedValue(runtimeView({ draft: true, version: 0, app: appSummary({ canManage: true }) }));
    await mount('5');
    expect(container.textContent).toContain('Not published yet');
    expect(api.queryAppCard).not.toHaveBeenCalled();
  });

  it('loads a calendar card for the weeks on screen, and again for another month', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00'));
    try {
      api.getApp.mockResolvedValue(viewWith([CARDS.due]));
      await mount('5');
      expect(api.queryAppCard).toHaveBeenCalledWith(
        5,
        expect.objectContaining({ cardId: 'due', range: { from: '2026-09-27', to: '2026-11-07' } }),
      );
      await click(document.querySelector('button[aria-label="Next month"]'));
      expect(api.queryAppCard).toHaveBeenLastCalledWith(
        5,
        expect.objectContaining({ cardId: 'due', range: { from: '2026-11-01', to: '2026-12-12' } }),
      );
      // A refresh (a write, someone else's change) keeps the month on screen.
      const page = [...realtime.listeners].reverse().find((listener) => listener.filter.baseId === 3)!;
      await act(async () => {
        await page.onChange();
      });
      expect(api.queryAppCard).toHaveBeenLastCalledWith(
        5,
        expect.objectContaining({ cardId: 'due', range: { from: '2026-11-01', to: '2026-12-12' } }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts a paged records card over at its first page when the page filters change', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const view = viewWith([CARDS.mine]);
      view.spec.pages[0]!.filters = [
        { id: 'q', label: 'Title', kind: 'search', targets: [{ tableId: 7, fieldId: 1 }] },
      ];
      api.getApp.mockResolvedValue(view);
      // A cursor is only good for the query it was read with (the server refuses it under other filters).
      api.queryAppCard.mockImplementation(async (_appId, input) =>
        input.cursor ? recordsResult([CHAIR], null) : recordsResult([LAPTOP], 'cursor-2'),
      );
      await mount('5');
      const next = [...document.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'Next');
      await click(next);
      expect(api.queryAppCard).toHaveBeenLastCalledWith(
        5,
        expect.objectContaining({ cardId: 'mine', cursor: 'cursor-2' }),
      );
      expect(byTestId('app-card-mine')?.textContent).toContain('Chair');

      await type(document.querySelector('input[placeholder="Search Title"]'), 'Desk');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      await flush();
      const [, input] = api.queryAppCard.mock.calls.at(-1)!;
      expect(input).toMatchObject({ cardId: 'mine', filterValues: { q: { kind: 'search', text: 'Desk' } } });
      expect(input).not.toHaveProperty('cursor');
      // The card is back on its first page.
      const card = byTestId('app-card-mine')!;
      expect(card.textContent).toContain('Laptop');
      expect(card.textContent).toContain('1–1 of 1');
      const previous = [...card.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === 'Prev');
      expect((previous as HTMLButtonElement).disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('loads a gallery card past its first page and says when the view limit cut it off', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.photos]));
    // The gateway pages a gallery by 50; this table has 520 records the role can read.
    let served = 0;
    api.queryAppCard.mockImplementation(async () => {
      const rows = Array.from({ length: 50 }, (_, index) => ({ ...CHAIR, id: 1000 + served + index }));
      served += rows.length;
      return { ...recordsResult(rows, `c-${served / 50}`), total: 520 };
    });
    await mount('5');
    // Up to the view limit (500) in one answer, like the Tables gallery container.
    expect(api.queryAppCard.mock.calls.map(([, input]) => input.cursor)).toEqual([
      undefined,
      'c-1',
      'c-2',
      'c-3',
      'c-4',
      'c-5',
      'c-6',
      'c-7',
      'c-8',
      'c-9',
    ]);
    expect(document.querySelectorAll('[data-testid^="gallery-card-"]')).toHaveLength(500);
    expect(byTestId('app-view-card-photos')?.textContent).toContain('Showing the first 500 of 520 records');
  });

  it('re-evaluates the cards of a table when its records change elsewhere', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine, CARDS.total, CARDS.intro]));
    await mount('5');
    const before = api.queryAppCard.mock.calls.length;
    const page = [...realtime.listeners].reverse().find((listener) => listener.filter.baseId === 3)!;
    await act(async () => {
      await page.onChange();
    });
    // Both cards read table 7; the text card asks nothing.
    expect(api.queryAppCard.mock.calls.slice(before).map(([, input]) => input.cardId)).toEqual(['mine', 'total']);
  });
});

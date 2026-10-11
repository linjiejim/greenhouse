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
  getApp: vi.fn<(appId: number, options?: { previewRole?: string }) => Promise<AppRuntimeView>>(),
  queryAppCard: vi.fn<(appId: number, input: Record<string, unknown>) => Promise<AppCardQueryResult>>(),
  getAppRecord: vi.fn<(appId: number, input: Record<string, unknown>) => Promise<AppRecordView>>(),
  runAppAction: vi.fn<(appId: number, input: AppActionInput) => Promise<AppActionResult>>(),
  runAppActionWithReplay: vi.fn<(appId: number, input: AppActionInput, base?: unknown) => Promise<AppActionResult>>(),
  listAppActivity: vi.fn(),
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
  it('shows the app, its role and version, the pages as tabs with the home page current, and tells the Assistant', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine]));
    await mount('5');

    expect(api.getApp).toHaveBeenCalledWith(5, {});
    expect(document.querySelector('h1')?.textContent).toBe('Purchase requests');
    expect(container.textContent).toContain('Applicant');
    expect(container.textContent).toContain('v2');
    expect(document.querySelector('a[href="#/apps/5/apply"]')?.getAttribute('aria-current')).toBe('page');
    expect(document.querySelector('a[href="#/apps/5/stats"]')?.hasAttribute('aria-current')).toBe(false);
    // The page's cards are evaluated for this viewer and page.
    expect(api.queryAppCard).toHaveBeenCalledWith(5, expect.objectContaining({ pageId: 'apply', cardId: 'mine' }));
    expect(container.textContent).toContain('Laptop');
    // Only managers see the preview bar and the builder link.
    expect(byTestId('app-preview-bar')).toBeNull();
    expect(document.querySelector('a[href="#/apps/5/edit"]')).toBeNull();
    expect(enrichPageContext).toHaveBeenLastCalledWith({
      appName: 'Purchase requests',
      version: 2,
      roleName: 'Applicant',
      pageId: 'apply',
      pageTitle: 'Apply',
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

    expect(byTestId('app-preview-bar')?.textContent).toContain('see all of it');
    expect(byTestId('app-issues-bar')?.textContent).toContain('Field 9 was deleted');
    expect(document.querySelector('a[href="#/apps/5/edit"]')).not.toBeNull();
    const select = byTestId('app-preview-role') as HTMLSelectElement;
    await act(async () => {
      select.value = 'applicant';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(window.location.hash).toBe('#/apps/5/apply?previewRole=applicant');

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

  it('re-evaluates the cards of a table when its records change elsewhere', async () => {
    api.getApp.mockResolvedValue(viewWith([CARDS.mine, CARDS.total, CARDS.intro]));
    await mount('5');
    const before = api.queryAppCard.mock.calls.length;
    const page = realtime.listeners.findLast((listener) => listener.filter.baseId === 3)!;
    await act(async () => {
      await page.onChange();
    });
    // Both cards read table 7; the text card asks nothing.
    expect(api.queryAppCard.mock.calls.slice(before).map(([, input]) => input.cardId)).toEqual(['mine', 'total']);
  });
});

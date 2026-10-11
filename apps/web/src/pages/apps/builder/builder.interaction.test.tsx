/** @vitest-environment happy-dom */

/**
 * The app builder under interaction, against mocked `/api/apps` and Tables
 * responses: cards added from the catalog, moved and configured (each change
 * autosaved with the draft revision); the actions editor saying what the
 * server would refuse; server problems shown on the card and in one list; a
 * lost save race asking to reload; the roles tab reusing the Phase 0 rule
 * editor; sharing read-only below the Base owner; the publish dialog's
 * changes and permission diff; and restoring a version into the draft.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AppAudiencesView,
  AppCard,
  AppDraftView,
  AppRuntimeView,
  AppSpec,
  AppSpecError,
  AppSummary,
} from '@greenhouse/types/apps';
import { I18nProvider } from '../../../lib/i18n';
import { TablesRequestError } from '../../../lib/api/tables';
import { ToastContainer } from '../../../components/ui';
import { AppsPage } from '../index';
import { AUTOSAVE_DELAY_MS } from './use-app-draft';
import { FIELDS, NOTES, REQUESTS, schemaFixture, specFixture } from './test-fixtures';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const enrichPageContext = vi.hoisted(() => vi.fn());
vi.mock('../../../components/agent-context', () => ({ useAgentContext: () => ({ enrichPageContext }) }));

const appsApi = vi.hoisted(() => ({
  getAppDraft: vi.fn(),
  saveAppDraft: vi.fn(),
  publishApp: vi.fn(),
  getPublishedApp: vi.fn(),
  listAppVersions: vi.fn(),
  restoreAppVersion: vi.fn(),
  getAppAudiences: vi.fn(),
  setAppAudiences: vi.fn(),
  getAppUsage: vi.fn(),
}));
vi.mock('../../../lib/api/apps-builder', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/apps-builder')>()),
  ...appsApi,
}));

const tablesApi = vi.hoisted(() => ({
  getTableBase: vi.fn(),
  getTableSchema: vi.fn(),
  listTableAutomations: vi.fn(),
  listTableUsers: vi.fn(),
  listTableBaseRoles: vi.fn(),
}));
vi.mock('../../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/tables')>()),
  ...tablesApi,
}));

vi.mock('../../../lib/api/apps', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../lib/api/apps')>()),
  listApps: vi.fn(async () => ({ managed: [], shared: [], featured: [] })),
  getAppPins: vi.fn(async () => []),
}));

// The grid measures its container; draw the cells, and let a test report a drag.
vi.mock('../../../components/workbench/widget-grid', () => ({
  WIDGET_DRAG_HANDLE_CLASS: 'widget-drag-handle',
  WidgetGrid: ({
    items,
    renderItem,
    onLayoutChange,
  }: {
    items: Array<{ id: string; x: number; y: number; w: number; h: number }>;
    renderItem: (id: string) => React.ReactNode;
    onLayoutChange?: (items: Array<{ id: string; x: number; y: number; w: number; h: number }>) => void;
  }) => (
    <div>
      {items.map((item) => (
        <div key={item.id}>{renderItem(item.id)}</div>
      ))}
      <button
        type="button"
        data-testid="grid-drag"
        onClick={() => onLayoutChange?.(items.map((item, index) => ({ ...item, x: index === 0 ? 6 : item.x, w: 6 })))}
      />
    </div>
  ),
}));

const APP_ID = 9;

function summary(patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id: APP_ID,
    baseId: 3,
    name: 'Purchases',
    description: null,
    icon: 'cart',
    accent: 'amber',
    ownerId: 'owner',
    status: 'draft',
    publishedVersion: null,
    featured: false,
    updatedAt: '2026-10-11T00:00:00.000Z',
    canManage: true,
    canPublish: true,
    pinned: false,
    ...patch,
  };
}

let revision = 4;
function draftView(spec: AppSpec, app: Partial<AppSummary> = {}, errors: AppSpecError[] = []): AppDraftView {
  return { app: summary(app), spec, draftRevision: revision, errors };
}

/** The spec of the n-th draft save (1-based), as sent. */
function saved(n = appsApi.saveAppDraft.mock.calls.length): { spec: AppSpec; revision: number } {
  const call = appsApi.saveAppDraft.mock.calls[n - 1]!;
  return { spec: call[1] as AppSpec, revision: call[2] as number };
}

let root: Root | null = null;
let container: HTMLDivElement;

async function flush() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function autosave() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50);
  });
  await flush();
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <AppsPage subPath={`${APP_ID}/edit`} />
        <ToastContainer />
      </I18nProvider>,
    ),
  );
  await flush();
}

const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector(selector) as T | null;

function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === label || entry.getAttribute('aria-label') === label,
  );
  if (!found) throw new Error(`no button "${label}"`);
  return found as HTMLButtonElement;
}

async function click(element: Element | null) {
  if (!element) throw new Error('nothing to click');
  await act(async () => (element as HTMLElement).click());
  await flush();
}

async function setValue(element: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const prototype =
      element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : element instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await flush();
}

function labelled<T extends Element>(label: string, scope: ParentNode = document): T {
  const field = [...scope.querySelectorAll('label')].find(
    (entry) => entry.textContent?.replace('*', '').trim() === label,
  );
  const id = field?.getAttribute('for');
  const control = id ? document.getElementById(id) : null;
  if (!control) throw new Error(`no control "${label}"`);
  return control as unknown as T;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  revision = 4;
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
  const schema = schemaFixture();
  tablesApi.getTableBase.mockResolvedValue({ tables: schema.tables });
  tablesApi.getTableSchema.mockImplementation(async (tableId: number) => ({
    table: schema.tables.find((table) => table.id === tableId),
    fields: schema.fieldsByTable.get(tableId),
    views: [],
  }));
  tablesApi.listTableAutomations.mockResolvedValue([
    { id: 41, table_id: REQUESTS, name: 'Notify the requester', trigger: 'button', status: 'enabled' },
  ]);
  tablesApi.listTableUsers.mockResolvedValue([{ id: 'owner', nickname: 'Olive', email: 'o@x', role: 'team' }]);
  tablesApi.listTableBaseRoles.mockResolvedValue({
    roles: [],
    references: [],
    facts: {
      tables: schema.tables.map((table) => ({ id: table.id, name: table.name })),
      fields: [...schema.fieldsByTable.values()].flat().map((field) => ({
        id: field.id,
        tableId: field.table_id,
        type: field.type,
        name: field.name,
      })),
      dependencies: [{ fieldId: FIELDS.total.id, dependsOnFieldId: FIELDS.amount.id }],
    },
  });
  appsApi.getAppDraft.mockImplementation(async () => draftView(specFixture()));
  appsApi.saveAppDraft.mockImplementation(async (_appId: number, spec: AppSpec) => {
    revision += 1;
    return draftView(spec);
  });
  appsApi.getAppAudiences.mockResolvedValue({
    entries: [{ principal: { type: 'team' }, roleKey: 'applicant', name: 'everyone' }],
    audiencesRevision: 2,
    roles: [{ key: 'applicant', name: 'Applicant' }],
  } satisfies AppAudiencesView);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('pages and cards', () => {
  it('adds a card from the catalog and autosaves it with the draft revision', async () => {
    await mount();
    expect(q('[data-testid="app-page-apply"]')?.textContent).toContain('Apply');
    expect(enrichPageContext).toHaveBeenLastCalledWith({ appName: 'Purchases' });

    await click(q('[data-testid="app-add-card"]'));
    // Every kind is offered; the board is available (Requests has a choice field).
    expect(document.querySelectorAll('[data-testid="app-card-catalog"] button')).toHaveLength(10);
    await click(q('[data-testid="app-catalog-kanban"]'));
    expect(q('[data-testid="app-save-state"]')?.dataset.state).toBe('pending');
    await autosave();

    expect(appsApi.saveAppDraft).toHaveBeenCalledTimes(1);
    const { spec, revision: sent } = saved();
    expect(sent).toBe(4);
    const board = spec.pages[0]!.cards[1] as Extract<AppCard, { kind: 'kanban' }>;
    expect(board).toMatchObject({ id: 'kanban-1', kind: 'kanban', source: { tableId: REQUESTS }, groupFieldId: 3 });
    expect(board.layout.y).toBe(6);
    expect(q('[data-testid="app-save-state"]')?.dataset.state).toBe('saved');
    // The new card is selected: its properties are open.
    expect(q('[data-testid="app-properties"]')?.textContent).toContain('Board card');
  });

  it('moves cards from the menu and from the grid, and saves the layouts', async () => {
    appsApi.getAppDraft.mockImplementation(async () => {
      const spec = specFixture();
      spec.pages[0]!.cards.push({ id: 'note', kind: 'text', layout: { x: 0, y: 6, w: 12, h: 2 }, markdown: 'Hi' });
      return draftView(spec);
    });
    await mount();
    await click(button('Actions for Note (no title)'.replace('Note', 'Text')));
    await click(button('Move earlier'));
    await autosave();
    let cards = saved().spec.pages[0]!.cards;
    expect(cards.find((card) => card.id === 'note')!.layout).toMatchObject({ y: 0 });
    expect(cards.find((card) => card.id === 'mine')!.layout).toMatchObject({ y: 6 });

    await click(q('[data-testid="grid-drag"]'));
    await autosave();
    cards = saved().spec.pages[0]!.cards;
    expect(cards[0]!.layout).toMatchObject({ x: 6, w: 6 });
  });

  it('configures the selected card: title, fields, which records', async () => {
    await mount();
    await click(q('[data-testid="app-canvas-card-mine"] button[aria-pressed]'));
    await setValue(q<HTMLInputElement>('[data-testid="app-card-title"]')!, 'Mine ');
    await click(button('Remove Amount'));
    const conditions = q('[data-testid="app-card-conditions"]')!;
    await click(button('Condition', conditions));
    // The first target is Item (text): the clause waits for a value before it is written.
    expect(conditions.textContent).toContain('Condition 1 has no value yet');
    await setValue(conditions.querySelector('input[aria-label="Value"]') as HTMLInputElement, 'Laptop');
    await autosave();
    const card = saved().spec.pages[0]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    expect(card.title).toBe('Mine');
    expect(card.fieldIds).toEqual([1, 3]);
    expect(card.source.query?.where?.clauses).toEqual([{ fieldId: 1, operator: 'eq', value: 'Laptop' }]);
  });

  it('adds a page and keeps a page a role sees alone from being deleted', async () => {
    await mount();
    await click(q('[data-testid="app-add-page"]'));
    await autosave();
    expect(saved().spec.pages.map((page) => page.id)).toEqual(['apply', 'approve', 'new-page']);

    await click(button('Actions for Apply'));
    await click(button('Delete page'));
    const dialog = q('[role="alertdialog"], [role="dialog"]')!;
    expect(dialog.textContent).toContain('Role “Applicant” sees only this page');
  });
});

describe('actions editor', () => {
  it('says what the server would refuse, and which roles cannot write the fields', async () => {
    await mount();
    await click(q('[data-testid="app-page-approve"]'));
    await click(q('[data-testid="app-canvas-card-queue"] button[aria-pressed]'));
    const rows = q('[data-testid="app-row-actions"]')!;
    expect(rows.querySelector('[data-testid="app-action-approve"]')).not.toBeNull();
    // The approver may edit Requests: no warning on Approve.
    expect(q('[data-testid="app-action-blocked-approve"]')).toBeNull();

    await click(button('Add a button', rows));
    const added = rows.querySelector('[data-testid="app-action-action-2"]') as HTMLElement;
    expect(added).not.toBeNull();
    // Valid from the start: it asks for the first field.
    expect(q('[data-testid="app-action-problems-action-2"]')).toBeNull();
    // Untick the asked field: nothing left to do.
    const itemBox = [...added.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Item')!;
    await click(itemBox.querySelector('input'));
    expect(q('[data-testid="app-action-problems-action-2"]')?.textContent).toContain(
      'Set at least one field, or ask for one.',
    );
    // It applies to every role that sees the page — the approver only, who may edit.
    expect(q('[data-testid="app-action-blocked-action-2"]')).toBeNull();

    // Limited to the applicant (no rule on Requests): the editor warns before the server refuses.
    const reasonBox = [...added.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Reason')!;
    await click(reasonBox.querySelector('input'));
    await click(button('Only some roles', added));
    const who = added.querySelector('[role="group"][aria-label="Who may use it"]')!;
    const applicantBox = [...who.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Applicant')!;
    const approverBox = [...who.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Approver')!;
    await click(approverBox.querySelector('input'));
    expect((applicantBox.querySelector('input') as HTMLInputElement).checked).toBe(true);
    expect(q('[data-testid="app-action-blocked-action-2"]')?.textContent).toContain('Applicant');

    // Run an automation: only the table's button rules are offered.
    await setValue(labelled<HTMLSelectElement>('What it does', added), 'run_automation');
    expect([...labelled<HTMLSelectElement>('Automation', added).options].map((option) => option.textContent)).toEqual([
      'Notify the requester',
    ]);
    await autosave();
    const queue = saved().spec.pages[1]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    expect(queue.actions![1]).toMatchObject({
      id: 'action-2',
      label: 'New button',
      roles: ['applicant'],
      do: { type: 'run_automation', ruleId: 41 },
    });
  });

  it('writes an approval: values with tokens, a required reason and a precondition', async () => {
    await mount();
    await click(q('[data-testid="app-page-approve"]'));
    await click(q('[data-testid="app-canvas-card-queue"] button[aria-pressed]'));
    const approve = q('[data-testid="app-action-approve"]')!;
    await click(button('Add a value', approve));
    // Next free field after Status (already set): Item → change it to Approver, which takes "the person pressing it".
    const fieldSelects = [...approve.querySelectorAll('select[aria-label="Field"]')] as HTMLSelectElement[];
    await setValue(fieldSelects[1]!, String(FIELDS.approver.id));
    // Ask for a reason, and require it.
    const reasonBox = [...approve.querySelectorAll('label')].find((label) => label.textContent?.trim() === 'Reason')!;
    await click(reasonBox.querySelector('input'));
    const requiredBox = [...approve.querySelectorAll('label')].find(
      (label) => label.textContent?.trim() === 'Required',
    )!;
    await click(requiredBox.querySelector('input'));
    const whenEditor = q('[data-testid="app-action-when-approve"]')!;
    await click(button('Condition', whenEditor));
    await setValue(whenEditor.querySelector('select[aria-label="Choose field"]') as HTMLSelectElement, 's:created_by');
    await setValue(whenEditor.querySelector('select[aria-label="Operator"]') as HTMLSelectElement, 'neq');
    await setValue(whenEditor.querySelector('select[aria-label="Value"]') as HTMLSelectElement, '$me');
    await autosave();
    const action = (saved().spec.pages[1]!.cards[0] as Extract<AppCard, { kind: 'records' }>).actions![0]!;
    expect(action.do).toEqual({
      type: 'set_fields',
      values: [
        { fieldId: 3, value: 'approved' },
        { fieldId: FIELDS.approver.id, value: '$me' },
      ],
      inputFieldIds: [FIELDS.reason.id],
      requiredInputFieldIds: [FIELDS.reason.id],
    });
    expect(action.when).toEqual({
      combinator: 'and',
      clauses: [{ systemField: 'created_by', operator: 'neq', value: '$me' }],
    });
  });
});

describe('saving', () => {
  it('shows the server’s problems on the card and in one list', async () => {
    const problems: AppSpecError[] = [
      {
        path: 'pages[0].cards[0].fieldIds[0]',
        pageId: 'apply',
        cardId: 'mine',
        message: 'Field 99 does not exist on table 7',
      },
      { path: 'roles[1].tables', roleKey: 'approver', message: 'Rows need a person field' },
    ];
    appsApi.getAppDraft.mockImplementation(async () => draftView(specFixture(), {}, problems));
    await mount();
    expect(button('Problems: 2')).toBeTruthy();
    expect(q('[data-testid="app-canvas-card-mine"]')?.textContent).toContain('Problems: 1');
    await click(q('[data-testid="app-canvas-card-mine"] button[aria-pressed]'));
    expect(q('[data-testid="app-card-properties"]')?.textContent).toContain('Field 99 does not exist on table 7');
    await click(button('Problems: 2'));
    const list = q('[data-testid="app-problems"]')!;
    expect(list.textContent).toContain('“My requests” on “Apply”');
    expect(list.textContent).toContain('Role “Approver”');
  });

  it('keeps a refused draft unsaved and says why; a lost race asks to reload', async () => {
    await mount();
    appsApi.saveAppDraft.mockRejectedValueOnce(
      new TablesRequestError('spec_invalid', 400, {
        reason: 'spec_invalid',
        errors: [{ path: 'pages[0].title', pageId: 'apply', message: 'Too short' }],
      }),
    );
    await click(q('[data-testid="app-add-page"]'));
    await autosave();
    expect(q('[data-testid="app-save-state"]')?.dataset.state).toBe('invalid');
    expect(button('Problems: 1')).toBeTruthy();

    appsApi.saveAppDraft.mockRejectedValueOnce(
      new TablesRequestError('The draft changed since you loaded it', 409, {
        reason: 'draft_conflict',
        currentRevision: 8,
      }),
    );
    await click(q('[data-testid="app-add-page"]'));
    await autosave();
    expect(q('[data-testid="app-draft-conflict"]')?.textContent).toContain('This draft changed somewhere else.');
    appsApi.getAppDraft.mockClear();
    await click(button('Reload the draft', q('[data-testid="app-draft-conflict"]')!));
    expect(appsApi.getAppDraft).toHaveBeenCalledTimes(1);
    expect(q('[data-testid="app-draft-conflict"]')).toBeNull();
  });
});

describe('roles, sharing', () => {
  it('reuses the Base rule editor for an app role, without its dashboards switch', async () => {
    await mount();
    await click(q('[data-testid="app-tab-roles"]'));
    await click(q('[data-testid="app-role-applicant"]'));
    const editor = q('[data-testid="role-editor"]')!;
    expect(editor).not.toBeNull();
    expect(editor.textContent).not.toContain('Dashboards');
    // The owner's facts carry the dependency edges: no "settled by the server" note.
    expect(q('[data-testid="app-roles-tab"]')?.textContent).not.toContain(
      'Only the Base owner sees that worked out here',
    );
    const requests = editor.querySelector(`[data-testid="role-table-${REQUESTS}"]`)!;
    await click(button('Can read', requests));
    await click(q('[data-testid="app-role-approver"]'));
    await autosave();
    const applicant = saved().spec.roles.find((role) => role.key === 'applicant')!;
    expect(applicant.tables).toEqual([{ tableId: REQUESTS, access: 'read', fields: [], fieldDefault: 'hidden' }]);
    // The approver's pages: some pages, at least one stays ticked.
    expect(q('[data-testid="app-role-pages"]')).toBeNull();
    await click(button('Some pages'));
    const pages = q('[data-testid="app-role-pages"]')!;
    expect(pages.querySelectorAll('input:checked')).toHaveLength(2);
  });

  it('shows sharing read-only to a builder who is not the Base owner', async () => {
    appsApi.getAppDraft.mockImplementation(async () => draftView(specFixture(), { canPublish: false }));
    await mount();
    expect(tablesApi.listTableBaseRoles).not.toHaveBeenCalled();
    expect(button('Publish').disabled).toBe(true);
    await click(q('[data-testid="app-tab-audiences"]'));
    expect(q('[data-testid="app-audiences-readonly"]')?.textContent).toContain('Only the Base owner');
    expect(q('[data-testid="app-audiences-save"]')).toBeNull();
    expect(q('[data-testid="app-audience-entry"]')?.textContent).toContain('Everyone');
    // Without the owner's facts, the roles tab says computed fields are settled by the server.
    await click(q('[data-testid="app-tab-roles"]'));
    expect(q('[data-testid="app-roles-tab"]')?.textContent).toContain('Only the Base owner sees that worked out here');
  });
});

describe('publishing and versions', () => {
  it('shows what changes and which permissions move, then publishes the saved revision', async () => {
    const live = specFixture();
    const draft = specFixture();
    draft.pages.push({
      id: 'stats',
      title: 'Stats',
      cards: [{ id: 't', kind: 'text', layout: { x: 0, y: 0, w: 12, h: 2 }, markdown: '' }],
    });
    draft.roles[0]!.tables = [{ tableId: REQUESTS, access: 'read', fields: [], fieldDefault: 'visible' }];
    draft.roles = draft.roles
      .filter((role) => role.key !== 'approver')
      .concat({
        key: 'approver',
        name: 'Approver',
        pages: 'all',
        tables: [
          {
            tableId: REQUESTS,
            access: 'edit',
            fields: [{ fieldId: FIELDS.reason.id, access: 'hidden' }],
            fieldDefault: 'visible',
          },
        ],
      });
    appsApi.getAppDraft.mockImplementation(async () => draftView(draft, { publishedVersion: 1, status: 'published' }));
    appsApi.getPublishedApp.mockResolvedValue({ spec: live } as AppRuntimeView);
    appsApi.getAppAudiences.mockResolvedValue({
      entries: [
        { principal: { type: 'team' }, roleKey: 'applicant', name: 'everyone' },
        {
          principal: { type: 'group', groupId: 5 },
          roleKey: 'approver',
          name: 'Finance',
          managedBy: { id: 'u8', name: 'Ada' },
        },
      ],
      audiencesRevision: 3,
      roles: [
        { key: 'applicant', name: 'Applicant' },
        { key: 'approver', name: 'Approver' },
      ],
    });
    appsApi.publishApp.mockResolvedValue({
      app: summary({ publishedVersion: 2, status: 'published' }),
      version: {
        version: 2,
        notes: 'Stats',
        publishedBy: { id: 'owner', name: 'Olive' },
        publishedAt: '',
        draftRevision: 4,
        specHash: 'x',
      },
    });
    await mount();
    expect(q('[data-testid="app-builder-status"]')?.textContent).toBe('v1 is live');
    await click(button('Publish'));
    const dialog = q('[data-testid="app-publish-dialog"]')!;
    expect(dialog.textContent).toContain('New page “Stats” (cards: 1)');
    const permissions = q('[data-testid="app-publish-permissions"]')!.textContent!;
    expect(permissions).toContain('Applicant');
    expect(permissions).toContain('No access');
    expect(permissions).toContain('Can read');
    expect(permissions).toContain('Requests · Reason');
    const audiences = q('[data-testid="app-publish-audiences"]')!.textContent!;
    expect(audiences).toContain('Members managed by Ada');
    expect(audiences).toContain('Everyone');

    await setValue(q<HTMLTextAreaElement>('[data-testid="app-publish-notes"]')!, 'Stats');
    await click(q('[data-testid="app-publish-confirm"]'));
    expect(appsApi.publishApp).toHaveBeenCalledWith(APP_ID, { draftRevision: 4, notes: 'Stats' });
    expect(q('[data-testid="app-builder-status"]')?.textContent).toBe('v2 is live');
  });

  it('restores an old version into the draft', async () => {
    appsApi.getAppDraft.mockImplementation(async () =>
      draftView(specFixture(), { publishedVersion: 2, status: 'published' }),
    );
    appsApi.listAppVersions.mockResolvedValue([
      {
        version: 2,
        notes: null,
        publishedBy: { id: 'owner', name: 'Olive' },
        publishedAt: '2026-10-11T08:00:00.000Z',
        draftRevision: 3,
        specHash: 'b',
      },
      {
        version: 1,
        notes: 'First',
        publishedBy: { id: 'owner', name: 'Olive' },
        publishedAt: '2026-10-10T08:00:00.000Z',
        draftRevision: 1,
        specHash: 'a',
      },
    ]);
    const restored = specFixture();
    restored.pages[0]!.title = 'Old apply';
    appsApi.restoreAppVersion.mockImplementation(async () => {
      revision = 9;
      return draftView(restored, { publishedVersion: 2, status: 'published' });
    });
    await mount();
    await click(q('[data-testid="app-versions-button"]'));
    expect(q('[data-testid="app-version-2"]')?.textContent).toContain('Live');
    expect(q('[data-testid="app-version-1"]')?.textContent).toContain('First');
    await click(q('[data-testid="app-version-restore-1"]'));
    await click(button('Restore to draft', q('[role="alertdialog"]') ?? document));
    expect(appsApi.restoreAppVersion).toHaveBeenCalledWith(APP_ID, 1, 4);
    expect(q('[data-testid="app-page-apply"]')?.textContent).toContain('Old apply');
    // The next save names the restored draft's revision.
    await click(q('[data-testid="app-add-page"]'));
    await autosave();
    expect(saved().revision).toBe(9);
  });
});

describe('the second table', () => {
  it('moves a card to another table and starts its fields over', async () => {
    await mount();
    await click(q('[data-testid="app-canvas-card-mine"] button[aria-pressed]'));
    await setValue(labelled<HTMLSelectElement>('Table', q('[data-testid="app-card-properties"]')!), String(NOTES));
    await autosave();
    const card = saved().spec.pages[0]!.cards[0] as Extract<AppCard, { kind: 'records' }>;
    expect(card.source.tableId).toBe(NOTES);
    expect(card.fieldIds).toEqual([FIELDS.note.id]);
    // A title the builder wrote stays.
    expect(card.title).toBe('My requests');
  });
});

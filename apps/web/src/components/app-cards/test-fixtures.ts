/**
 * Test fixtures for app cards and the runtime: one "purchase requests" app as
 * the gateway would describe it (field metadata, rows with refs) and a host
 * whose every call is a spy. Not imported by production code.
 */

import { vi } from 'vitest';
import type {
  AppCard,
  AppCardQueryResult,
  AppRecordRow,
  AppRuntimeView,
  AppSpec,
  AppSummary,
} from '@greenhouse/types/apps';
import type { TableCardState } from '../table-cards';
import type { AppCardHost } from './types';

export const TABLE_ID = 7;

export function appSummary(patch: Partial<AppSummary> = {}): AppSummary {
  return {
    id: 5,
    baseId: 3,
    name: 'Purchase requests',
    description: 'Ask, approve, report',
    icon: 'cart',
    accent: 'amber',
    ownerId: 'owner',
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

export const FIELDS: AppRuntimeView['tables'][number]['fields'] = [
  { id: 1, name: 'Title', type: 'text', isPrimary: true, config: {}, editable: true, required: true },
  {
    id: 2,
    name: 'Status',
    type: 'single_select',
    isPrimary: false,
    config: {
      options: [
        { id: 'pending', label: 'Pending' },
        { id: 'approved', label: 'Approved' },
        { id: 'rejected', label: 'Rejected' },
      ],
    },
    editable: true,
  },
  { id: 3, name: 'Amount', type: 'number', isPrimary: false, config: {}, editable: true },
  { id: 4, name: 'Receipt', type: 'attachment', isPrimary: false, config: {}, editable: true },
  { id: 5, name: 'Reason', type: 'long_text', isPrimary: false, config: {}, editable: true },
  { id: 6, name: 'Due', type: 'date', isPrimary: false, config: {}, editable: false },
];

export function row(id: number, values: Record<string, unknown>, actionIds: string[] = []): AppRecordRow {
  return {
    id,
    revision: 3,
    values,
    createdBy: 'u1',
    createdAt: '2026-10-01T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
    actionIds,
  };
}

export const LAPTOP = row(11, { '1': 'Laptop', '2': 'pending', '3': 1200, '4': [31], '6': '2026-10-15' }, [
  'approve',
  'reject',
]);
export const CHAIR = row(12, { '1': 'Chair', '2': 'approved', '3': 90 });

export function recordsResult(rows: AppRecordRow[] = [LAPTOP, CHAIR], nextCursor: string | null = null) {
  return {
    kind: 'records' as const,
    records: rows,
    total: rows.length,
    nextCursor,
    refs: {
      users: { u1: { nickname: 'Mia' } },
      records: {},
      files: { '31': { name: 'quote.pdf', size: 12, mimeType: 'application/pdf' } },
    },
  };
}

export const APPROVE = {
  id: 'approve',
  label: 'Approve',
  do: { type: 'set_fields' as const, values: [{ fieldId: 2, value: 'approved' }] },
};
export const REJECT = {
  id: 'reject',
  label: 'Reject',
  confirm: 'Say why it is rejected.',
  do: {
    type: 'set_fields' as const,
    values: [{ fieldId: 2, value: 'rejected' }],
    inputFieldIds: [5],
    requiredInputFieldIds: [5],
  },
};

const layout = { x: 0, y: 0, w: 6, h: 5 };
const source = { tableId: TABLE_ID };

export const CARDS = {
  mine: {
    id: 'mine',
    title: 'My requests',
    kind: 'records',
    layout,
    source,
    fieldIds: [1, 3, 4],
    detail: { fieldIds: [1, 2, 3, 4], editableFieldIds: [3], comments: true },
    create: { fieldIds: [1, 3] },
    actions: [APPROVE, REJECT],
  },
  list: { id: 'list', title: 'As a list', kind: 'records', display: 'list', layout, source, fieldIds: [1, 3] },
  board: {
    id: 'board',
    title: 'To approve',
    kind: 'kanban',
    layout,
    source,
    groupFieldId: 2,
    fieldIds: [3],
    detail: { fieldIds: [1, 2, 3] },
    actions: [APPROVE, REJECT],
    move: {},
  },
  due: { id: 'due', title: 'Due dates', kind: 'calendar', layout, source, startFieldId: 6, fieldIds: [1] },
  photos: { id: 'photos', title: 'Receipts', kind: 'gallery', layout, source, coverFieldId: 4, fieldIds: [3] },
  apply: {
    id: 'apply',
    title: 'New request',
    kind: 'form',
    layout,
    tableId: TABLE_ID,
    fieldIds: [1, 3, 4],
    submitLabel: 'Send request',
    successMessage: 'Finance will look at it.',
  },
  total: {
    id: 'total',
    title: 'Spent',
    kind: 'kpi',
    layout,
    card: { kind: 'kpi', source, aggregate: { operation: 'sum', valueFieldId: 3 } },
  },
  intro: { id: 'intro', kind: 'text', layout, markdown: '**Ask** for what you need.' },
  links: {
    id: 'links',
    title: 'Shortcuts',
    kind: 'buttons',
    layout,
    buttons: [
      { id: 'stats', label: 'Statistics', type: 'open_page', pageId: 'stats' },
      { id: 'bad', label: 'Bad link', type: 'open_url', url: 'javascript:alert(1)' },
      { id: 'quick', label: 'Quick request', type: 'create_record', tableId: TABLE_ID, fieldIds: [1] },
    ],
  },
} satisfies Record<string, AppCard>;

export function appSpec(cards: AppCard[] = Object.values(CARDS)): AppSpec {
  return {
    version: 1,
    home: 'apply',
    pages: [
      { id: 'apply', title: 'Apply', icon: 'clipboard', cards },
      { id: 'stats', title: 'Statistics', icon: 'chart', cards: [CARDS.total] },
    ],
    roles: [{ key: 'applicant', name: 'Applicant', pages: 'all', tables: [] }],
  };
}

export function runtimeView(patch: Partial<AppRuntimeView> = {}): AppRuntimeView {
  return {
    app: appSummary(),
    version: 2,
    role: { key: 'applicant', name: 'Applicant' },
    spec: appSpec(),
    tables: [{ id: TABLE_ID, name: 'Requests', fields: FIELDS }],
    issues: [],
    ...patch,
  };
}

export function mockHost(patch: Partial<AppCardHost> = {}): AppCardHost {
  return {
    appId: 5,
    pageId: 'apply',
    view: runtimeView(),
    preview: {},
    users: [{ id: 'u1', nickname: 'Mia', email: '' }],
    setParams: vi.fn(),
    retry: vi.fn(),
    openRecord: vi.fn(),
    runAction: vi.fn(),
    openCreate: vi.fn(),
    submitForm: vi.fn(async () => undefined),
    move: vi.fn(async () => undefined),
    openPage: vi.fn(),
    fileUrl: vi.fn(
      (_card, recordId: number, fieldId: number, fileId: number) =>
        `/api/apps/5/files/${fileId}?recordId=${recordId}&fieldId=${fieldId}`,
    ),
    upload: vi.fn(async (_card, _fieldId: number, file: File) => ({ id: 77, name: file.name, size: file.size })),
    loadOptions: vi.fn(async () => ({ options: [] })),
    describeError: vi.fn((error: unknown) => (error instanceof Error ? error.message : 'failed')),
    ...patch,
  };
}

export function stateOf(
  result: AppCardQueryResult | undefined,
  error: string | null = null,
): TableCardState<AppCardQueryResult> {
  return { card: null, result, error };
}

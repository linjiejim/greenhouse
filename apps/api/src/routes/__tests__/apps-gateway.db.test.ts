/**
 * The app gateway over HTTP (Tables → Apps Phase 1, slice G; real PostgreSQL,
 * rolled back per test), on a procurement app shared with everyone as
 * "applicant" and with the Finance group as "approver" — neither is a Base
 * member:
 *
 * - acceptance 2: an applicant sees only their own requests, never the hidden
 *   "Approval note" (card rows, the drawer, activity, the spec they receive),
 *   reaches nothing through /api/tables, downloads only their own attachment,
 *   and loses every app read when `tables.data.read` is revoked;
 * - acceptance 3: approving writes status / approver / time as the approver
 *   (`actorKind: 'app'`), `when` refuses a second approval and self-approval
 *   (created_by ≠ $me), a rejection needs its reason, a repeated requestId
 *   replays, a stale revision conflicts, and the notify automation reaches the
 *   applicant through the app's link with the hidden field rendered "—";
 * - acceptance 5: D2 (a builder cannot publish) and D6 (archiving a referenced
 *   field, dropping a used option or deleting a used rule answers 409 with the
 *   places; `confirm: true` proceeds and the card turns unavailable);
 * - acceptance 9: usage from the app-scoped audit and the action ledger, and
 *   the Base audit lists the app's writes, not its reads;
 * - field options (people; linked records only inside the role's read scope),
 *   uploads only where the card writes the field, page filters and `$page`
 *   (a `null` value = cleared), kanban moves, D3 role resolution, managers'
 *   preview, the realtime audience, the action ledger's 30-day prune;
 * - the query budget of one card query (per-request reuse, counted at the
 *   postgres-js prepared query).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { PostgresJsPreparedQuery } from 'drizzle-orm/postgres-js/session';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type {
  AppActionResult,
  AppCardQueryResult,
  AppDraftView,
  AppFieldOptionsView,
  AppRecordView,
  AppRuntimeView,
  AppSpec,
  AppUsageView,
} from '@greenhouse/types/apps';
import type { TableRecordActivityPage } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import appRoutes from '../apps.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { canRecipientRead } from '../../platform/tables/access.js';
import { sweepAppActionLedger } from '../../platform/tables/app-actions.js';
import { appAudienceForTable, pickViewerRole } from '../../platform/tables/app-audience.js';
import { createTablesAutomationRunner } from '../../platform/tables/automation-worker.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { deleteObjectAtKey } from '../../storage/uploads.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let applicant: UserRow;
let colleague: UserRow;
let approver: UserRow;
let outsider: UserRow;
let everyone: UserRow[];
const stagedKeys: string[] = [];

function createHttpApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = everyone.find((entry) => entry.id === c.req.header('x-test-user'));
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  app.route('/api/apps', appRoutes);
  return app;
}

let http: ReturnType<typeof createHttpApp>;

function send(user: UserRow, path: string, method = 'GET', body?: unknown) {
  return http.request(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-test-user': user.id },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function json<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

// Each case drives a whole app over HTTP (dozens of requests): room for a loaded full run.
vi.setConfig({ testTimeout: 30_000 });

let requestCounter = 0;
const requestId = () => `req-${Date.now()}-${(requestCounter += 1)}`;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, builder, applicant, colleague, approver, outsider] = await Promise.all(
    ['owner', 'builder', 'applicant', 'colleague', 'approver', 'outsider'].map((who) =>
      createInternalTestUser(db, { email: `apps-gw-${who}-${tag}@test.local`, nickname: `GW ${who}` }),
    ),
  );
  everyone = [owner, builder, applicant, colleague, approver, outsider];
  initializePlatformRuntime(db, [tablesRegistration]);
  http = createHttpApp();
});

afterEach(async () => {
  for (const key of stagedKeys.splice(0)) await deleteObjectAtKey(key).catch(() => undefined);
  resetPlatformRuntimeForTests();
  _resetProvider();
});

// ─── The procurement app ──────────────────────────────────

interface Fields {
  title: number;
  amount: number;
  status: number;
  approver: number;
  approvedAt: number;
  rejectReason: number;
  note: number;
  receipt: number;
  dept: number;
  requestedFor: number;
  vendor: number;
}

interface Procurement {
  baseId: number;
  tableId: number;
  vendors: { tableId: number; name: number; ok: number; acme: number; shady: number };
  f: Fields;
  appId: number;
  groupId: number;
  spec: AppSpec;
}

function procurementSpec(tableId: number, f: Fields, vendors: Procurement['vendors']): AppSpec {
  const layout = { x: 0, y: 0, w: 12, h: 6 };
  return {
    version: 1,
    pages: [
      {
        id: 'mine',
        title: 'My requests',
        cards: [
          {
            id: 'my-requests',
            kind: 'records',
            layout,
            source: {
              tableId,
              query: {
                where: { combinator: 'and', clauses: [{ systemField: 'created_by', operator: 'eq', value: '$me' }] },
              },
            },
            fieldIds: [f.title, f.amount, f.status, f.receipt],
            detail: {
              fieldIds: [f.title, f.amount, f.status, f.receipt, f.note, f.rejectReason, f.approver, f.approvedAt],
              comments: true,
            },
          },
          {
            id: 'new-request',
            kind: 'form',
            layout,
            tableId,
            fieldIds: [f.title, f.amount, f.receipt, f.dept, f.requestedFor, f.vendor],
            defaults: [{ fieldId: f.status, value: 'pending' }],
          },
        ],
      },
      {
        id: 'review',
        title: 'Review',
        filters: [{ id: 'dept', label: 'Department', kind: 'select', targets: [{ tableId, fieldId: f.dept }] }],
        cards: [
          {
            id: 'queue',
            title: 'Pending',
            kind: 'records',
            layout,
            source: {
              tableId,
              query: {
                where: { combinator: 'and', clauses: [{ fieldId: f.status, operator: 'eq', value: 'pending' }] },
              },
            },
            fieldIds: [f.title, f.amount, f.dept, f.note],
            actions: [
              {
                id: 'approve',
                label: 'Approve',
                when: {
                  combinator: 'and',
                  clauses: [
                    { fieldId: f.status, operator: 'eq', value: 'pending' },
                    { systemField: 'created_by', operator: 'neq', value: '$me' },
                  ],
                },
                do: {
                  type: 'set_fields',
                  values: [
                    { fieldId: f.status, value: 'approved' },
                    { fieldId: f.approver, value: '$me' },
                    { fieldId: f.approvedAt, value: '$now' },
                  ],
                },
              },
              {
                id: 'reject',
                label: 'Reject',
                when: { combinator: 'and', clauses: [{ fieldId: f.status, operator: 'eq', value: 'pending' }] },
                do: {
                  type: 'set_fields',
                  values: [{ fieldId: f.status, value: 'rejected' }],
                  inputFieldIds: [f.rejectReason],
                  requiredInputFieldIds: [f.rejectReason],
                },
              },
            ],
            detail: {
              fieldIds: [f.title, f.amount, f.dept, f.note, f.status],
              editableFieldIds: [f.note],
              comments: true,
            },
          },
          {
            id: 'by-dept',
            kind: 'records',
            layout,
            source: {
              tableId,
              query: {
                where: { combinator: 'and', clauses: [{ fieldId: f.dept, operator: 'in', value: '$page.dept' }] },
              },
            },
            fieldIds: [f.title, f.dept],
          },
          {
            id: 'board',
            kind: 'kanban',
            layout,
            source: { tableId },
            groupFieldId: f.status,
            fieldIds: [f.title],
            move: { roles: ['approver'] },
          },
        ],
      },
      {
        id: 'stats',
        title: 'Stats',
        cards: [
          {
            id: 'total',
            kind: 'kpi',
            layout,
            card: { kind: 'kpi', source: { tableId }, aggregate: { operation: 'sum', valueFieldId: f.amount } },
          },
          {
            id: 'per-dept',
            kind: 'chart',
            layout,
            card: {
              kind: 'chart',
              source: { tableId },
              aggregate: { operation: 'count', groupBy: { fieldId: f.dept } },
              chart: { type: 'bar' },
            },
          },
        ],
      },
    ],
    roles: [
      {
        key: 'applicant',
        name: 'Applicant',
        pages: ['mine'],
        canComment: true,
        tables: [
          {
            tableId,
            access: 'edit',
            rows: { type: 'related', creator: true, fieldIds: [] },
            fields: [
              { fieldId: f.note, access: 'hidden' },
              { fieldId: f.status, access: 'read' },
              { fieldId: f.approver, access: 'read' },
              { fieldId: f.approvedAt, access: 'read' },
              { fieldId: f.rejectReason, access: 'read' },
            ],
            fieldDefault: 'visible',
            create: true,
          },
          {
            tableId: vendors.tableId,
            access: 'read',
            rows: {
              type: 'where',
              where: { combinator: 'and', clauses: [{ fieldId: vendors.ok, operator: 'eq', value: true }] },
            },
            fields: [],
            fieldDefault: 'visible',
          },
        ],
      },
      {
        key: 'approver',
        name: 'Approver',
        pages: ['review', 'stats'],
        canComment: true,
        tables: [
          {
            tableId,
            access: 'edit',
            fields: [
              { fieldId: f.title, access: 'read' },
              { fieldId: f.amount, access: 'read' },
              { fieldId: f.dept, access: 'read' },
              { fieldId: f.receipt, access: 'read' },
              { fieldId: f.status, access: 'edit' },
              { fieldId: f.approver, access: 'edit' },
              { fieldId: f.approvedAt, access: 'edit' },
              { fieldId: f.rejectReason, access: 'edit' },
              { fieldId: f.note, access: 'edit' },
            ],
            fieldDefault: 'hidden',
            create: false,
          },
        ],
      },
    ],
  };
}

async function procurement(): Promise<Procurement> {
  const created = await json<{
    base: { id: number };
    schema: { table: { id: number }; fields: Array<{ id: number }> };
  }>(await send(owner, '/api/tables/bases', 'POST', { name: 'Purchasing', defaultTableName: 'Requests' }), 201);
  const baseId = created.base.id;
  const tableId = created.schema.table.id;
  const field = async (table: number, name: string, type: string, config?: unknown) =>
    (
      await json<{ field: { id: number } }>(
        await send(owner, `/api/tables/tables/${table}/fields`, 'POST', { name, type, config }),
        201,
      )
    ).field.id;
  const vendorTable = await json<{ table: { id: number }; fields: Array<{ id: number }> }>(
    await send(owner, `/api/tables/bases/${baseId}/tables`, 'POST', { name: 'Vendors' }),
    201,
  );
  const vendorOk = await field(vendorTable.table.id, 'Approved', 'boolean');
  const vendorName = vendorTable.fields[0]!.id;
  const vendorRecord = async (name: string, approved: boolean) =>
    (
      await json<{ record: { id: number } }>(
        await send(owner, `/api/tables/tables/${vendorTable.table.id}/records`, 'POST', {
          values: { [vendorName]: name, [vendorOk]: approved },
        }),
        201,
      )
    ).record.id;
  const vendors = {
    tableId: vendorTable.table.id,
    name: vendorName,
    ok: vendorOk,
    acme: await vendorRecord('Acme', true),
    shady: await vendorRecord('Shady', false),
  };
  const options = (...ids: string[]) => ({ options: ids.map((id) => ({ id, label: id })) });
  const f: Fields = {
    title: created.schema.fields[0]!.id,
    amount: await field(tableId, 'Amount', 'number'),
    status: await field(tableId, 'Status', 'single_select', options('pending', 'approved', 'rejected')),
    approver: await field(tableId, 'Approver', 'user'),
    approvedAt: await field(tableId, 'Approved at', 'datetime'),
    rejectReason: await field(tableId, 'Reject reason', 'long_text'),
    note: await field(tableId, 'Approval note', 'text'),
    receipt: await field(tableId, 'Receipt', 'attachment'),
    dept: await field(tableId, 'Department', 'single_select', options('ops', 'eng')),
    requestedFor: await field(tableId, 'Requested for', 'user'),
    vendor: await field(tableId, 'Vendor', 'relation', { relation: { targetTableId: vendors.tableId } }),
  };
  await json(await send(owner, `/api/tables/bases/${baseId}/members/${builder.id}`, 'PUT', { role: 'builder' }));
  const group = await db.groups.create({ name: `Finance ${Math.random()}`, created_by: owner.id });
  await db.groups.addMembers(group.id, [approver.id], owner.id);

  const spec = procurementSpec(tableId, f, vendors);
  const draft = await json<AppDraftView>(
    await send(owner, '/api/apps', 'POST', { baseId, name: 'Purchasing', spec }),
    201,
  );
  expect(draft.errors).toEqual([]);
  await json(await send(owner, `/api/apps/${draft.app.id}/publish`, 'POST', { draftRevision: draft.draftRevision }));
  await json(
    await send(owner, `/api/apps/${draft.app.id}/audiences`, 'PUT', {
      entries: [
        { principal: { type: 'team' }, roleKey: 'applicant' },
        { principal: { type: 'group', groupId: group.id }, roleKey: 'approver' },
      ],
      audiencesRevision: 1,
    }),
  );
  return { baseId, tableId, vendors, f, appId: draft.app.id, groupId: group.id, spec: draft.spec };
}

// ─── Small clients ────────────────────────────────────────

function cardQuery(p: Procurement, user: UserRow, pageId: string, cardId: string, extra: Record<string, unknown> = {}) {
  return send(user, `/api/apps/${p.appId}/cards/query`, 'POST', { pageId, cardId, ...extra });
}

async function records(
  p: Procurement,
  user: UserRow,
  pageId: string,
  cardId: string,
  extra: Record<string, unknown> = {},
) {
  const result = await json<AppCardQueryResult>(await cardQuery(p, user, pageId, cardId, extra));
  if (result.kind !== 'records') throw new Error(`expected records, got ${result.kind}`);
  return result;
}

function act(p: Procurement, user: UserRow, body: Record<string, unknown>) {
  return send(user, `/api/apps/${p.appId}/actions`, 'POST', { requestId: requestId(), ...body });
}

async function submit(p: Procurement, user: UserRow, values: Array<{ fieldId: number; value: unknown }>) {
  return json<AppActionResult>(
    await act(p, user, { pageId: 'mine', cardId: 'new-request', actionId: '$submit', values }),
  );
}

async function upload(p: Procurement, user: UserRow, pageId: string, cardId: string, fieldId: number) {
  const form = new FormData();
  form.set('file', new File(['receipt bytes'], 'receipt.pdf', { type: 'application/pdf' }));
  form.set('pageId', pageId);
  form.set('cardId', cardId);
  form.set('fieldId', String(fieldId));
  return http.request(`/api/apps/${p.appId}/uploads`, {
    method: 'POST',
    headers: { 'x-test-user': user.id },
    body: form,
  });
}

async function stage(p: Procurement, user: UserRow): Promise<number> {
  const staged = await json<{ file: { id: number } }>(await upload(p, user, 'mine', 'new-request', p.f.receipt), 201);
  const row = await db.drive.getFile(staged.file.id);
  if (row) stagedKeys.push(row.cos_key);
  return staged.file.id;
}

// ─── Acceptance 2: a non-member applicant ────────────────

describe('a non-member applicant (acceptance 2)', () => {
  it('receives their role’s pages without the hidden column or the role’s raw rules', async () => {
    const p = await procurement();
    const view = await json<AppRuntimeView>(await send(applicant, `/api/apps/${p.appId}`));
    expect(view.role).toEqual({ key: 'applicant', name: 'Applicant' });
    expect(view.version).toBe(1);
    expect(view.app).toMatchObject({ canManage: false, canPublish: false });
    expect(view.spec.pages.map((page) => page.id)).toEqual(['mine']);
    expect(view.spec.roles).toEqual([expect.objectContaining({ key: 'applicant', tables: [] })]);
    const text = JSON.stringify(view);
    expect(text).not.toContain(`"fieldId":${p.f.note}`);
    const requests = view.tables.find((table) => table.id === p.tableId)!;
    expect(requests.fields.map((field) => field.id)).not.toContain(p.f.note);
    // Each field says whether it is required (the primary "Name" is; Amount is not) — the form marks it.
    const metaOf = (id: number) => requests.fields.find((field) => field.id === id);
    expect(metaOf(p.f.title)).toMatchObject({ required: true, editable: true });
    expect(metaOf(p.f.amount)).toMatchObject({ required: false });
    const drawer = view.spec.pages[0]!.cards.find((card) => card.id === 'my-requests');
    expect(drawer?.kind === 'records' && drawer.detail?.fieldIds).not.toContain(p.f.note);
    // The form keeps the fields the role writes; the status default stays visible (the role reads status).
    const form = view.spec.pages[0]!.cards.find((card) => card.id === 'new-request');
    expect(form?.kind === 'form' && form.fieldIds).toEqual([
      p.f.title,
      p.f.amount,
      p.f.receipt,
      p.f.dept,
      p.f.requestedFor,
      p.f.vendor,
    ]);
    expect(form?.kind === 'form' && form.defaults).toEqual([{ fieldId: p.f.status, value: 'pending' }]);

    // An approver gets their pages; nobody else in the app sees the other role.
    const approverView = await json<AppRuntimeView>(await send(approver, `/api/apps/${p.appId}`));
    expect(approverView.role.key).toBe('approver');
    expect(approverView.spec.pages.map((page) => page.id)).toEqual(['review', 'stats']);
  });

  it('submits through the form, sees only its own rows and fields, and nothing through /api/tables', async () => {
    const p = await procurement();
    const mine = await submit(p, applicant, [
      { fieldId: p.f.title, value: 'Laptop' },
      { fieldId: p.f.amount, value: 1200 },
      { fieldId: p.f.dept, value: 'eng' },
    ]);
    expect(mine.outcome).toBe('created');
    await submit(p, colleague, [{ fieldId: p.f.title, value: 'Chair' }]);
    await json(
      await send(owner, `/api/tables/tables/${p.tableId}/records`, 'POST', {
        values: { [p.f.title]: 'Owner item', [p.f.note]: 'secret' },
      }),
      201,
    );
    const stored = (await db.tables.getRecordById(mine.recordId))!;
    expect(stored.created_by).toBe(applicant.id);
    expect(stored.values[String(p.f.status)]).toBe('pending');
    const [event] = await db.tables.listRecordEvents(mine.recordId);
    expect(event).toMatchObject({ actor_kind: 'app', actor_id: applicant.id, meta: { appId: p.appId } });

    // The client cannot write fields outside the form, nor the status the spec fills in.
    const sneaky = await act(p, applicant, {
      pageId: 'mine',
      cardId: 'new-request',
      actionId: '$submit',
      values: [
        { fieldId: p.f.title, value: 'x' },
        { fieldId: p.f.status, value: 'approved' },
      ],
    });
    expect(sneaky.status).toBe(403);
    expect(((await sneaky.json()) as { details: { reason: string } }).details.reason).toBe('not_allowed');

    const list = await records(p, applicant, 'mine', 'my-requests');
    expect(list.total).toBe(1);
    expect(list.records.map((row) => row.id)).toEqual([mine.recordId]);
    expect(Object.keys(list.records[0]!.values).map(Number).sort()).toEqual([p.f.title, p.f.amount, p.f.status].sort());

    // Owner sets the hidden note on the applicant's request; the drawer still never shows it.
    const current = (await db.tables.getRecordById(mine.recordId))!;
    await json(
      await send(owner, `/api/tables/tables/${p.tableId}/records/${mine.recordId}`, 'PATCH', {
        revision: current.revision,
        values: { [p.f.note]: 'checked budget', [p.f.rejectReason]: '' },
      }),
    );
    const detail = await json<AppRecordView>(
      await send(applicant, `/api/apps/${p.appId}/records/get`, 'POST', {
        pageId: 'mine',
        cardId: 'my-requests',
        recordId: mine.recordId,
      }),
    );
    expect(detail.fieldIds).not.toContain(p.f.note);
    expect(detail.record.values).not.toHaveProperty(String(p.f.note));
    expect(detail.canComment).toBe(true);
    expect(detail.editableFieldIds).toEqual([]);
    const activity = await json<TableRecordActivityPage>(
      await send(applicant, `/api/apps/${p.appId}/activity`, 'POST', {
        pageId: 'mine',
        cardId: 'my-requests',
        recordId: mine.recordId,
      }),
    );
    const changed = activity.items.flatMap((item) => (item.kind === 'event' ? item.changes.map((c) => c.fieldId) : []));
    expect(changed).not.toContain(p.f.note);
    expect(changed).toContain(p.f.title);

    // Someone else's request: 404 everywhere.
    const others = (await db.tables.queryRecords(p.tableId, {}, { kind: 'full', userId: owner.id })).records.find(
      (row) => row.created_by === colleague.id,
    )!;
    expect(
      (
        await send(applicant, `/api/apps/${p.appId}/records/get`, 'POST', {
          pageId: 'mine',
          cardId: 'my-requests',
          recordId: others.id,
        })
      ).status,
    ).toBe(404);

    // The Tables module itself shows the applicant nothing.
    const bases = await json<{ bases: Array<{ id: number }> }>(await send(applicant, '/api/tables/bases'));
    expect(bases.bases.map((base) => base.id)).not.toContain(p.baseId);
    expect((await send(applicant, `/api/tables/tables/${p.tableId}/records/query`, 'POST', {})).status).toBe(404);
    expect((await send(applicant, `/api/tables/tables/${p.tableId}/records/${mine.recordId}`)).status).toBe(404);
    // Pages and cards of the other role do not exist for it.
    expect((await cardQuery(p, applicant, 'review', 'queue')).status).toBe(404);
  });

  it('loses every app read when tables.data.read is revoked', async () => {
    const p = await procurement();
    const mine = await submit(p, applicant, [{ fieldId: p.f.title, value: 'Desk' }]);
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: applicant.id,
      capability: 'tables.data.read',
      effect: 'deny',
      granted_by: owner.id,
    });
    const query = await cardQuery(p, applicant, 'mine', 'my-requests');
    expect(query.status).toBe(403);
    expect(
      (
        await send(applicant, `/api/apps/${p.appId}/records/get`, 'POST', {
          pageId: 'mine',
          cardId: 'my-requests',
          recordId: mine.recordId,
        })
      ).status,
    ).toBe(403);
    expect(await canRecipientRead({ db }, applicant.id, { id: mine.recordId, table_id: p.tableId })).toBeNull();
  });

  it('opens nothing for someone outside every audience, and nothing once the app is archived', async () => {
    const p = await procurement();
    await json(
      await send(owner, `/api/apps/${p.appId}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'group', groupId: p.groupId }, roleKey: 'approver' }],
        audiencesRevision: 2,
      }),
    );
    expect((await send(outsider, `/api/apps/${p.appId}`)).status).toBe(404);
    expect((await cardQuery(p, outsider, 'mine', 'my-requests')).status).toBe(404);
    await json(await send(owner, `/api/apps/${p.appId}/archive`, 'POST'));
    expect((await send(approver, `/api/apps/${p.appId}`)).status).toBe(404);
    expect((await cardQuery(p, approver, 'review', 'queue')).status).toBe(404);
  });
});

// ─── Acceptance 3: approving ──────────────────────────────

describe('approving (acceptance 3)', () => {
  async function pending(p: Procurement) {
    const request = await submit(p, applicant, [
      { fieldId: p.f.title, value: 'Monitor' },
      { fieldId: p.f.amount, value: 300 },
      { fieldId: p.f.dept, value: 'ops' },
    ]);
    return request.recordId;
  }

  it('writes status, approver and time as the approver, then refuses a second approval; requestIds replay', async () => {
    const p = await procurement();
    const recordId = await pending(p);
    const queue = await records(p, approver, 'review', 'queue');
    const row = queue.records.find((entry) => entry.id === recordId)!;
    expect(row.actionIds.sort()).toEqual(['approve', 'reject']);
    expect(queue.refs.users[applicant.id]).toEqual({ nickname: 'GW applicant' });

    const id = requestId();
    const approved = await json<AppActionResult>(
      await send(approver, `/api/apps/${p.appId}/actions`, 'POST', {
        pageId: 'review',
        cardId: 'queue',
        actionId: 'approve',
        recordId,
        requestId: id,
        timezone: 'Asia/Shanghai',
      }),
    );
    expect(approved.outcome).toBe('updated');
    // It left the queue (status is no longer pending): no row to return.
    expect(approved.record).toBeUndefined();
    const stored = (await db.tables.getRecordById(recordId))!;
    expect(stored.values[String(p.f.status)]).toBe('approved');
    expect(stored.values[String(p.f.approver)]).toBe(approver.id);
    expect(Date.now() - Date.parse(String(stored.values[String(p.f.approvedAt)]))).toBeLessThan(60_000);
    expect(stored.updated_by).toBe(approver.id);
    const [event] = await db.tables.listRecordEvents(recordId);
    expect(event).toMatchObject({
      actor_kind: 'app',
      actor_id: approver.id,
      type: 'updated',
      meta: { appId: p.appId },
    });

    const replay = await json<AppActionResult>(
      await send(approver, `/api/apps/${p.appId}/actions`, 'POST', {
        pageId: 'review',
        cardId: 'queue',
        actionId: 'approve',
        recordId,
        requestId: id,
      }),
    );
    expect(replay).toMatchObject({ outcome: 'updated', recordId, replayed: true });
    expect((await db.tables.listRecordEvents(recordId)).length).toBe(2);

    // A fresh request: the record left the card (and `when` no longer holds) → not found in the queue.
    const again = await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'approve', recordId });
    expect([404, 409]).toContain(again.status);
  });

  it('refuses a stale approval with 409 precondition once the status moved inside the card', async () => {
    const p = await procurement();
    const recordId = await pending(p);
    // The board shows every status: approve through a card whose query keeps the row.
    const spec = structuredClone(p.spec);
    const review = spec.pages.find((page) => page.id === 'review')!;
    const queue = review.cards.find((card) => card.id === 'queue')!;
    if (queue.kind !== 'records') throw new Error('queue');
    queue.source = { tableId: p.tableId };
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec, draftRevision: draft.draftRevision }),
    );
    await json(await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: saved.draftRevision }));

    await json<AppActionResult>(
      await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'approve', recordId }),
    );
    const again = await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'approve', recordId });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { details: { reason: string } }).details.reason).toBe('precondition');
    const row = (await records(p, approver, 'review', 'queue')).records.find((entry) => entry.id === recordId)!;
    expect(row.actionIds).toEqual([]);
  });

  it('never lets an approver approve their own request (created_by ≠ $me)', async () => {
    const p = await procurement();
    // The approver files a request through the Tables module as a Base editor.
    await json(await send(owner, `/api/tables/bases/${p.baseId}/members/${approver.id}`, 'PUT', { role: 'editor' }));
    const own = await json<{ record: { id: number } }>(
      await send(approver, `/api/tables/tables/${p.tableId}/records`, 'POST', {
        values: { [p.f.title]: 'My own', [p.f.status]: 'pending' },
      }),
      201,
    );
    const row = (await records(p, approver, 'review', 'queue')).records.find((entry) => entry.id === own.record.id)!;
    expect(row.actionIds).toEqual(['reject']);
    const refused = await act(p, approver, {
      pageId: 'review',
      cardId: 'queue',
      actionId: 'approve',
      recordId: own.record.id,
    });
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { details: { reason: string } }).details.reason).toBe('precondition');
  });

  it('needs the rejection reason, and refuses a stale revision with the current one', async () => {
    const p = await procurement();
    const recordId = await pending(p);
    const missing = await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'reject', recordId });
    expect(missing.status).toBe(400);
    expect(((await missing.json()) as { details: { reason: string; fieldIds: number[] } }).details).toEqual({
      reason: 'required_input',
      fieldIds: [p.f.rejectReason],
    });
    // Only the action's inputs come from the client.
    const extra = await act(p, approver, {
      pageId: 'review',
      cardId: 'queue',
      actionId: 'reject',
      recordId,
      values: [
        { fieldId: p.f.rejectReason, value: 'Over budget' },
        { fieldId: p.f.note, value: 'sneaky' },
      ],
    });
    expect(extra.status).toBe(403);

    const stale = await act(p, approver, {
      pageId: 'review',
      cardId: 'queue',
      actionId: 'reject',
      recordId,
      revision: 99,
      values: [{ fieldId: p.f.rejectReason, value: 'Over budget' }],
    });
    expect(stale.status).toBe(409);
    const body = (await stale.json()) as { details: { reason: string; currentRevision: number } };
    expect(body.details).toMatchObject({ reason: 'conflict', currentRevision: 1 });

    const rejected = await json<AppActionResult>(
      await act(p, approver, {
        pageId: 'review',
        cardId: 'queue',
        actionId: 'reject',
        recordId,
        revision: 1,
        values: [{ fieldId: p.f.rejectReason, value: 'Over budget' }],
      }),
    );
    expect(rejected.outcome).toBe('updated');
    const stored = (await db.tables.getRecordById(recordId))!;
    expect(stored.values).toMatchObject({
      [String(p.f.status)]: 'rejected',
      [String(p.f.rejectReason)]: 'Over budget',
    });
  });

  it('notifies the non-member applicant through the app, rendering only what their role reads', async () => {
    const p = await procurement();
    await json(
      await send(owner, `/api/tables/bases/${p.baseId}/automations`, 'POST', {
        tableId: p.tableId,
        name: 'Tell the applicant',
        trigger: 'record_updated',
        status: 'enabled',
        config: {
          condition: { combinator: 'and', clauses: [{ fieldId: p.f.status, operator: 'eq', value: 'approved' }] },
          watchFieldIds: [p.f.status],
          actions: [
            {
              type: 'notify',
              recipients: { creator: true },
              title: 'Approved',
              message: 'Amount {{field:' + p.f.amount + '}}, note {{field:' + p.f.note + '}}',
            },
          ],
        },
      }),
      201,
    );
    const recordId = await pending(p);
    await json(await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'approve', recordId }));

    const reach = await canRecipientRead({ db }, applicant.id, { id: recordId, table_id: p.tableId });
    expect(reach).toMatchObject({ via: 'app', appId: p.appId, roleKey: 'applicant' });

    await createTablesAutomationRunner({
      db,
      workerId: `gw-${Math.random()}`,
      now: () => new Date(Date.now() + 1_000),
      publishOptions: { pushEnabled: false },
    }).runOnce();
    const inbox = await db.notifications.listForUser({ user_id: applicant.id });
    expect(inbox.items).toHaveLength(1);
    const [notice] = inbox.items;
    expect(notice!.body).toBe('Amount 300, note —');
    expect((JSON.parse(notice!.payload) as { href?: string }).href).toBe(`#/apps/${p.appId}?record=${recordId}`);
  });

  it('moves board cards only for the move roles, through the lane field only', async () => {
    const p = await procurement();
    const recordId = await pending(p);
    const board = await records(p, approver, 'review', 'board');
    expect(board.records.map((row) => row.id)).toContain(recordId);
    const wrong = await act(p, approver, {
      pageId: 'review',
      cardId: 'board',
      actionId: '$move',
      recordId,
      values: [{ fieldId: p.f.note, value: 'x' }],
    });
    expect(wrong.status).toBe(403);
    const moved = await json<AppActionResult>(
      await act(p, approver, {
        pageId: 'review',
        cardId: 'board',
        actionId: '$move',
        recordId,
        values: [{ fieldId: p.f.status, value: 'rejected' }],
      }),
    );
    expect(moved.record?.values[String(p.f.status)]).toBe('rejected');
    expect((await act(p, applicant, { pageId: 'review', cardId: 'board', actionId: '$move', recordId })).status).toBe(
      404,
    );
  });

  it('edits the drawer’s editable fields only, and comments only where the card allows', async () => {
    const p = await procurement();
    const recordId = await pending(p);
    const drawer = await json<AppRecordView>(
      await send(approver, `/api/apps/${p.appId}/records/get`, 'POST', { pageId: 'review', cardId: 'queue', recordId }),
    );
    expect(drawer.editableFieldIds).toEqual([p.f.note]);
    expect(drawer.record.actionIds.sort()).toEqual(['approve', 'reject']);
    await json<AppActionResult>(
      await act(p, approver, {
        pageId: 'review',
        cardId: 'queue',
        actionId: '$edit',
        recordId,
        values: [{ fieldId: p.f.note, value: 'looks fine' }],
      }),
    );
    expect(
      (
        await act(p, approver, {
          pageId: 'review',
          cardId: 'queue',
          actionId: '$edit',
          recordId,
          values: [{ fieldId: p.f.amount, value: 1 }],
        })
      ).status,
    ).toBe(403);

    const posted = await json<{ comment: { id: number } }>(
      await send(approver, `/api/apps/${p.appId}/comments`, 'POST', {
        pageId: 'review',
        cardId: 'queue',
        recordId,
        body: 'On it',
      }),
      201,
    );
    // The applicant reads the comment through their own card, but cannot edit the approver's.
    const feed = await json<TableRecordActivityPage>(
      await send(applicant, `/api/apps/${p.appId}/activity`, 'POST', {
        pageId: 'mine',
        cardId: 'my-requests',
        recordId,
      }),
    );
    expect(feed.items.some((item) => item.kind === 'comment' && item.id === posted.comment.id)).toBe(true);
    expect(feed.viewer?.canComment).toBe(true);
    expect(
      (
        await send(applicant, `/api/apps/${p.appId}/comments/${posted.comment.id}`, 'PATCH', {
          pageId: 'mine',
          cardId: 'my-requests',
          body: 'hijack',
        })
      ).status,
    ).toBe(403);
    await json(
      await send(approver, `/api/apps/${p.appId}/comments/${posted.comment.id}`, 'DELETE', {
        pageId: 'review',
        cardId: 'queue',
      }),
    );
    // A card without comments refuses them.
    expect(
      (
        await send(approver, `/api/apps/${p.appId}/comments`, 'POST', {
          pageId: 'review',
          cardId: 'board',
          recordId,
          body: 'nope',
        })
      ).status,
    ).toBe(403);
  });
});

// ─── Files, options, filters ──────────────────────────────

describe('attachments, options and page filters', () => {
  it('uploads only where the card writes the field, attaches only own uploads, serves only shown records', async () => {
    const p = await procurement();
    const fileId = await stage(p, applicant);
    const created = await submit(p, applicant, [
      { fieldId: p.f.title, value: 'With receipt' },
      { fieldId: p.f.receipt, value: [fileId] },
    ]);
    expect((await db.drive.getFile(fileId))?.status).toBe('active');
    const download = await send(
      applicant,
      `/api/apps/${p.appId}/files/${fileId}?pageId=mine&cardId=my-requests&recordId=${created.recordId}&fieldId=${p.f.receipt}`,
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('receipt bytes');
    const list = await records(p, applicant, 'mine', 'my-requests');
    expect(list.refs.files[String(fileId)]).toMatchObject({ name: 'receipt.pdf' });

    // Another applicant: not their record (404), and they cannot attach someone else's upload.
    expect(
      (
        await send(
          colleague,
          `/api/apps/${p.appId}/files/${fileId}?pageId=mine&cardId=my-requests&recordId=${created.recordId}&fieldId=${p.f.receipt}`,
        )
      ).status,
    ).toBe(404);
    const theirs = await stage(p, applicant);
    const stolen = await act(p, colleague, {
      pageId: 'mine',
      cardId: 'new-request',
      actionId: '$submit',
      values: [
        { fieldId: p.f.title, value: 'Stolen' },
        { fieldId: p.f.receipt, value: [theirs] },
      ],
    });
    expect(stolen.status).toBe(400);
    // A card that does not write the field takes no files; an approver never sees the form.
    expect((await upload(p, applicant, 'mine', 'my-requests', p.f.receipt)).status).toBe(403);
    expect((await upload(p, approver, 'mine', 'new-request', p.f.receipt)).status).toBe(404);
  });

  it('offers people for user fields and only role-readable rows for links', async () => {
    const p = await procurement();
    const people = await json<AppFieldOptionsView>(
      await send(applicant, `/api/apps/${p.appId}/options`, 'POST', {
        pageId: 'mine',
        cardId: 'new-request',
        fieldId: p.f.requestedFor,
        search: 'GW approver',
      }),
    );
    expect(people.options).toEqual([expect.objectContaining({ value: approver.id, label: 'GW approver' })]);
    const vendors = await json<AppFieldOptionsView>(
      await send(applicant, `/api/apps/${p.appId}/options`, 'POST', {
        pageId: 'mine',
        cardId: 'new-request',
        fieldId: p.f.vendor,
      }),
    );
    expect(vendors.options).toEqual([{ value: p.vendors.acme, label: 'Acme' }]);
    // A field the card does not write has no options for this role.
    expect(
      (
        await send(applicant, `/api/apps/${p.appId}/options`, 'POST', {
          pageId: 'mine',
          cardId: 'my-requests',
          fieldId: p.f.requestedFor,
        })
      ).status,
    ).toBe(404);
    // Linking a vendor outside the role's read rows is refused (D14); inside, the label resolves.
    expect(
      (
        await act(p, applicant, {
          pageId: 'mine',
          cardId: 'new-request',
          actionId: '$submit',
          values: [
            { fieldId: p.f.title, value: 'x' },
            { fieldId: p.f.vendor, value: p.vendors.shady },
          ],
        })
      ).status,
    ).toBe(400);
    await submit(p, applicant, [
      { fieldId: p.f.title, value: 'Linked' },
      { fieldId: p.f.vendor, value: p.vendors.acme },
    ]);
  });

  it('applies page filters and $page values for readable targets, and evaluates aggregate cards', async () => {
    const p = await procurement();
    await submit(p, applicant, [
      { fieldId: p.f.title, value: 'Ops item' },
      { fieldId: p.f.dept, value: 'ops' },
      { fieldId: p.f.amount, value: 10 },
    ]);
    await submit(p, colleague, [
      { fieldId: p.f.title, value: 'Eng item' },
      { fieldId: p.f.dept, value: 'eng' },
      { fieldId: p.f.amount, value: 5 },
    ]);
    const filterValues = { dept: { kind: 'select', values: ['ops'] } };
    const queue = await records(p, approver, 'review', 'queue', { filterValues });
    expect(queue.records.map((row) => row.values[String(p.f.title)])).toEqual(['Ops item']);
    const byDept = await records(p, approver, 'review', 'by-dept', { filterValues });
    expect(byDept.records.map((row) => row.values[String(p.f.title)])).toEqual(['Ops item']);
    // No value: the $page clause is no constraint.
    expect((await records(p, approver, 'review', 'by-dept')).total).toBe(2);
    const search = await records(p, approver, 'review', 'queue', { search: 'Eng' });
    expect(search.total).toBe(1);

    const total = await json<AppCardQueryResult>(await cardQuery(p, approver, 'stats', 'total'));
    expect(total).toEqual({ kind: 'kpi', value: 15 });
    const chart = await json<AppCardQueryResult>(await cardQuery(p, approver, 'stats', 'per-dept'));
    expect(chart.kind).toBe('chart');
  });

  it('reads a null page-filter value as cleared: no constraint, and the default no longer applies', async () => {
    const p = await procurement();
    // v2: the Department filter starts on "ops".
    const spec = structuredClone(p.spec);
    const review = spec.pages.find((page) => page.id === 'review')!;
    review.filters = [{ ...review.filters![0]!, defaultValue: { kind: 'select', values: ['ops'] } }];
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec, draftRevision: draft.draftRevision }),
    );
    expect(saved.errors).toEqual([]);
    await json(await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: saved.draftRevision }));
    await submit(p, applicant, [
      { fieldId: p.f.title, value: 'Ops item' },
      { fieldId: p.f.dept, value: 'ops' },
    ]);
    await submit(p, colleague, [
      { fieldId: p.f.title, value: 'Eng item' },
      { fieldId: p.f.dept, value: 'eng' },
    ]);
    const titles = (result: Extract<AppCardQueryResult, { kind: 'records' }>) =>
      result.records.map((row) => row.values[String(p.f.title)]).sort();

    // Untouched (absent): the default applies — to the page filter and to the `$page.dept` clause.
    expect(titles(await records(p, approver, 'review', 'queue'))).toEqual(['Ops item']);
    expect(titles(await records(p, approver, 'review', 'by-dept'))).toEqual(['Ops item']);
    // Cleared (null, the dashboards' convention the web and iOS runtimes send): no constraint at all.
    const cleared = { filterValues: { dept: null } };
    expect(titles(await records(p, approver, 'review', 'queue', cleared))).toEqual(['Eng item', 'Ops item']);
    expect(titles(await records(p, approver, 'review', 'by-dept', cleared))).toEqual(['Eng item', 'Ops item']);
    // A chosen value still narrows.
    const eng = { filterValues: { dept: { kind: 'select', values: ['eng'] } } };
    expect(titles(await records(p, approver, 'review', 'by-dept', eng))).toEqual(['Eng item']);
  });
});

// ─── Managers ─────────────────────────────────────────────

describe('calendar cards', () => {
  it('load the records that overlap the visible window, including multi-day ones that began before it', async () => {
    const created = await json<{
      base: { id: number };
      schema: { table: { id: number }; fields: Array<{ id: number }> };
    }>(await send(owner, '/api/tables/bases', 'POST', { name: 'Leave', defaultTableName: 'Days off' }), 201);
    const tableId = created.schema.table.id;
    const title = created.schema.fields[0]!.id;
    const field = async (name: string) =>
      (
        await json<{ field: { id: number } }>(
          await send(owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name, type: 'date' }),
          201,
        )
      ).field.id;
    const start = await field('Start');
    const end = await field('End');
    const add = async (name: string, from: string, to?: string) =>
      json(
        await send(owner, `/api/tables/tables/${tableId}/records`, 'POST', {
          values: { [title]: name, [start]: from, ...(to ? { [end]: to } : {}) },
        }),
        201,
      );
    await add('spans in', '2026-09-25', '2026-10-03');
    await add('inside', '2026-10-15');
    await add('last day', '2026-11-01');
    await add('before', '2026-09-01', '2026-09-10');
    await add('after', '2026-11-02');
    const spec: AppSpec = {
      version: 1,
      pages: [
        {
          id: 'cal',
          title: 'Calendar',
          cards: [
            {
              id: 'days',
              kind: 'calendar',
              layout: { x: 0, y: 0, w: 12, h: 6 },
              source: { tableId },
              startFieldId: start,
              endFieldId: end,
              fieldIds: [title, start, end],
            },
          ],
        },
      ],
      roles: [
        {
          key: 'all',
          name: 'All',
          pages: 'all',
          tables: [{ tableId, access: 'read', fields: [], fieldDefault: 'visible' }],
        },
        {
          key: 'starts',
          name: 'Starts only',
          pages: 'all',
          tables: [{ tableId, access: 'read', fields: [{ fieldId: end, access: 'hidden' }], fieldDefault: 'visible' }],
        },
      ],
    };
    const draft = await json<AppDraftView>(
      await send(owner, '/api/apps', 'POST', { baseId: created.base.id, name: 'Leave', spec }),
      201,
    );
    expect(draft.errors).toEqual([]);
    const query = async (range: { from: string; to: string }, previewRole?: string) => {
      const result = await json<AppCardQueryResult>(
        await send(owner, `/api/apps/${draft.app.id}/cards/query`, 'POST', {
          pageId: 'cal',
          cardId: 'days',
          draft: true,
          range,
          ...(previewRole ? { previewRole } : {}),
        }),
      );
      if (result.kind !== 'records') throw new Error(`expected records, got ${result.kind}`);
      return result.records.map((record) => record.values[String(title)]).sort();
    };

    expect(await query({ from: '2026-09-28', to: '2026-11-01' })).toEqual(['inside', 'last day', 'spans in']);
    expect(await query({ from: '2026-10-04', to: '2026-10-31' })).toEqual(['inside']);
    // A role that cannot read the end field still gets its calendar — matched by the start day alone.
    expect(await query({ from: '2026-09-28', to: '2026-11-01' }, 'starts')).toEqual(['inside', 'last day']);
  });
});

describe('managers (D2)', () => {
  it('preview as a role, act with full access, and only the owner publishes', async () => {
    const p = await procurement();
    await submit(p, applicant, [{ fieldId: p.f.title, value: 'Someone’s' }]);
    const preview = await records(p, owner, 'mine', 'my-requests', { previewRole: 'applicant' });
    expect(preview.total).toBe(0);
    const full = await records(p, builder, 'review', 'queue');
    expect(full.total).toBe(1);
    const previewView = await json<AppRuntimeView>(await send(builder, `/api/apps/${p.appId}?previewRole=applicant`));
    expect(previewView.spec.roles[0]!.tables).toEqual([]);
    expect((await send(builder, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: 2 })).status).toBe(403);
  });

  it('stops a downgraded owner from publishing or sharing, while the new owner can (acceptance 5)', async () => {
    const p = await procurement();
    await json(
      await send(owner, `/api/tables/bases/${p.baseId}/transfer`, 'POST', {
        userId: builder.id,
        previousOwnerRole: 'builder',
      }),
    );
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    expect(draft.app.canPublish).toBe(false);
    const publish = await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: draft.draftRevision });
    expect(publish.status).toBe(403);
    expect(((await publish.json()) as { details: { reason: string } }).details.reason).toBe('owner_only');
    expect(
      (
        await send(owner, `/api/apps/${p.appId}/audiences`, 'PUT', {
          entries: [{ principal: { type: 'team' }, roleKey: 'approver' }],
          audiencesRevision: 2,
        })
      ).status,
    ).toBe(403);
    // Still a manager: full access to the gateway, and the new owner publishes.
    expect((await records(p, owner, 'review', 'queue')).kind).toBe('records');
    await json(await send(builder, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: draft.draftRevision }));
  });

  it('treats a Base builder without tables.apps.manage as a viewer: no draft, no preview, no full access', async () => {
    const p = await procurement();
    await submit(p, applicant, [{ fieldId: p.f.title, value: 'Someone else’s' }]);
    // v2 in the draft only: a page the live version does not have.
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    const spec = structuredClone(draft.spec);
    spec.pages[0]!.title = 'Draft title';
    await json(await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec, draftRevision: draft.draftRevision }));
    await db.platform.setUserCapabilityOverride({
      org_id: 'default',
      user_id: builder.id,
      capability: 'tables.apps.manage',
      effect: 'deny',
      granted_by: owner.id,
    });

    // The team audience makes the builder an applicant — and that is all they get.
    for (const query of ['', '?draft=1', '?previewRole=approver', '?previewRole=approver&draft=1']) {
      const view = await json<AppRuntimeView>(await send(builder, `/api/apps/${p.appId}${query}`));
      expect(view.version, query).toBe(1);
      expect(view.draft, query).toBeFalsy();
      expect(view.role, query).toEqual({ key: 'applicant', name: 'Applicant' });
      expect(view.spec.pages.map((page) => [page.id, page.title])).toEqual([['mine', 'My requests']]);
      expect(view.app.canManage, query).toBe(false);
    }
    expect((await send(builder, `/api/apps/${p.appId}/draft`)).status).toBe(403);
    for (const extra of [{}, { previewRole: 'approver' }, { draft: true }]) {
      expect((await cardQuery(p, builder, 'review', 'queue', extra)).status).toBe(404);
    }
    // Their own rows only (the applicant's request is not theirs).
    expect((await records(p, builder, 'mine', 'my-requests', { draft: true })).total).toBe(0);
    const list = await json<{ managed: Array<{ id: number }>; shared: Array<{ id: number; canManage: boolean }> }>(
      await send(builder, '/api/apps'),
    );
    expect(list.managed).toEqual([]);
    expect(list.shared.find((app) => app.id === p.appId)?.canManage).toBe(false);

    // Outside every audience, the same builder opens nothing.
    await json(
      await send(owner, `/api/apps/${p.appId}/audiences`, 'PUT', {
        entries: [{ principal: { type: 'group', groupId: p.groupId }, roleKey: 'approver' }],
        audiencesRevision: 2,
      }),
    );
    expect((await send(builder, `/api/apps/${p.appId}?draft=1`)).status).toBe(404);
    expect((await cardQuery(p, builder, 'mine', 'my-requests', { draft: true })).status).toBe(404);
    expect((await json<{ shared: unknown[] }>(await send(builder, '/api/apps'))).shared).toEqual([]);
  });

  it('ignores a viewer’s previewRole and draft (acceptance 4)', async () => {
    const p = await procurement();
    await submit(p, colleague, [{ fieldId: p.f.title, value: 'Colleague’s' }]);
    // An applicant asking for the approver's card, or the draft, gets nothing more than their role.
    expect((await cardQuery(p, applicant, 'review', 'queue', { previewRole: 'approver' })).status).toBe(404);
    expect((await cardQuery(p, applicant, 'review', 'queue', { previewRole: 'approver', draft: true })).status).toBe(
      404,
    );
    const mine = await records(p, applicant, 'mine', 'my-requests', { previewRole: 'approver', draft: true });
    expect(mine.total).toBe(0);
    const view = await json<AppRuntimeView>(await send(applicant, `/api/apps/${p.appId}?previewRole=approver&draft=1`));
    expect(view.role.key).toBe('applicant');
    expect(view.version).toBe(1);
    expect(view.draft).toBeFalsy();
    expect(view.spec.pages.map((page) => page.id)).toEqual(['mine']);
  });

  it('keeps a draft edit away from viewers until it is published (acceptance 4)', async () => {
    const p = await procurement();
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    const spec = structuredClone(draft.spec);
    const minePage = spec.pages.find((page) => page.id === 'mine')!;
    minePage.title = 'Requests v2';
    minePage.cards.push({ id: 'note', kind: 'text', layout: { x: 0, y: 6, w: 12, h: 2 }, markdown: 'New in v2' });
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec, draftRevision: draft.draftRevision }),
    );
    expect(saved.errors).toEqual([]);

    // Saved but not published: the applicant still runs v1.
    const before = await json<AppRuntimeView>(await send(applicant, `/api/apps/${p.appId}`));
    expect(before.version).toBe(1);
    expect(before.spec.pages[0]!.title).toBe('My requests');
    expect(before.spec.pages[0]!.cards.map((card) => card.id)).not.toContain('note');
    expect((await cardQuery(p, applicant, 'mine', 'note')).status).toBe(404);
    expect((await cardQuery(p, applicant, 'mine', 'note', { draft: true })).status).toBe(404);
    // The manager sees the draft only when asking for it.
    expect((await json<AppRuntimeView>(await send(owner, `/api/apps/${p.appId}`))).version).toBe(1);
    expect((await json<AppRuntimeView>(await send(owner, `/api/apps/${p.appId}?draft=1`))).spec.pages[0]!.title).toBe(
      'Requests v2',
    );

    await json(await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: saved.draftRevision }));
    const after = await json<AppRuntimeView>(await send(applicant, `/api/apps/${p.appId}`));
    expect(after.version).toBe(2);
    expect(after.spec.pages[0]!.title).toBe('Requests v2');
    expect(await json<AppCardQueryResult>(await cardQuery(p, applicant, 'mine', 'note'))).toEqual({
      kind: 'text',
      markdown: 'New in v2',
    });
  });
});

// ─── Acceptance 5: structure changes (D6) ────────────────

describe('structure changes that break apps (acceptance 5, D6)', () => {
  it('refuses to archive a referenced field until confirmed, then serves the card as unavailable', async () => {
    const p = await procurement();
    const refused = await send(owner, `/api/tables/fields/${p.f.dept}/archive`, 'POST', {});
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as {
      details: { reason: string; references: Array<{ appId: number; name: string; where: string }> };
    };
    expect(body.details.reason).toBe('used_by_apps');
    expect(body.details.references.every((ref) => ref.appId === p.appId && ref.name === 'Purchasing')).toBe(true);
    const places = body.details.references.map((ref) => ref.where);
    expect(places).toEqual(
      expect.arrayContaining(['v1 › “Review” › “Pending”', 'draft › “Review” › filter “Department”']),
    );

    await json(await send(owner, `/api/tables/fields/${p.f.dept}/archive`, 'POST', { confirm: true }));
    const queue = await json<AppCardQueryResult>(await cardQuery(p, approver, 'review', 'queue'));
    expect(queue).toEqual({ kind: 'unavailable', message: 'This card is unavailable' });
    const managerView = await json<AppCardQueryResult>(await cardQuery(p, owner, 'review', 'queue'));
    expect(managerView.kind).toBe('unavailable');
    expect(managerView.kind === 'unavailable' && managerView.message).toContain(String(p.f.dept));
    const view = await json<AppRuntimeView>(await send(approver, `/api/apps/${p.appId}`));
    expect(view.issues.some((issue) => issue.cardId === 'queue')).toBe(true);
    // The form wrote the field too: submitting through it is refused.
    expect(
      (await act(p, applicant, { pageId: 'mine', cardId: 'new-request', actionId: '$submit', values: [] })).status,
    ).toBe(403);
  });

  it('guards select options used in predicates and values, and button rules used by actions', async () => {
    const p = await procurement();
    const field = (await db.tables.getField(p.f.status))!;
    const config = {
      ...(JSON.parse(field.config) as Record<string, unknown>),
      options: [
        { id: 'pending', label: 'pending' },
        { id: 'rejected', label: 'rejected' },
      ],
    };
    const dropped = await send(owner, `/api/tables/fields/${p.f.status}`, 'PATCH', { config });
    expect(dropped.status).toBe(409);
    expect(
      ((await dropped.json()) as { details: { references: Array<{ where: string }> } }).details.references.map(
        (r) => r.where,
      ),
    ).toContain('v1 › “Review” › “Pending” › “Approve”');
    // Renaming without dropping a used option is fine.
    const renamed = { ...config, options: [...config.options, { id: 'approved', label: 'OK' }] };
    await json(await send(owner, `/api/tables/fields/${p.f.status}`, 'PATCH', { config: renamed }));

    const rule = await json<{ automation: { id: number } }>(
      await send(owner, `/api/tables/bases/${p.baseId}/automations`, 'POST', {
        tableId: p.tableId,
        name: 'Escalate',
        trigger: 'button',
        status: 'enabled',
        config: {
          buttonLabel: 'Escalate',
          actions: [{ type: 'notify', recipients: { creator: true }, title: 'x', message: 'y' }],
        },
      }),
      201,
    );
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    const spec = structuredClone(draft.spec);
    const queue = spec.pages[1]!.cards[0]!;
    if (queue.kind !== 'records') throw new Error('queue');
    queue.actions!.push({
      id: 'escalate',
      label: 'Escalate',
      do: { type: 'run_automation', ruleId: rule.automation.id },
    });
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec, draftRevision: draft.draftRevision }),
    );
    expect(saved.errors).toEqual([]);
    const removed = await send(owner, `/api/tables/automations/${rule.automation.id}`, 'DELETE');
    expect(removed.status).toBe(409);
    await json(await send(owner, `/api/tables/automations/${rule.automation.id}?confirm=1`, 'DELETE'));
  });

  it('queues a button rule from an app action as the rule’s run', async () => {
    const p = await procurement();
    const rule = await json<{ automation: { id: number } }>(
      await send(owner, `/api/tables/bases/${p.baseId}/automations`, 'POST', {
        tableId: p.tableId,
        name: 'Escalate',
        trigger: 'button',
        status: 'enabled',
        config: {
          buttonLabel: 'Escalate',
          actions: [{ type: 'notify', recipients: { creator: true }, title: 'x', message: 'y' }],
        },
      }),
      201,
    );
    const draft = await json<AppDraftView>(await send(owner, `/api/apps/${p.appId}/draft`));
    const spec = structuredClone(draft.spec);
    const queue = spec.pages[1]!.cards[0]!;
    if (queue.kind !== 'records') throw new Error('queue');
    queue.actions!.push({
      id: 'escalate',
      label: 'Escalate',
      do: { type: 'run_automation', ruleId: rule.automation.id },
    });
    const saved = await json<AppDraftView>(
      await send(owner, `/api/apps/${p.appId}/draft`, 'PUT', { spec, draftRevision: draft.draftRevision }),
    );
    await json(await send(owner, `/api/apps/${p.appId}/publish`, 'POST', { draftRevision: saved.draftRevision }));
    const recordId = (await submit(p, applicant, [{ fieldId: p.f.title, value: 'Escalate me' }])).recordId;
    const queued = await json<AppActionResult>(
      await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'escalate', recordId }),
    );
    expect(queued).toMatchObject({ outcome: 'queued', recordId });
    expect(await db.tables.listAutomationOutbox(rule.automation.id)).toHaveLength(1);
  });
});

// ─── Acceptance 9: audit and usage ───────────────────────

describe('audit and usage (acceptance 9)', () => {
  it('counts people and runs per action for managers, and the Base audit lists writes only', async () => {
    const p = await procurement();
    const recordId = (await submit(p, applicant, [{ fieldId: p.f.title, value: 'One' }])).recordId;
    await submit(p, colleague, [{ fieldId: p.f.title, value: 'Two' }]);
    await records(p, applicant, 'mine', 'my-requests');
    await json(await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'approve', recordId }));
    // A refused action does not count as a run.
    await act(p, approver, { pageId: 'review', cardId: 'queue', actionId: 'reject', recordId: 999_999 });

    const usage = await json<AppUsageView>(await send(owner, `/api/apps/${p.appId}/usage`));
    expect(usage.users7d).toBe(3);
    expect(usage.users30d).toBe(3);
    expect(usage.actions30d).toEqual({ $submit: 2, approve: 1 });
    expect(usage.lastUsedAt).not.toBeNull();
    expect((await send(applicant, `/api/apps/${p.appId}/usage`)).status).toBe(404);

    const audit = await json<{ events: Array<{ action_id: string; entity_id: string; record_id: string }> }>(
      await send(owner, `/api/tables/bases/${p.baseId}/audit`),
    );
    const actions = audit.events.map((event) => event.action_id);
    expect(actions).toContain('runAppAction');
    expect(actions).not.toContain('queryAppCard');
    expect(audit.events.find((event) => event.action_id === 'runAppAction')).toMatchObject({
      entity_id: 'app',
      record_id: String(p.appId),
    });
  });

  it('prunes action-ledger rows past the 30-day usage window; recent runs still count and replay', async () => {
    const p = await procurement();
    const old = await submit(p, applicant, [{ fieldId: p.f.title, value: 'Old' }]);
    const recentRequest = requestId();
    const sendRecent = () =>
      send(applicant, `/api/apps/${p.appId}/actions`, 'POST', {
        pageId: 'mine',
        cardId: 'new-request',
        actionId: '$submit',
        requestId: recentRequest,
        values: [{ fieldId: p.f.title, value: 'Recent' }],
      });
    const recent = await json<AppActionResult>(await sendRecent());
    await db.executeRaw(
      sql`UPDATE table_app_action_requests SET created_at = now() - interval '31 days'
          WHERE app_id = ${p.appId} AND record_id = ${old.recordId}`,
    );
    const ledger = async () =>
      (
        (await db.executeRaw(
          sql`SELECT record_id FROM table_app_action_requests WHERE app_id = ${p.appId} ORDER BY id`,
        )) as Array<{ record_id: number }>
      ).map((row) => row.record_id);
    expect(await ledger()).toEqual([old.recordId, recent.recordId]);

    expect(await sweepAppActionLedger(db)).toBeGreaterThanOrEqual(1);
    expect(await ledger()).toEqual([recent.recordId]);
    // Nothing usage reads was lost, and the recent request still replays instead of writing again.
    const usage = await json<AppUsageView>(await send(owner, `/api/apps/${p.appId}/usage`));
    expect(usage.actions30d).toEqual({ $submit: 1 });
    expect(await json<AppActionResult>(await sendRecent())).toMatchObject({
      recordId: recent.recordId,
      replayed: true,
    });
    // A second pass finds nothing more of this app's.
    await sweepAppActionLedger(db);
    expect(await ledger()).toEqual([recent.recordId]);
  });
});

// ─── Query budget ─────────────────────────────────────────

/** Statements `run` sends to PostgreSQL (every drizzle query goes through the postgres-js prepared query). */
async function countQueries(run: () => Promise<unknown>): Promise<number> {
  const proto = PostgresJsPreparedQuery.prototype;
  const execute = vi.spyOn(proto, 'execute');
  const all = vi.spyOn(proto, 'all');
  try {
    await run();
    return execute.mock.calls.length + all.mock.calls.length;
  } finally {
    execute.mockRestore();
    all.mockRestore();
  }
}

describe('one card query, one set of reads', () => {
  // Measured 2026-10-11 on this fixture (before → after the per-request reuse):
  // records card with two actions 60 → 34, records card 39 → 31, kpi 38 → 29, a manager's records card 56 → 31.
  // What is left: the kernel's own checks (dispatch, Base gate, data ceiling), the
  // app / version / audience rows, one schema load, and one compile context per db call.
  it('reads the schema, the facts, the ceilings and the action matches once per request', async () => {
    const p = await procurement();
    for (const [title, dept] of [
      ['A', 'ops'],
      ['B', 'eng'],
      ['C', 'ops'],
    ] as const) {
      await submit(p, applicant, [
        { fieldId: p.f.title, value: title },
        { fieldId: p.f.dept, value: dept },
        { fieldId: p.f.amount, value: 1 },
      ]);
    }
    let queue: Extract<AppCardQueryResult, { kind: 'records' }> | undefined;
    const queueQueries = await countQueries(async () => {
      queue = await records(p, approver, 'review', 'queue');
    });
    // Same answer as ever: three pending rows, both actions offered on each.
    expect(queue!.total).toBe(3);
    expect(queue!.records.every((row) => row.actionIds.join() === 'approve,reject')).toBe(true);
    expect(queueQueries).toBeLessThanOrEqual(34);

    expect(await countQueries(() => records(p, applicant, 'mine', 'my-requests'))).toBeLessThanOrEqual(31);
    let kpi: AppCardQueryResult | undefined;
    const kpiQueries = await countQueries(async () => {
      kpi = await json<AppCardQueryResult>(await cardQuery(p, approver, 'stats', 'total'));
    });
    expect(kpi).toEqual({ kind: 'kpi', value: 3 });
    expect(kpiQueries).toBeLessThanOrEqual(29);
    expect(await countQueries(() => records(p, owner, 'review', 'queue'))).toBeLessThanOrEqual(31);
  });
});

// ─── Roles and the realtime audience ──────────────────────

describe('who is who (D3) and who hears changes', () => {
  it('picks the person’s own row, else the first group role in spec order, else the team row', () => {
    const spec = { version: 1, pages: [], roles: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] } as unknown as AppSpec;
    const row = (principal_type: 'user' | 'group' | 'team', role_key: string) => ({ principal_type, role_key });
    expect(pickViewerRole(spec, [row('team', 'c'), row('group', 'b'), row('group', 'a')])?.key).toBe('a');
    expect(pickViewerRole(spec, [row('team', 'c'), row('user', 'b'), row('group', 'a')])?.key).toBe('b');
    expect(pickViewerRole(spec, [row('team', 'c')])?.key).toBe('c');
    // The highest tier decides even when its role is gone (D4): no fallback to a broader one.
    expect(pickViewerRole(spec, [row('user', 'gone'), row('team', 'c')])).toBeUndefined();
    expect(pickViewerRole(spec, [])).toBeUndefined();
  });

  it('tells app audience members (not Base members) about changes to tables their role covers', async () => {
    const p = await procurement();
    const base = (await db.tables.getBase(p.baseId))!;
    const heard = await appAudienceForTable({ db }, base, p.tableId, [applicant.id, approver.id, outsider.id]);
    // Team audience → everyone internal is an applicant, whose role covers Requests.
    expect([...heard].sort()).toEqual([applicant.id, approver.id, outsider.id].sort());
    const vendorsHeard = await appAudienceForTable({ db }, base, p.vendors.tableId, [applicant.id, approver.id]);
    expect([...vendorsHeard]).toEqual([applicant.id]);
  });
});

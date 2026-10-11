/**
 * E2E Security Tests — the app gateway over HTTP (Tables → Apps Phase 1, slice G)
 *
 * Against the live server with real tokens, a procurement app built by a Base
 * owner and shared with two people who are NOT Base members:
 * - the applicant opens the app as their role, submits the form, sees only
 *   their own request and never the hidden "Approval note" (card rows, the
 *   drawer, the spec they receive), and gets nothing through /api/tables;
 * - the approver approves (status / approver written by the app, as them) and
 *   a second approval is refused by the action's precondition (409);
 * - someone outside the audience gets 404 for the app and its cards.
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, BASE_URL, createSuperToken, createTestToken } from './helpers.js';

interface Person {
  id: string;
  token: string;
}

let superToken: string;
let owner: Person;
let applicant: Person;
let approver: Person;
let outsider: Person;
let baseId: number;
let tableId: number;
let appId: number;
const f: Record<'title' | 'amount' | 'status' | 'approver' | 'note', number> = {
  title: 0,
  amount: 0,
  status: 0,
  approver: 0,
  note: 0,
};

const stamp = Date.now();
let counter = 0;

async function call(person: Person | string, path: string, method = 'GET', body?: unknown) {
  const token = typeof person === 'string' ? person : person.token;
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers: authHeaders(token),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function ok<T>(response: Response, status = 200): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(status);
  return JSON.parse(text) as T;
}

async function createTeamUser(label: string): Promise<Person> {
  const created = await ok<{ user: { id: string } }>(
    await call(superToken, '/api/admin/users', 'POST', {
      email: `e2e-apps-${label}-${stamp}@test.local`,
      password: 'TestPass123!',
      nickname: `E2E Apps ${label}`,
      role: 'team',
    }),
    201,
  );
  return { id: created.user.id, token: createTestToken(created.user.id, 'team') };
}

const action = (person: Person, body: Record<string, unknown>) =>
  call(person, `/api/apps/${appId}/actions`, 'POST', { requestId: `e2e-${stamp}-${(counter += 1)}`, ...body });

beforeAll(async () => {
  const health = await fetch(`${BASE_URL}/health`).catch(() => undefined);
  if (!health?.ok)
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  superToken = createSuperToken();
  [owner, applicant, approver, outsider] = [
    await createTeamUser('owner'),
    await createTeamUser('applicant'),
    await createTeamUser('approver'),
    await createTeamUser('outsider'),
  ];

  const base = await ok<{ base: { id: number }; schema: { table: { id: number }; fields: Array<{ id: number }> } }>(
    await call(owner, '/api/tables/bases', 'POST', { name: `E2E Purchasing ${stamp}`, defaultTableName: 'Requests' }),
    201,
  );
  baseId = base.base.id;
  tableId = base.schema.table.id;
  f.title = base.schema.fields[0]!.id;
  const field = async (name: string, type: string, config?: unknown) =>
    (
      await ok<{ field: { id: number } }>(
        await call(owner, `/api/tables/tables/${tableId}/fields`, 'POST', { name, type, config }),
        201,
      )
    ).field.id;
  f.amount = await field('Amount', 'number');
  f.status = await field('Status', 'single_select', {
    options: [
      { id: 'pending', label: 'Pending' },
      { id: 'approved', label: 'Approved' },
    ],
  });
  f.approver = await field('Approver', 'user');
  f.note = await field('Approval note', 'text');

  const layout = { x: 0, y: 0, w: 12, h: 6 };
  const spec = {
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
            fieldIds: [f.title, f.amount, f.status],
            detail: { fieldIds: [f.title, f.amount, f.status, f.note] },
          },
          {
            id: 'new-request',
            kind: 'form',
            layout,
            tableId,
            fieldIds: [f.title, f.amount],
            defaults: [{ fieldId: f.status, value: 'pending' }],
          },
        ],
      },
      {
        id: 'review',
        title: 'Review',
        cards: [
          {
            id: 'queue',
            kind: 'records',
            layout,
            source: { tableId },
            fieldIds: [f.title, f.amount, f.status, f.note],
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
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
    roles: [
      {
        key: 'applicant',
        name: 'Applicant',
        pages: ['mine'],
        tables: [
          {
            tableId,
            access: 'edit',
            rows: { type: 'related', creator: true, fieldIds: [] },
            fields: [
              { fieldId: f.note, access: 'hidden' },
              { fieldId: f.status, access: 'read' },
              { fieldId: f.approver, access: 'read' },
            ],
            fieldDefault: 'visible',
            create: true,
          },
        ],
      },
      {
        key: 'approver',
        name: 'Approver',
        pages: ['review'],
        tables: [
          {
            tableId,
            access: 'edit',
            fields: [
              { fieldId: f.title, access: 'read' },
              { fieldId: f.amount, access: 'read' },
              { fieldId: f.status, access: 'edit' },
              { fieldId: f.approver, access: 'edit' },
              { fieldId: f.note, access: 'edit' },
            ],
            fieldDefault: 'hidden',
            create: false,
          },
        ],
      },
    ],
  };
  const draft = await ok<{ app: { id: number }; draftRevision: number; errors: unknown[] }>(
    await call(owner, '/api/apps', 'POST', { baseId, name: `E2E Purchasing ${stamp}`, spec }),
    201,
  );
  expect(draft.errors).toEqual([]);
  appId = draft.app.id;
  await ok(await call(owner, `/api/apps/${appId}/publish`, 'POST', { draftRevision: draft.draftRevision }));
  await ok(
    await call(owner, `/api/apps/${appId}/audiences`, 'PUT', {
      entries: [
        { principal: { type: 'user', userId: applicant.id }, roleKey: 'applicant' },
        { principal: { type: 'user', userId: approver.id }, roleKey: 'approver' },
      ],
      audiencesRevision: 1,
    }),
  );
  // The owner's own request carries the hidden note.
  await ok(
    await call(owner, `/api/tables/tables/${tableId}/records`, 'POST', {
      values: { [f.title]: 'Owner item', [f.status]: 'pending', [f.note]: 'internal only' },
    }),
    201,
  );
});

describe('a non-member app viewer over HTTP', () => {
  let requestId: number;

  it('opens the app as its role without the hidden column', async () => {
    const view = await ok<{
      role: { key: string };
      spec: { pages: Array<{ id: string }> };
      tables: Array<{ fields: Array<{ id: number }> }>;
    }>(await call(applicant, `/api/apps/${appId}`));
    expect(view.role.key).toBe('applicant');
    expect(view.spec.pages.map((page) => page.id)).toEqual(['mine']);
    expect(view.tables.flatMap((table) => table.fields.map((field) => field.id))).not.toContain(f.note);
    expect(JSON.stringify(view.spec)).not.toContain(`"fieldId":${f.note}`);
  });

  it('submits the form and sees only its own request, never the hidden column', async () => {
    const created = await ok<{ outcome: string; recordId: number }>(
      await action(applicant, {
        pageId: 'mine',
        cardId: 'new-request',
        actionId: '$submit',
        values: [
          { fieldId: f.title, value: 'Laptop' },
          { fieldId: f.amount, value: 900 },
        ],
      }),
    );
    expect(created.outcome).toBe('created');
    requestId = created.recordId;
    const list = await ok<{
      kind: string;
      total: number;
      records: Array<{ id: number; values: Record<string, unknown> }>;
    }>(await call(applicant, `/api/apps/${appId}/cards/query`, 'POST', { pageId: 'mine', cardId: 'my-requests' }));
    expect(list.kind).toBe('records');
    expect(list.records.map((row) => row.id)).toEqual([requestId]);
    expect(list.records[0]!.values[String(f.status)]).toBe('pending');
    const detail = await ok<{ fieldIds: number[]; record: { values: Record<string, unknown> } }>(
      await call(applicant, `/api/apps/${appId}/records/get`, 'POST', {
        pageId: 'mine',
        cardId: 'my-requests',
        recordId: requestId,
      }),
    );
    expect(detail.fieldIds).not.toContain(f.note);
    expect(detail.record.values).not.toHaveProperty(String(f.note));
  });

  it('reaches nothing through /api/tables and nothing of the approver’s page', async () => {
    expect((await call(applicant, `/api/tables/bases/${baseId}`)).status).toBe(404);
    expect((await call(applicant, `/api/tables/tables/${tableId}/records/query`, 'POST', {})).status).toBe(404);
    expect((await call(applicant, `/api/tables/tables/${tableId}/records/${requestId}`)).status).toBe(404);
    expect(
      (await call(applicant, `/api/apps/${appId}/cards/query`, 'POST', { pageId: 'review', cardId: 'queue' })).status,
    ).toBe(404);
  });

  it('lets the approver approve once; the precondition refuses a second approval', async () => {
    const approved = await ok<{ outcome: string }>(
      await action(approver, { pageId: 'review', cardId: 'queue', actionId: 'approve', recordId: requestId }),
    );
    expect(approved.outcome).toBe('updated');
    const again = await action(approver, {
      pageId: 'review',
      cardId: 'queue',
      actionId: 'approve',
      recordId: requestId,
    });
    expect(again.status).toBe(409);
    expect(((await again.json()) as { details: { reason: string } }).details.reason).toBe('precondition');
    const mine = await ok<{ records: Array<{ values: Record<string, unknown> }> }>(
      await call(applicant, `/api/apps/${appId}/cards/query`, 'POST', { pageId: 'mine', cardId: 'my-requests' }),
    );
    // The card shows title / amount / status only: the approver's id stays out of its rows.
    expect(mine.records[0]!.values).toEqual({
      [String(f.title)]: 'Laptop',
      [String(f.amount)]: 900,
      [String(f.status)]: 'approved',
    });
  });

  it('opens nothing for someone outside the audience', async () => {
    expect((await call(outsider, `/api/apps/${appId}`)).status).toBe(404);
    expect(
      (await call(outsider, `/api/apps/${appId}/cards/query`, 'POST', { pageId: 'mine', cardId: 'my-requests' }))
        .status,
    ).toBe(404);
  });
});

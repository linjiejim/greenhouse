/**
 * E2E Security Tests — Tables access control over HTTP (Phase 0 slice A)
 *
 * Against the live server with real tokens:
 * - a custom role ("Sales": customers read, own rows only, amount hidden)
 *   sees only its rows and readable columns, every oracle on the hidden
 *   column is refused, out-of-scope ids are 404, the grant lists, the role
 *   admin and the Base file cabinet are closed to it;
 * - a group grant opens a Base to a group member and never grants builder;
 * - a role still in use cannot be deleted (409 role_in_use).
 *
 * Use `pnpm test:e2e:ci`; manual debugging setup is documented in tests/e2e/README.md.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeaders, BASE_URL, createSuperToken, createTestToken } from './helpers.js';

interface Person {
  id: string;
  token: string;
}

let superToken: string;
let owner: Person;
let sales: Person;
let colleague: Person;
let baseId: number;
let customers: number;
let nameField: number;
let amountField: number;
let repField: number;
let mineId: number;
let theirsId: number;
let roleId: number;
let groupId: number;

const stamp = Date.now();

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
      email: `e2e-tables-${label}-${stamp}@test.local`,
      password: 'TestPass123!',
      nickname: `E2E Tables ${label}`,
      role: 'team',
    }),
    201,
  );
  // Tokens are minted directly (avoids the login rate limit), like the other suites.
  return { id: created.user.id, token: createTestToken(created.user.id, 'team') };
}

beforeAll(async () => {
  const health = await fetch(`${BASE_URL}/health`).catch(() => undefined);
  if (!health?.ok)
    throw new Error(`Server not running at ${BASE_URL}. Run pnpm test:e2e:ci or follow tests/e2e/README.md.`);
  superToken = createSuperToken();
  [owner, sales, colleague] = [
    await createTeamUser('owner'),
    await createTeamUser('sales'),
    await createTeamUser('colleague'),
  ];

  const base = await ok<{ base: { id: number }; schema: { table: { id: number }; fields: Array<{ id: number }> } }>(
    await call(owner, '/api/tables/bases', 'POST', { name: `E2E CRM ${stamp}`, defaultTableName: 'Customers' }),
    201,
  );
  baseId = base.base.id;
  customers = base.schema.table.id;
  nameField = base.schema.fields[0]!.id;
  const field = async (name: string, type: string) =>
    (
      await ok<{ field: { id: number } }>(
        await call(owner, `/api/tables/tables/${customers}/fields`, 'POST', { name, type }),
        201,
      )
    ).field.id;
  amountField = await field('Contract amount', 'number');
  repField = await field('Rep', 'user');
  const record = async (values: Record<string, unknown>) =>
    (
      await ok<{ record: { id: number } }>(
        await call(owner, `/api/tables/tables/${customers}/records`, 'POST', { values }),
        201,
      )
    ).record.id;
  mineId = await record({ [nameField]: 'Mine Co', [amountField]: 100, [repField]: sales.id });
  theirsId = await record({ [nameField]: 'Theirs Co', [amountField]: 9_000_000, [repField]: colleague.id });

  roleId = (
    await ok<{ role: { id: number } }>(
      await call(owner, `/api/tables/bases/${baseId}/roles`, 'POST', {
        name: 'Sales',
        rules: {
          version: 1,
          dashboards: 'none',
          tables: [
            {
              tableId: customers,
              access: 'read',
              rows: { type: 'related', creator: false, fieldIds: [repField] },
              fields: [{ fieldId: amountField, access: 'hidden' }],
              fieldDefault: 'visible',
            },
          ],
        },
      }),
      201,
    )
  ).role.id;
  await ok(
    await call(owner, `/api/tables/bases/${baseId}/members/${sales.id}`, 'PUT', {
      role: 'custom',
      customRoleId: roleId,
    }),
  );
});

afterAll(async () => {
  if (baseId) await call(owner, `/api/tables/bases/${baseId}/archive`, 'POST').catch(() => undefined);
  if (groupId) await call(owner, `/api/groups/${groupId}`, 'DELETE').catch(() => undefined);
  for (const person of [owner, sales, colleague]) {
    if (person?.id) await call(superToken, `/api/admin/users/${person.id}`, 'DELETE').catch(() => undefined);
  }
});

describe('E2E: Tables custom role', () => {
  it('lists the Base and shows the compiled access, not the rules', async () => {
    const listed = await ok<{ bases: Array<{ id: number; role: string }> }>(await call(sales, '/api/tables/bases'));
    expect(listed.bases).toContainEqual(expect.objectContaining({ id: baseId, role: 'viewer' }));
    const workspace = await ok<{
      access: { level: string; rules?: unknown; tables: Array<{ tableId: number; readableFieldIds: number[] }> };
      dashboards: unknown[];
    }>(await call(sales, `/api/tables/bases/${baseId}`));
    expect(workspace.access.level).toBe('custom');
    expect(workspace.access.rules).toBeUndefined();
    expect(workspace.access.tables[0]!.readableFieldIds).not.toContain(amountField);
    expect(workspace.dashboards).toEqual([]);
  });

  it('returns only its rows and never the hidden column', async () => {
    const result = await ok<{ total: number; records: Array<{ id: number; values: Record<string, unknown> }> }>(
      await call(sales, `/api/tables/tables/${customers}/records/query`, 'POST', {}),
    );
    expect(result.total).toBe(1);
    expect(result.records[0]!.id).toBe(mineId);
    expect(result.records[0]!.values).not.toHaveProperty(String(amountField));
    const schema = await ok<{ fields: Array<{ id: number }> }>(
      await call(sales, `/api/tables/tables/${customers}/schema`),
    );
    expect(schema.fields.map((entry) => entry.id)).not.toContain(amountField);
  });

  it('refuses filters, sorts and groups on the hidden column, and hides other rows as missing', async () => {
    const query = (body: unknown) => call(sales, `/api/tables/tables/${customers}/records/query`, 'POST', body);
    const clause = { fieldId: amountField, operator: 'gt', value: 1_000_000 };
    expect((await query({ where: { combinator: 'and', clauses: [clause] } })).status).toBe(400);
    expect((await query({ filters: [{ combinator: 'and', clauses: [clause] }] })).status).toBe(400);
    expect((await query({ sort: [{ fieldId: amountField, direction: 'desc' }] })).status).toBe(400);
    expect((await query({ groupBy: { fieldId: amountField } })).status).toBe(400);
    expect((await call(sales, `/api/tables/tables/${customers}/records/${theirsId}`)).status).toBe(404);
    expect(
      (
        await call(sales, `/api/tables/tables/${customers}/records/${mineId}`, 'PATCH', {
          revision: 1,
          values: { [nameField]: 'Renamed' },
        })
      ).status,
    ).toBe(404);
  });

  it('keeps grants, roles, schema history and the file cabinet closed', async () => {
    expect((await call(sales, `/api/tables/bases/${baseId}/members`)).status).toBe(404);
    expect((await call(sales, `/api/tables/bases/${baseId}/roles`)).status).toBe(404);
    expect((await call(sales, `/api/tables/tables/${customers}/schema/versions`)).status).toBe(404);
    expect((await call(sales, `/api/drive/files?scope=tables&base_id=${baseId}`)).status).toBe(403);
    expect((await call(sales, `/api/tables/bases/${baseId}/dashboards`)).status).toBe(404);
  });
});

describe('E2E: Tables group grants and role references', () => {
  it('opens the Base to a group member and never grants builder to a group', async () => {
    groupId = (
      await ok<{ group: { id: number } }>(
        await call(owner, '/api/groups', 'POST', { name: `E2E Tables group ${stamp}`, member_ids: [colleague.id] }),
        201,
      )
    ).group.id;
    expect(
      (await call(owner, `/api/tables/bases/${baseId}/groups/${groupId}`, 'PUT', { role: 'builder' })).status,
    ).toBe(400);
    await ok(await call(owner, `/api/tables/bases/${baseId}/groups/${groupId}`, 'PUT', { role: 'viewer' }));
    const listed = await ok<{ bases: Array<{ id: number }> }>(await call(colleague, '/api/tables/bases'));
    expect(listed.bases.map((entry) => entry.id)).toContain(baseId);
    const all = await ok<{ total: number }>(
      await call(colleague, `/api/tables/tables/${customers}/records/query`, 'POST', {}),
    );
    expect(all.total).toBe(2);
    expect(
      (await call(colleague, `/api/tables/tables/${customers}/records`, 'POST', { values: { [nameField]: 'x' } }))
        .status,
    ).toBe(404);
  });

  it('refuses to delete a role a member still holds', async () => {
    const response = await call(owner, `/api/tables/roles/${roleId}`, 'DELETE');
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ details: { reason: 'role_in_use', references: { users: 1 } } });
  });
});

/**
 * Schema-plan apply route integration tests (real PostgreSQL).
 *
 * The plan card is the confirm gate, but the gate that MATTERS is here: the
 * apply route re-authorizes every operation through its own runtime action, so
 * a plan submitted by someone without the builder role must fail no matter what
 * the drafting tool decided. These tests exercise that path end to end, plus
 * the sequencing rules a fake dispatch cannot prove (refs resolving to real
 * ids, a real name conflict cascading into skips).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { SchemaPlanApplyResult } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createTablesSchemaPlanTool } from '../../tools/tables-schema-plan.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let sessionId: string;
let actionCounter = 0;

function createHttpApp(users: UserRow[]) {
  const byId = new Map(users.map((user) => [user.id, user]));
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    const user = byId.get(c.req.header('x-test-user') ?? '');
    if (!user) return c.json({ error: 'Unknown test user' }, 401);
    c.set('user', { id: user.id, role: user.role });
    return next();
  });
  app.route('/api/tables', tablesRoutes);
  return app;
}

type TestApp = ReturnType<typeof createHttpApp>;

async function apply(app: TestApp, userId: string, operations: unknown[], actionId?: string) {
  const actionSessionId =
    userId === owner.id
      ? sessionId
      : (await db.sessions.create('Schema plan actor', undefined, userId, undefined, 'web')).id;
  const response = await app.request('/api/tables/schema-plan/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify({
      operations,
      action_id: actionId ?? `artifact:message-${++actionCounter}:1:tables_schema_plan`,
      session_id: actionSessionId,
    }),
  });
  return { status: response.status, body: (await response.json()) as SchemaPlanApplyResult & { error?: string } };
}

async function createBase(app: TestApp, name: string) {
  const response = await app.request('/api/tables/bases', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
    body: JSON.stringify({ name, visibility: 'private' }),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { base: { id: number }; schema: { table: { id: number } } };
}

async function executeTool(tool: unknown, input: unknown): Promise<unknown> {
  const executable = tool as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return executable.execute(input, { toolCallId: 'schema-plan-test', messages: [] });
}

describe('Tables schema plan apply', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: 'schema-plan-owner@test.com' });
    sessionId = (await db.sessions.create('Schema plan', undefined, owner.id, undefined, 'web')).id;
    actionCounter = 0;
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('builds a whole Base from one plan, resolving refs to real ids', async () => {
    const app = createHttpApp([owner]);
    const { status, body } = await apply(app, owner.id, [
      { op: 'base.create', ref: 'b', name: 'Growth', defaultTableRef: 'leads', defaultTableName: 'Leads' },
      { op: 'field.create', tableRef: 'leads', name: 'Company', type: 'text' },
      {
        op: 'field.create',
        tableRef: 'leads',
        name: 'Stage',
        type: 'single_select',
        config: {
          options: [
            { id: 'new', label: '新线索' },
            { id: 'won', label: '已成交' },
          ],
        },
      },
      { op: 'table.create', ref: 'notes', baseRef: 'b', name: 'Notes' },
      { op: 'field.create', tableRef: 'notes', name: 'Body', type: 'long_text' },
    ]);

    expect(status).toBe(200);
    expect(body.results.map((entry) => entry.status)).toEqual(['applied', 'applied', 'applied', 'applied', 'applied']);
    expect(body.baseId).toBeDefined();

    const workspace = await app.request(`/api/tables/bases/${body.baseId}`, { headers: { 'x-test-user': owner.id } });
    const loaded = (await workspace.json()) as { tables: Array<{ id: number; name: string }> };
    // The Base's mandatory first table was NAMED and used, not left as a stray "Table 1".
    expect(loaded.tables.map((table) => table.name).sort()).toEqual(['Leads', 'Notes']);

    const leads = loaded.tables.find((table) => table.name === 'Leads')!;
    const schema = await app.request(`/api/tables/tables/${leads.id}/schema`, {
      headers: { 'x-test-user': owner.id },
    });
    const fields = ((await schema.json()) as { fields: Array<{ name: string; type: string }> }).fields;
    // "Name" is the primary field every table is born with; the plan added two more.
    expect(fields.map((field) => field.name)).toEqual(['Name', 'Company', 'Stage']);
  });

  it('returns the durable receipt on a duplicate action without applying twice', async () => {
    const app = createHttpApp([owner]);
    const operations = [
      { op: 'base.create', ref: 'b', name: 'Exactly Once', defaultTableRef: 't', defaultTableName: 'Rows' },
    ];
    const actionId = 'artifact:message-idempotent:1:tables_schema_plan';
    const first = await apply(app, owner.id, operations, actionId);
    const second = await apply(app, owner.id, operations, actionId);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toEqual(first.body);
    const bases = await db.tables.listBasesForUser(owner.id);
    expect(bases.filter((base) => base.name === 'Exactly Once')).toHaveLength(1);
  });

  it('accepts an action id derived from a runtime-result message id (colons inside)', async () => {
    // Runtime-traced turns persist the assistant message as
    // `chat-runtime-result:<runId>:<status>`, so the card-derived action id
    // carries colons inside its message segment. Regression: this used to be
    // rejected with 400 "Invalid artifact action id".
    const app = createHttpApp([owner]);
    const { status, body } = await apply(
      app,
      owner.id,
      [{ op: 'base.create', ref: 'b', name: 'Runtime Turn', defaultTableRef: 't', defaultTableName: 'Rows' }],
      'artifact:chat-runtime-result:rtr_ce56a43e080740eb8ea30c0f554ab73e:succeeded:0:tables_schema_plan',
    );

    expect(status).toBe(200);
    expect(body.results.map((entry) => entry.status)).toEqual(['applied']);
  });

  it('skips the fields of a table that failed, and still applies independent work', async () => {
    const app = createHttpApp([owner]);
    const base = await createBase(app, 'Conflicts');
    // Collides with the table created alongside the Base.
    const existing = await app.request(`/api/tables/tables/${base.schema.table.id}/schema`, {
      headers: { 'x-test-user': owner.id },
    });
    const existingName = ((await existing.json()) as { table: { name: string } }).table.name;

    const { body } = await apply(app, owner.id, [
      { op: 'table.create', ref: 'dup', baseId: base.base.id, name: existingName },
      { op: 'field.create', tableRef: 'dup', name: 'Orphan', type: 'text' },
      { op: 'field.create', tableId: base.schema.table.id, name: 'Survivor', type: 'text' },
    ]);

    expect(body.results.map((entry) => entry.status)).toEqual(['failed', 'skipped', 'applied']);
    expect(body.results[1]?.message).toMatch(/was not created/);

    const schema = await app.request(`/api/tables/tables/${base.schema.table.id}/schema`, {
      headers: { 'x-test-user': owner.id },
    });
    const fields = ((await schema.json()) as { fields: Array<{ name: string }> }).fields;
    expect(fields.map((field) => field.name)).toContain('Survivor');
    // The orphaned field must not have landed anywhere.
    expect(fields.map((field) => field.name)).not.toContain('Orphan');
  });

  it('refuses an editor even when the plan reaches the route directly', async () => {
    const editor = await createInternalTestUser(db, { email: 'schema-plan-editor@test.com' });
    const app = createHttpApp([owner, editor]);
    const base = await createBase(app, 'Guarded');
    const member = await app.request(`/api/tables/bases/${base.base.id}/members/${editor.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'editor' }),
    });
    expect(member.status).toBe(200);

    // The drafting tool says no…
    const drafted = (await executeTool(createTablesSchemaPlanTool({ userId: editor.id }), {
      summary: 'add a field',
      operations: [{ op: 'field.create', tableId: base.schema.table.id, name: 'Sneaky', type: 'text' }],
    })) as { error?: string };
    expect(drafted.error).toMatch(/builder role/);

    // …and so does the route, which is what actually protects the data.
    const { body } = await apply(app, editor.id, [
      { op: 'field.create', tableId: base.schema.table.id, name: 'Sneaky', type: 'text' },
    ]);
    expect(body.results[0]?.status).toBe('failed');

    const schema = await app.request(`/api/tables/tables/${base.schema.table.id}/schema`, {
      headers: { 'x-test-user': owner.id },
    });
    const fields = ((await schema.json()) as { fields: Array<{ name: string }> }).fields;
    expect(fields.map((field) => field.name)).not.toContain('Sneaky');
  });

  it('lets a builder change structure but not Base settings', async () => {
    const builder = await createInternalTestUser(db, { email: 'schema-plan-builder@test.com' });
    const app = createHttpApp([owner, builder]);
    const base = await createBase(app, 'Delegated');
    await app.request(`/api/tables/bases/${base.base.id}/members/${builder.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'builder' }),
    });

    const { body } = await apply(app, builder.id, [
      { op: 'field.create', tableId: base.schema.table.id, name: 'Allowed', type: 'text' },
    ]);
    expect(body.results[0]?.status).toBe('applied');

    // Renaming the Base is the creator's call, so the drafting tool refuses it
    // outright rather than producing a card that cannot work.
    const drafted = (await executeTool(createTablesSchemaPlanTool({ userId: builder.id }), {
      summary: 'rename the base',
      operations: [{ op: 'base.update', baseId: base.base.id, name: 'Renamed by builder' }],
    })) as { error?: string };
    expect(drafted.error).toMatch(/only the creator/);

    const renamed = await apply(app, builder.id, [
      { op: 'base.update', baseId: base.base.id, name: 'Renamed by builder' },
    ]);
    expect(renamed.body.results[0]?.status).toBe('failed');
  });

  it('rejects a structurally broken plan before touching anything', async () => {
    const app = createHttpApp([owner]);
    const { status, body } = await apply(app, owner.id, [
      { op: 'field.create', tableRef: 'never-declared', name: 'Nope', type: 'text' },
    ]);
    expect(status).toBe(400);
    expect(body.error).toMatch(/no table with ref/);
  });
});

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
import type { SchemaPlanApplyResult, TableFormConfig, TablesSchemaPlanArtifact } from '@greenhouse/types/tables';
import type { AppEnv } from '../../app-env.js';
import tablesRoutes from '../tables/index.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createTablesSchemaPlanTool } from '../../tools/tables-schema-plan.js';
import { artifactRequestHash } from '../../chat/artifact-actions.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import acceptancePlan from '../../platform/tables/__tests__/fixtures/acceptance-plan.json';

let db: DatabaseProvider;
let owner: UserRow;
let sessionId: string;
let actionCounter = 0;
let actorSessions = new Map<string, string>();

/** One chat session per non-owner actor, so a retry presents the same session as the first apply. */
async function actorSession(userId: string): Promise<string> {
  let id = actorSessions.get(userId);
  if (!id) {
    id = (await db.sessions.create('Schema plan actor', undefined, userId, undefined, 'web')).id;
    actorSessions.set(userId, id);
  }
  return id;
}

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

async function apply(
  app: TestApp,
  userId: string,
  operations: unknown[],
  actionId?: string,
  options: { retry?: boolean } = {},
) {
  const actionSessionId = userId === owner.id ? sessionId : await actorSession(userId);
  const response = await app.request('/api/tables/schema-plan/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-user': userId },
    body: JSON.stringify({
      operations,
      action_id: actionId ?? `artifact:message-${++actionCounter}:1:tables_schema_plan`,
      session_id: actionSessionId,
      ...(options.retry ? { retry: true } : {}),
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
    actorSessions = new Map();
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

  it('applies the acceptance plan — field, kanban, team form, automation, dashboard, role, group grant — with 0 failed', async () => {
    const app = createHttpApp([owner]);
    const member = await createInternalTestUser(db, { email: 'schema-plan-agent@test.com' });
    const group = await db.groups.create({ name: 'Support desk', created_by: owner.id });
    await db.groups.addMembers(group.id, [member.id], owner.id);
    const operations = acceptancePlan.operations.map((operation) =>
      operation.op === 'member.set' ? { ...operation, groupId: group.id } : operation,
    );

    // Drafted first: the same plan passes the virtual-schema check and lists its access changes.
    const drafted = (await executeTool(createTablesSchemaPlanTool({ userId: owner.id }), {
      summary: acceptancePlan.summary,
      operations,
    })) as TablesSchemaPlanArtifact & { error?: string };
    expect(drafted.error).toBeUndefined();
    expect(drafted.type).toBe('tables_schema_plan');
    expect(drafted.accessChanges?.map((change) => change.kind)).toEqual(['form', 'role', 'grant']);

    const { status, body } = await apply(app, owner.id, operations);
    expect(status).toBe(200);
    expect(body.results.filter((entry) => entry.status !== 'applied')).toEqual([]);
    expect(body.attempts).toBe(1);

    const refs = body.refs!;
    const tableId = refs.tickets!.id;
    const statusId = refs.status!.id;
    const closedId = refs.closed!.id;

    const views = await db.tables.listViews(tableId, owner.id);
    const board = views.find((view) => view.id === refs.board!.id)!;
    expect(board.type).toBe('kanban');
    expect(JSON.parse(board.config)).toMatchObject({
      kanban: { groupFieldId: statusId },
      fieldIds: [refs.details!.id],
      widths: { [String(refs.details!.id)]: 280 },
    });

    const form = (await db.tables.listForms(tableId)).find((candidate) => candidate.id === refs.intake!.id)!;
    expect(form.status).toBe('published');
    expect(form.audience).toEqual({ type: 'team' });
    expect((form.config as TableFormConfig).defaults).toEqual([{ fieldId: statusId, value: 'new' }]);

    const [rule] = await db.tables.listAutomationRules(body.baseId!);
    expect(rule).toMatchObject({ id: refs.stamp!.id, status: 'enabled', execution_user_id: owner.id });
    expect(rule!.config.actions).toEqual([
      { id: 'a1', type: 'update_record', values: [{ fieldId: closedId, value: '$today' }] },
    ]);

    const dashboard = await db.tables.getDashboard(refs.overview!.id);
    expect(dashboard?.widgets.map((widget) => widget.type).sort()).toEqual(['bar', 'kpi']);

    const [role] = await db.tables.listBaseRoles(body.baseId!);
    expect(role).toMatchObject({ id: refs.agent!.id, name: 'Support agent' });
    expect(role!.rules.tables[0]).toMatchObject({ tableId, access: 'edit' });
    const [grant] = await db.tables.listBaseGroupGrants(body.baseId!);
    expect(grant).toMatchObject({ group_id: group.id, role: 'custom', custom_role_id: role!.id });
  });

  it('reports an invalid widget to the model before any card exists', async () => {
    const base = await createBase(createHttpApp([owner]), 'Draft checks');
    const drafted = (await executeTool(createTablesSchemaPlanTool({ userId: owner.id }), {
      summary: 'a dashboard',
      operations: [
        { op: 'field.create', ref: 'note', tableId: base.schema.table.id, name: 'Note', type: 'text' },
        { op: 'dashboard.create', ref: 'd', baseId: base.base.id, name: 'Numbers' },
        {
          op: 'widget.create',
          dashboardRef: 'd',
          title: 'Average note',
          card: {
            kind: 'kpi',
            source: { tableId: base.schema.table.id },
            aggregate: { operation: 'avg', valueFieldId: '$field:note' },
          },
        },
      ],
    })) as { error?: string; problems?: string[]; type?: string };
    expect(drafted.type).toBeUndefined();
    expect(drafted.problems).toEqual([
      'operation 3 (widget.create "Average note"): avg requires a numeric value field',
    ]);
    expect(drafted.error).toContain('fix this problem and call tables_schema_plan again');
    // Nothing was written by drafting.
    const schema = await db.tables.getSchema(base.schema.table.id, owner.id);
    expect(schema?.fields.map((field) => field.name)).not.toContain('Note');
  });

  it('retries only the unfinished operations, reusing the stored ref map', async () => {
    const builder = await createInternalTestUser(db, { email: 'schema-plan-retry@test.com' });
    const app = createHttpApp([owner, builder]);
    const base = await createBase(app, 'Retry desk');
    const granted = await app.request(`/api/tables/bases/${base.base.id}/members/${builder.id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ role: 'builder' }),
    });
    expect(granted.status).toBe(200);
    const group = await db.groups.create({ name: 'Retry group', created_by: builder.id });

    // A builder may add tables and fields, but roles and grants are the owner's.
    const operations = [
      { op: 'table.create', ref: 'queue', baseId: base.base.id, name: 'Queue' },
      { op: 'field.create', ref: 'state', tableRef: 'queue', name: 'State', type: 'text' },
      {
        op: 'role.create',
        ref: 'reviewer',
        baseId: base.base.id,
        name: 'Reviewer',
        rules: {
          version: 1,
          dashboards: 'none',
          tables: [{ tableId: '$table:queue', access: 'read', fields: [], fieldDefault: 'visible' }],
        },
      },
      {
        op: 'member.set',
        baseId: base.base.id,
        principal: 'group',
        groupId: group.id,
        role: 'custom',
        roleRef: 'reviewer',
      },
    ];
    const actionId = 'artifact:message-retry:1:tables_schema_plan';
    const first = await apply(app, builder.id, operations, actionId);
    expect(first.body.results.map((entry) => entry.status)).toEqual(['applied', 'applied', 'failed', 'skipped']);
    expect(first.body.results[3]?.message).toMatch(/was not created/);

    // A refresh returns the same receipt; it never re-runs anything on its own.
    const again = await apply(app, builder.id, operations, actionId);
    expect(again.body).toEqual(first.body);

    // The owner hands the Base over; now the unfinished part can apply.
    const transferred = await app.request(`/api/tables/bases/${base.base.id}/transfer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-test-user': owner.id },
      body: JSON.stringify({ userId: builder.id, previousOwnerRole: 'builder' }),
    });
    expect(transferred.status).toBe(200);
    const retried = await apply(app, builder.id, operations, actionId, { retry: true });
    expect(retried.status).toBe(200);
    expect(retried.body.results.map((entry) => entry.status)).toEqual(['applied', 'applied', 'applied', 'applied']);
    expect(retried.body.attempts).toBe(2);
    expect(retried.body.refs?.queue).toEqual(first.body.refs?.queue);

    // Nothing that applied the first time was created twice.
    const tables = await db.tables.listTables(base.base.id);
    expect(tables.filter((table) => table.name === 'Queue')).toHaveLength(1);
    const queue = await db.tables.getSchema(first.body.refs!.queue!.id, owner.id);
    expect(queue?.fields.filter((field) => field.name === 'State')).toHaveLength(1);
    const [grant] = await db.tables.listBaseGroupGrants(base.base.id);
    expect(grant).toMatchObject({
      group_id: group.id,
      role: 'custom',
      custom_role_id: retried.body.refs!.reviewer!.id,
    });

    // The receipt holds the merged result; retrying a finished plan changes nothing.
    const receipt = await db.chatArtifactReceipts.getForUser(actionId, builder.id);
    expect(receipt?.status).toBe('succeeded');
    expect(JSON.parse(receipt!.result)).toEqual(retried.body);
    const done = await apply(app, builder.id, operations, actionId, { retry: true });
    expect(done.body).toEqual(retried.body);
  });

  it('refuses a retry of a plan that was never applied, and a retry while one runs', async () => {
    const app = createHttpApp([owner]);
    const operations = [{ op: 'base.create', ref: 'b', name: 'Never applied' }];
    const neverApplied = await apply(app, owner.id, operations, 'artifact:message-never:1:tables_schema_plan', {
      retry: true,
    });
    expect(neverApplied.status).toBe(409);
    // The refusal claimed nothing: the real apply still works afterwards.
    const real = await apply(app, owner.id, operations, 'artifact:message-never:1:tables_schema_plan');
    expect(real.body.results[0]?.status).toBe('applied');

    // A plan whose receipt is still processing (another tab mid-apply) cannot be retried.
    await db.chatArtifactReceipts.claim({
      id: 'artifact:message-busy:1:tables_schema_plan',
      session_id: sessionId,
      user_id: owner.id,
      kind: 'tables_schema_plan',
      request_hash: artifactRequestHash(operations),
    });
    const busy = await apply(app, owner.id, operations, 'artifact:message-busy:1:tables_schema_plan', { retry: true });
    expect(busy.status).toBe(409);
  });
});

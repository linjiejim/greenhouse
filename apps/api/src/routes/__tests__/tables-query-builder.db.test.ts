/**
 * The `tables_query` reads a builder needs before drafting a plan (slice P):
 * forms, automations (webhook targets reduced to their origin), runs, roles
 * (owner only, no rule-editor facts), record activity, the people and groups
 * the caller may share with, `builder.reference`, and the apps on a Base
 * (`apps.list`; `apps.get` = a manager's draft + audiences — both behind the
 * per-user `apps` switch, like `/api/apps`). Real PostgreSQL and the real
 * Platform runtime: every read goes through dispatch as the caller.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type { AppAudiencesView, AppDraftView } from '@greenhouse/types/apps';
import { dispatchTablesAgentAction } from '../../platform/tables/agent-adapter.js';
import { tablesRegistration } from '../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../platform/runtime.js';
import { createTablesQueryTool } from '../../tools/tables-query.js';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let stranger: UserRow;

async function query(userId: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const tool = createTablesQueryTool({ userId }) as unknown as {
    execute: (value: unknown, options: { toolCallId: string; messages: never[] }) => Promise<unknown>;
  };
  return (await tool.execute(input, { toolCallId: 'tables-query-builder', messages: [] })) as Record<string, unknown>;
}

async function seed() {
  const base = await db.tables.createBase({ name: 'Builder reads', owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Requests', created_by: owner.id });
  await db.tables.upsertBaseMember({
    base_id: base.id,
    user_id: builder.id,
    role: 'builder',
    custom_role_id: null,
    added_by: owner.id,
  });
  const primary = schema.fields[0]!;
  const form = await db.tables.createForm({
    table_id: schema.table.id,
    name: 'Intake',
    config: { fieldIds: [primary.id] },
    audience: { type: 'team' },
    user_id: owner.id,
  });
  const rule = await db.tables.createAutomationRule({
    base_id: base.id,
    table_id: schema.table.id,
    name: 'Ping',
    trigger: 'record_created',
    config: { actions: [{ type: 'webhook', url: 'https://hooks.example.com/in?token=s3cret-value' }] },
    user_id: owner.id,
  });
  const role = await db.tables.createBaseRole({
    base_id: base.id,
    name: 'Reader',
    rules: { version: 1, dashboards: 'none', tables: [] },
    created_by: owner.id,
  });
  const record = await db.tables.createRecord(
    { table_id: schema.table.id, values: { [primary.id]: 'First' } },
    fullTableAccess(owner.id),
    { actorId: owner.id, actorKind: 'user', enqueueAutomations: false },
  );
  return { base, schema, form, rule, role, record };
}

describe('tables_query builder reads', () => {
  beforeEach(async () => {
    db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
    owner = await createInternalTestUser(db, { email: 'tq-p-owner@test.com', nickname: 'Olivia Owner' });
    builder = await createInternalTestUser(db, { email: 'tq-p-builder@test.com', nickname: 'Bruno Builder' });
    stranger = await createInternalTestUser(db, { email: 'tq-p-stranger@test.com', nickname: 'Sam Stranger' });
    initializePlatformRuntime(db, [tablesRegistration]);
  });

  afterEach(async () => {
    resetPlatformRuntimeForTests();
    await db.close();
    _resetProvider();
  });

  it('lists forms, automations without their webhook secrets, and runs', async () => {
    const { base, schema, form, rule } = await seed();

    const forms = await query(builder.id, { action: 'forms.list', table_id: schema.table.id });
    expect(forms.forms).toEqual([expect.objectContaining({ id: form.id, name: 'Intake', audience: { type: 'team' } })]);

    const automations = (await query(builder.id, { action: 'automations.list', base_id: base.id })) as {
      automations: Array<{ id: number; config: { actions: Array<{ url?: string }> } }>;
    };
    expect(automations.automations).toHaveLength(1);
    expect(automations.automations[0]!.config.actions[0]!.url).toBe('https://hooks.example.com/…');
    expect(JSON.stringify(automations)).not.toContain('s3cret');

    const runs = await query(builder.id, { action: 'automations.runs', automation_id: rule.id });
    expect(runs).toEqual({ runs: [] });
    expect(await query(builder.id, { action: 'automations.runs' })).toEqual({ error: 'automation_id is required' });
  });

  it('shows roles to the owner only, without the rule-editor facts', async () => {
    const { base, role } = await seed();
    const listed = await query(owner.id, { action: 'roles.list', base_id: base.id });
    expect(listed).toEqual({
      roles: [expect.objectContaining({ id: role.id, name: 'Reader' })],
      references: [{ roleId: role.id, users: 0, groups: 0, team: false }],
    });
    expect(await query(builder.id, { action: 'roles.list', base_id: base.id })).toMatchObject({
      error: expect.any(String),
    });
  });

  it('reads a record’s activity', async () => {
    const { schema, record } = await seed();
    const activity = (await query(builder.id, {
      action: 'records.activity',
      table_id: schema.table.id,
      record_id: record.id,
    })) as { items: Array<{ type?: string }> };
    expect(activity.items.length).toBeGreaterThan(0);
  });

  it('finds people and the groups the caller may grant', async () => {
    const visible = await db.groups.create({ name: 'Builders guild', created_by: builder.id });
    await db.groups.addMembers(visible.id, [owner.id], builder.id);
    await db.groups.create({ name: 'Builders secret club', created_by: owner.id });

    const found = (await query(builder.id, { action: 'directory.search', search: 'build' })) as {
      users: Array<{ id: string; name: string }>;
      groups: Array<{ id: number; name: string; memberCount: number; managedBy: { id: string; name: string } }>;
    };
    expect(found.users.map((user) => user.id)).toEqual([builder.id]);
    // The group the owner made without the builder in it stays invisible (D12).
    expect(found.groups).toEqual([
      { id: visible.id, name: 'Builders guild', memberCount: 1, managedBy: { id: builder.id, name: 'Bruno Builder' } },
    ]);
  });

  it('returns the builder reference for a topic', async () => {
    const view = (await query(builder.id, { action: 'builder.reference', topic: 'view' })) as {
      topic: string;
      notes: string[];
      examples: Array<{ op: string }>;
    };
    expect(view.topic).toBe('view');
    expect(view.examples.every((example) => example.op === 'view.create')).toBe(true);
    const plan = (await query(builder.id, { action: 'builder.reference' })) as { topic: string; example: unknown[] };
    expect(plan.topic).toBe('plan');
    expect(plan.example.length).toBeGreaterThan(3);
  });

  it('lists the apps of a Base and reads a manager’s draft with its audiences', async () => {
    const { base } = await seed();
    const created = await dispatchTablesAgentAction({ userId: owner.id }, 'createApp', {
      baseId: base.id,
      name: 'Requests app',
    });
    if (!created.ok) throw new Error(created.message);
    const appId = (created.data as AppDraftView).app.id;

    const listed = (await query(builder.id, { action: 'apps.list', base_id: base.id })) as {
      managed: Array<{ id: number; canManage: boolean }>;
      shared: unknown[];
    };
    expect(listed.managed.map((app) => [app.id, app.canManage])).toEqual([[appId, true]]);
    expect(listed.shared).toEqual([]);
    expect(await query(builder.id, { action: 'apps.list', base_id: base.id + 1000 })).toEqual({
      managed: [],
      shared: [],
    });

    const read = (await query(builder.id, { action: 'apps.get', app_id: appId })) as unknown as AppDraftView & {
      audiences: AppAudiencesView | null;
    };
    expect(read.app.id).toBe(appId);
    expect(read.draftRevision).toBe(1);
    expect(read.spec.pages.map((page) => page.id)).toEqual(['home']);
    expect(read.audiences).toEqual({ entries: [], audiencesRevision: 1, roles: [{ key: 'member', name: 'Member' }] });
    // Not a manager of the Base: no draft.
    expect(await query(stranger.id, { action: 'apps.get', app_id: appId })).toEqual({ error: expect.any(String) });
    expect(await query(stranger.id, { action: 'apps.list' })).toEqual({ managed: [], shared: [] });
  });

  it('answers apps.list and apps.get only while the apps switch is on', async () => {
    const { base } = await seed();
    const created = await dispatchTablesAgentAction({ userId: owner.id }, 'createApp', {
      baseId: base.id,
      name: 'Requests app',
    });
    if (!created.ok) throw new Error(created.message);
    const appId = (created.data as AppDraftView).app.id;
    await db.userFeatures.upsert({ user_id: builder.id, feature: 'apps', enabled: false });

    const off = { error: 'Apps are turned off for you' };
    expect(await query(builder.id, { action: 'apps.list', base_id: base.id })).toEqual(off);
    expect(await query(builder.id, { action: 'apps.get', app_id: appId })).toEqual(off);
    // Tables reads are unaffected: the two switches are independent.
    expect(await query(builder.id, { action: 'base.get', base_id: base.id })).not.toHaveProperty('error');
  });
});

/**
 * Draft-time validation of schema plans against a virtual schema.
 *
 * The reader is faked (no database, no runtime): it answers the Tables read
 * actions the draft check dispatches. What runs for real is everything that
 * decides — the analyzer, the `$<kind>:<ref>` rewrite to placeholders, and the
 * `@greenhouse/db` config validators the handlers use on apply.
 */

import { describe, expect, it } from 'vitest';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { draftSchemaPlan, type SchemaPlanReader } from '../schema-plan-draft.js';
import {
  allReferenceOperations,
  builderReference,
  BUILDER_REFERENCE_TOPICS,
  EXAMPLE_GROUP_ID,
  EXAMPLE_USER_ID,
  PLAN_EXAMPLE,
} from '../builder-reference.js';

const ME = 'u_drafter';
const NOW = '2026-10-11T00:00:00.000Z';

function fieldRow(id: number, tableId: number, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    table_id: tableId,
    name,
    type,
    required: false,
    is_primary: false,
    config: '{}',
    position: id,
    created_by: ME,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    ...extra,
  };
}

interface World {
  level?: string;
  roles?: Array<{ id: number; name: string; rules: unknown; revision: number }>;
  members?: Array<{ user_id: string; role: string; custom_role_id: number | null }>;
  automations?: Array<Record<string, unknown>>;
  groups?: Array<{ id: number; name: string }>;
}

/** One existing Base (id 1) with one table (id 10): Name, Title (text), Status (single select), Due (date). */
function reader(world: World = {}): SchemaPlanReader {
  const ok = (data: unknown): PlatformActionResult => ({ ok: true, data });
  const notFound: PlatformActionResult = { ok: false, code: 'NOT_FOUND', message: 'not found' };
  const statusConfig = JSON.stringify({
    options: [
      { id: 'open', label: 'Open' },
      { id: 'done', label: 'Done' },
    ],
  });
  return {
    userId: ME,
    grantableGroups: async () => world.groups ?? [{ id: EXAMPLE_GROUP_ID, name: 'Sales' }],
    dispatch: async (actionId, payload) => {
      const input = payload as Record<string, number>;
      switch (actionId) {
        case 'getBase':
          return input.baseId === 1
            ? ok({
                base: { id: 1, name: 'Ops', owner_id: ME, visibility: 'private', team_role: 'viewer' },
                access: { level: world.level ?? 'owner' },
                tables: [{ id: 10, name: 'Tasks' }],
                dashboards: [{ id: 30, name: 'Overview' }],
              })
            : notFound;
        case 'getSchema':
          return input.tableId === 10
            ? ok({
                table: { id: 10, base_id: 1, name: 'Tasks' },
                fields: [
                  fieldRow(100, 10, 'Name', 'text', { is_primary: true, required: true }),
                  fieldRow(101, 10, 'Title', 'text'),
                  fieldRow(102, 10, 'Status', 'single_select', { config: statusConfig }),
                  fieldRow(103, 10, 'Due', 'date'),
                ],
                views: [{ id: 20, type: 'grid', scope: 'shared', config: '{}', revision: 4 }],
              })
            : notFound;
        case 'listMembers':
          return input.baseId === 1 ? ok({ members: world.members ?? [], groups: [] }) : notFound;
        case 'listRoles':
          return input.baseId === 1 ? ok({ roles: world.roles ?? [] }) : notFound;
        case 'listAssignableUsers':
          return ok({
            users: [
              { id: ME, nickname: 'Drafter' },
              { id: EXAMPLE_USER_ID, nickname: 'Alice' },
            ],
          });
        case 'listAutomations':
          return input.baseId === 1 ? ok({ automations: world.automations ?? [] }) : notFound;
        case 'listForms':
          return ok({ forms: [] });
        case 'getDashboard':
          return input.dashboardId === 30
            ? ok({
                dashboard: { id: 30, base_id: 1, name: 'Overview', revision: 2 },
                widgets: [{ id: 31, type: 'kpi', revision: 1 }],
              })
            : notFound;
        default:
          return notFound;
      }
    },
  };
}

async function problemsOf(operations: SchemaPlanOperation[], world?: World): Promise<string[]> {
  const draft = await draftSchemaPlan(operations, reader(world));
  return draft.ok ? [] : draft.problems;
}

describe('draftSchemaPlan', () => {
  it('accepts every builder.reference example (an example the server would refuse cannot ship)', async () => {
    const draft = await draftSchemaPlan(allReferenceOperations(), reader());
    expect(draft).toMatchObject({ ok: true });
    for (const topic of BUILDER_REFERENCE_TOPICS) {
      expect(JSON.stringify(builderReference(topic)).length, topic).toBeLessThan(6_000);
    }
    expect(builderReference('plan')).toMatchObject({ example: PLAN_EXAMPLE });
  });

  it('derives every permission change before → after', async () => {
    const draft = await draftSchemaPlan(allReferenceOperations(), reader());
    if (!draft.ok) throw new Error(draft.problems.join('\n'));
    expect(draft.accessChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'form',
          form: 'New lead',
          before: null,
          after: { kind: 'team' },
          published: true,
        }),
        expect.objectContaining({
          kind: 'role',
          role: 'Sales rep',
          before: null,
          after: {
            dashboards: true,
            tables: [{ table: 'Deals', access: 'edit', limitedRows: true, hiddenFields: 0 }],
          },
        }),
        expect.objectContaining({
          kind: 'grant',
          principal: 'group',
          name: 'Sales',
          base: 'Sales CRM',
          before: { kind: 'none' },
          after: { kind: 'custom', roleName: 'Sales rep' },
        }),
        expect.objectContaining({
          kind: 'grant',
          principal: 'user',
          name: 'Alice',
          after: { kind: 'role', role: 'editor' },
        }),
        expect.objectContaining({
          kind: 'team',
          base: 'Sales CRM',
          before: { kind: 'none' },
          after: { kind: 'role', role: 'viewer' },
        }),
      ]),
    );
  });

  it('reports an invalid widget card, naming the plan ref instead of a placeholder id', async () => {
    const problems = await problemsOf([
      { op: 'field.create', ref: 'title2', tableId: 10, name: 'Subtitle', type: 'text' },
      { op: 'dashboard.create', ref: 'd', baseId: 1, name: 'Board' },
      {
        op: 'widget.create',
        dashboardRef: 'd',
        title: 'By month',
        card: {
          kind: 'chart',
          source: { tableId: 10 },
          aggregate: { operation: 'count', groupBy: { fieldId: '$field:title2', dateBucket: 'month' } },
        },
      },
      {
        op: 'widget.create',
        dashboardId: 30,
        title: 'Total',
        card: { kind: 'kpi', source: { tableId: 10 }, aggregate: { operation: 'sum' } },
      },
    ]);
    expect(problems).toEqual([
      'operation 3 (widget.create "By month"): A date bucket requires a date or datetime field',
      'operation 4 (widget.create "Total"): sum requires aggregate.valueFieldId',
    ]);
  });

  it('runs the view validator against fields of the existing table and the plan', async () => {
    const problems = await problemsOf([
      { op: 'view.create', tableId: 10, name: 'By title', type: 'kanban', config: { kanban: { groupFieldId: 101 } } },
      { op: 'field.create', ref: 'owner', tableId: 10, name: 'Owner', type: 'user' },
      {
        op: 'view.create',
        tableId: 10,
        name: 'By owner',
        type: 'kanban',
        config: { kanban: { groupFieldId: '$field:owner' } },
      },
      { op: 'view.update', tableId: 10, viewId: 20, revision: 3, type: 'calendar' },
    ]);
    expect(problems).toEqual([
      'operation 1 (view.create "By title"): kanban.groupFieldId must be a single_select / user field of this table',
      'operation 4 (view.update): view 20 is at revision 4, not 3 — re-read it',
    ]);
  });

  it('checks forms, automations and roles with the handlers’ validators', async () => {
    const problems = await problemsOf([
      {
        op: 'form.create',
        tableId: 10,
        name: 'Intake',
        audience: { type: 'principals', groupIds: [99] },
        config: { fieldIds: [101] },
      },
      {
        op: 'form.create',
        tableId: 10,
        name: 'Both',
        config: { fieldIds: [101], defaults: [{ fieldId: 101, value: 'x' }] },
      },
      {
        op: 'automation.create',
        tableId: 10,
        name: 'Too often',
        trigger: 'schedule',
        config: {
          schedule: { cron: '* * * * *', timezone: 'UTC', scope: 'once' },
          actions: [{ type: 'delay', minutes: 5 }],
        },
      },
      {
        op: 'automation.create',
        tableId: 10,
        name: 'Bad value',
        trigger: 'record_created',
        config: { actions: [{ type: 'update_record', values: [{ fieldId: 102, value: 'nope' }] }] },
      },
      {
        op: 'role.create',
        baseId: 1,
        name: 'Elsewhere',
        rules: {
          version: 1,
          dashboards: 'none',
          tables: [{ tableId: 77, access: 'read', fields: [], fieldDefault: 'hidden' }],
        },
      },
    ]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(
      /operation 1 \(form.create "Intake"\): Form audience lists a group that does not exist/,
    );
    expect(problems[1]).toMatch(/both shown and prefilled/);
    expect(problems[2]).toMatch(/operation 3 .*15 minutes/);
    expect(problems[3]).toMatch(/operation 4 .*Status/);
    expect(problems[4]).toMatch(/table 77, which is not a table of this Base/);
  });

  it('stops a builder at roles and members, and an editor at structure', async () => {
    expect(await problemsOf([{ op: 'role.create', baseId: 1, name: 'R', rules: {} }], { level: 'builder' })).toEqual([
      expect.stringContaining('only the creator of Base 1 can change who has access — your role there is "builder"'),
    ]);
    expect(
      await problemsOf([{ op: 'field.create', tableId: 10, name: 'X', type: 'text' }], { level: 'editor' }),
    ).toEqual([expect.stringContaining('needs the builder role — yours is "editor"')]);
    expect(await problemsOf([{ op: 'table.create', baseId: 404, name: 'X' }])).toEqual([
      expect.stringContaining('Base 404 was not found, or you cannot see it'),
    ]);
  });

  it('checks grants: active people, visible groups, the owner, existing grants', async () => {
    const problems = await problemsOf([
      { op: 'member.set', baseId: 1, principal: 'user', userId: 'u_gone', role: 'viewer' },
      { op: 'member.set', baseId: 1, principal: 'group', groupId: 55, role: 'viewer' },
      { op: 'member.set', baseId: 1, principal: 'user', userId: ME, role: 'viewer' },
      { op: 'member.set', baseId: 1, principal: 'user', userId: EXAMPLE_USER_ID, role: 'none' },
      { op: 'member.set', baseId: 1, principal: 'user', userId: EXAMPLE_USER_ID, role: 'custom', customRoleId: 9 },
    ]);
    expect(problems).toEqual([
      expect.stringContaining('user u_gone is not an active internal user'),
      expect.stringContaining('group 55 was not found'),
      expect.stringContaining("the owner's access cannot change here"),
      expect.stringContaining('Alice has no grant on this Base'),
      expect.stringContaining('role 9 is not a role of this Base'),
    ]);
  });

  it('reports an existing grant as the before side', async () => {
    const draft = await draftSchemaPlan(
      [{ op: 'member.set', baseId: 1, principal: 'user', userId: EXAMPLE_USER_ID, role: 'custom', customRoleId: 5 }],
      reader({
        members: [{ user_id: EXAMPLE_USER_ID, role: 'editor', custom_role_id: null }],
        roles: [{ id: 5, name: 'Auditor', rules: { version: 1, dashboards: 'none', tables: [] }, revision: 1 }],
      }),
    );
    expect(draft).toEqual({
      ok: true,
      accessChanges: [
        {
          index: 0,
          kind: 'grant',
          base: 'Ops',
          principal: 'user',
          name: 'Alice',
          before: { kind: 'role', role: 'editor' },
          after: { kind: 'custom', roleName: 'Auditor' },
        },
      ],
    });
  });

  it('lets an update keep a rule’s webhook verbatim, but not change it', async () => {
    const webhook = { id: 'a1', type: 'webhook', url: 'https://hooks.example.com/in', fieldIds: [101] };
    const world: World = {
      automations: [
        {
          id: 40,
          table_id: 10,
          name: 'Ping',
          trigger: 'record_created',
          revision: 2,
          config: { version: 1, actions: [webhook] },
        },
      ],
    };
    const update = (actions: unknown[]): SchemaPlanOperation => ({
      op: 'automation.update',
      tableId: 10,
      automationId: 40,
      revision: 2,
      config: { actions },
    });
    expect(
      await problemsOf(
        [update([webhook, { type: 'update_record', values: [{ fieldId: 101, value: 'pinged' }] }])],
        world,
      ),
    ).toEqual([]);
    // tables_query shows only the origin of a webhook URL; copying that form back keeps the webhook too.
    expect(await problemsOf([update([{ ...webhook, url: 'https://hooks.example.com/…' }])], world)).toEqual([]);
    for (const changed of [
      { ...webhook, url: 'https://evil.example.com/in' },
      { ...webhook, fieldIds: [101, 102] },
      { ...webhook, id: 'a2' },
    ]) {
      expect(await problemsOf([update([changed])], world)).toEqual([
        expect.stringContaining('webhook actions can only be added or changed in the Tables editor'),
      ]);
    }
  });

  it('reports a broken creation once, not again for everything built on it', async () => {
    expect(
      await problemsOf([
        {
          op: 'field.create',
          ref: 'stage',
          tableId: 10,
          name: 'Stage',
          type: 'single_select',
          config: { options: [{ id: '阶段', label: 'x' }] },
        },
        {
          op: 'view.create',
          tableId: 10,
          name: 'Board',
          type: 'kanban',
          config: { kanban: { groupFieldId: '$field:stage' } },
        },
        { op: 'field.create', tableId: 10, name: 'Title', type: 'text' },
      ]),
    ).toEqual([
      expect.stringContaining('operation 1 (field.create "Stage"): Option id "阶段" must contain only letters'),
      'operation 3 (field.create "Title"): a field named "Title" already exists',
    ]);
  });

  it('returns the analyzer’s refusal as the only problem', async () => {
    expect(await problemsOf([{ op: 'field.create', tableRef: 'nope', name: 'X', type: 'text' }])).toEqual([
      expect.stringContaining('no table with ref "nope"'),
    ]);
  });
});

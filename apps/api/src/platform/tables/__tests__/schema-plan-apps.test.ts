/**
 * App operations in a schema plan (spec 20261011-tables-apps §7, slice AG):
 * the analyzer's shape rules, the applier's sequencing (refs → ids inside the
 * spec, the draft revision a create / update hands to a later publish, today's
 * revision when none is known), the primary-field refs a form or an app card
 * needs, and the draft check against a virtual schema (the F1 validator over
 * placeholders; the owner's steps; stale revisions; the permission section).
 * Pure: injected dispatch / reader, no database.
 */

import { describe, expect, it } from 'vitest';
import type { PlatformActionResult } from '@greenhouse/platform-kernel';
import type { AppAudiencesView, AppDraftView, AppSpec } from '@greenhouse/types/apps';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { analyzeSchemaPlan, applySchemaPlan, planTouchesApps, type SchemaPlanDispatch } from '../schema-plan.js';
import { draftSchemaPlan, type SchemaPlanReader } from '../schema-plan-draft.js';
import { accessChangeWords, planLines } from '../schema-plan-words.js';

const ok = (data: unknown): PlatformActionResult => ({ ok: true, data });
const notFound: PlatformActionResult = { ok: false, code: 'NOT_FOUND', message: 'not found' };

const ME = 'u_owner';
const NOW = '2026-10-11T00:00:00.000Z';

/** A small app over table 10 of Base 1: one page, one role that edits Status. */
function spec(tableId: number | string, statusFieldId: number | string, roleAccess: 'read' | 'edit' = 'edit') {
  return {
    version: 1,
    pages: [
      {
        id: 'board',
        title: 'Board',
        cards: [
          {
            id: 'tasks',
            kind: 'records',
            layout: { x: 0, y: 0, w: 12, h: 6 },
            source: { tableId },
            fieldIds: [statusFieldId],
            actions: [
              {
                id: 'close',
                label: 'Close',
                do: { type: 'set_fields', values: [{ fieldId: statusFieldId, value: 'done' }] },
              },
            ],
          },
        ],
      },
    ],
    roles: [
      {
        key: 'worker',
        name: 'Worker',
        pages: 'all',
        tables: [{ tableId, access: roleAccess, fields: [], fieldDefault: 'visible' }],
      },
    ],
  };
}

// ─── Analyzer ────────────────────────────────────────────

describe('analyzeSchemaPlan — apps', () => {
  const base: SchemaPlanOperation = { op: 'base.create', ref: 'b', name: 'Ops' };

  it('needs exactly one Base for app.create and one app for the others', () => {
    expect(analyzeSchemaPlan([{ op: 'app.create', name: 'A', spec: {} }])).toEqual({
      error: 'operation 1: give exactly one of baseRef or baseId',
    });
    expect(analyzeSchemaPlan([{ op: 'app.publish', notes: 'v1' }])).toEqual({
      error: 'operation 1: give exactly one of appId or appRef',
    });
    expect(analyzeSchemaPlan([base, { op: 'app.audience', appRef: 'b', entries: [] }])).toEqual({
      error: 'operation 2: ref "b" is a base, not a app',
    });
    expect(analyzeSchemaPlan([{ op: 'app.update', appId: 4 }])).toEqual({
      error: 'operation 1: app.update changes the name, the spec or both',
    });
  });

  it('publishes an existing app only at a known draft revision', () => {
    expect(analyzeSchemaPlan([{ op: 'app.publish', appId: 4, notes: 'v2' }])).toEqual({
      error: expect.stringContaining('needs the draftRevision you read'),
    });
    expect(analyzeSchemaPlan([{ op: 'app.publish', appId: 4, notes: 'v2', draftRevision: 3 }])).not.toHaveProperty(
      'error',
    );
    // A plan that writes the draft first publishes what it wrote.
    expect(
      analyzeSchemaPlan([
        { op: 'app.update', appId: 4, spec: {} },
        { op: 'app.publish', appId: 4, notes: 'v2' },
      ]),
    ).not.toHaveProperty('error');
    // A plan-created app needs no revision at all.
    expect(
      analyzeSchemaPlan([
        base,
        { op: 'app.create', ref: 'a', baseRef: 'b', name: 'A', spec: {} },
        { op: 'app.publish', appRef: 'a', notes: 'v1' },
      ]),
    ).not.toHaveProperty('error');
  });

  it('declares the primary field refs of new tables', () => {
    const shape = analyzeSchemaPlan([
      { op: 'base.create', ref: 'b', name: 'Ops', defaultTableRef: 't', primaryFieldRef: 'title' },
      { op: 'table.create', ref: 't2', baseRef: 'b', name: 'More', primaryFieldRef: 'name2' },
      { op: 'view.create', tableRef: 't', name: 'V', config: { fieldIds: ['$field:title', '$field:name2'] } },
    ]);
    expect('declared' in shape && [...shape.declared.keys()]).toEqual(['b', 't', 'title', 't2', 'name2']);
  });

  it('knows a plan with app operations', () => {
    expect(planTouchesApps([base])).toBe(false);
    expect(planTouchesApps([base, { op: 'app.publish', appId: 1, notes: 'x', draftRevision: 1 }])).toBe(true);
  });
});

// ─── Applier ─────────────────────────────────────────────

interface Call {
  actionId: string;
  payload: Record<string, unknown>;
}

function recorder(answer: (call: Call) => PlatformActionResult) {
  const calls: Call[] = [];
  const dispatch: SchemaPlanDispatch = async (actionId, payload) => {
    const call = { actionId, payload: payload as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  };
  return { calls, dispatch };
}

const appView = (id: number, draftRevision: number) => ({ app: { id, baseId: 1 }, draftRevision, errors: [] });

describe('applySchemaPlan — apps', () => {
  it('creates, revises and publishes an app at the revisions it wrote, with every ref resolved', async () => {
    const { calls, dispatch } = recorder((call) => {
      switch (call.actionId) {
        case 'createBase':
          return ok({
            base: { id: 1 },
            schema: { table: { id: 10 }, fields: [{ id: 100, is_primary: true }] },
          });
        case 'updateField':
          return ok({ field: { id: 100 } });
        case 'createField':
          return ok({ field: { id: 101 } });
        case 'createApp':
          return ok(appView(7, 1));
        case 'saveAppDraft':
          return ok(appView(7, 2));
        case 'listAppAudiences':
          return ok({ audiencesRevision: 5 });
        case 'setAppAudiences':
          return ok({ entries: [], audiencesRevision: 6 });
        case 'publishApp':
          return ok({ app: { id: 7, baseId: 1 }, version: { version: 1 } });
        default:
          return notFound;
      }
    });
    const result = await applySchemaPlan(
      [
        {
          op: 'base.create',
          ref: 'b',
          name: 'Ops',
          defaultTableRef: 't',
          primaryFieldRef: 'title',
          primaryFieldName: '事项',
        },
        { op: 'field.create', ref: 'status', tableRef: 't', name: 'Status', type: 'text' },
        { op: 'app.create', ref: 'a', baseRef: 'b', name: 'Board', spec: spec('$table:t', '$field:status') },
        { op: 'app.update', appRef: 'a', spec: spec('$table:t', '$field:title') },
        { op: 'app.audience', appRef: 'a', entries: [{ principal: { type: 'team' }, roleKey: 'worker' }] },
        { op: 'app.publish', appRef: 'a', notes: 'v1' },
      ],
      dispatch,
    );
    expect(result.results.map((entry) => entry.status)).toEqual(Array(6).fill('applied'));
    expect(result.refs).toMatchObject({ title: { kind: 'field', id: 100 }, a: { kind: 'app', id: 7 } });
    expect(result.baseId).toBe(1);
    expect(calls.find((call) => call.actionId === 'updateField')?.payload).toEqual({ fieldId: 100, name: '事项' });
    const created = calls.find((call) => call.actionId === 'createApp')!.payload;
    expect(created).toMatchObject({ baseId: 1, name: 'Board' });
    expect((created.spec as AppSpec).pages[0]!.cards[0]).toMatchObject({ source: { tableId: 10 }, fieldIds: [101] });
    // The update builds on the create's revision, the publish on the update's; the audience reads today's.
    expect(calls.find((call) => call.actionId === 'saveAppDraft')?.payload).toMatchObject({
      appId: 7,
      draftRevision: 1,
    });
    expect(calls.find((call) => call.actionId === 'setAppAudiences')?.payload).toMatchObject({
      appId: 7,
      audiencesRevision: 5,
    });
    expect(calls.find((call) => call.actionId === 'publishApp')?.payload).toEqual({
      appId: 7,
      notes: 'v1',
      draftRevision: 2,
    });
    expect(calls.some((call) => call.actionId === 'getAppDraft')).toBe(false);
  });

  it('says why a publish was refused, with the first spec problem', async () => {
    const { dispatch } = recorder((call) =>
      call.actionId === 'publishApp'
        ? {
            ok: false,
            code: 'INVALID_INPUT',
            message: 'spec_invalid',
            details: {
              errors: [
                { path: 'pages[0].cards[0].fieldIds[0]', message: 'Field 9 does not exist on table 10' },
                { path: 'roles[0]', message: 'x' },
              ],
            },
          }
        : notFound,
    );
    const result = await applySchemaPlan([{ op: 'app.publish', appId: 3, notes: 'v2', draftRevision: 4 }], dispatch);
    expect(result.results[0]).toMatchObject({
      status: 'failed',
      message: 'spec_invalid — pages[0].cards[0].fieldIds[0]: Field 9 does not exist on table 10 (+1 more)',
    });
  });

  it('keeps a created table applied when only its primary-field rename fails (a retry must not create it twice)', async () => {
    const { dispatch } = recorder((call) =>
      call.actionId === 'createTable'
        ? ok({ table: { id: 10 }, fields: [{ id: 100, is_primary: true }] })
        : { ok: false, code: 'INVALID_INPUT', message: 'name taken' },
    );
    const result = await applySchemaPlan(
      [{ op: 'table.create', ref: 't', baseId: 1, name: 'T', primaryFieldRef: 'p', primaryFieldName: 'Title' }],
      dispatch,
    );
    expect(result.results[0]).toMatchObject({
      status: 'applied',
      message: 'created, but the primary field was not renamed: name taken',
    });
    expect(result.refs).toMatchObject({ t: { id: 10 }, p: { id: 100 } });
  });
});

// ─── Draft check ─────────────────────────────────────────

const statusConfig = JSON.stringify({
  options: [
    { id: 'open', label: 'Open' },
    { id: 'done', label: 'Done' },
  ],
});

function fieldRow(id: number, name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    table_id: 10,
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
  apps?: boolean;
  /** App 50 (published v2) and its audience. */
  app?: Partial<AppDraftView>;
  audiences?: Partial<AppAudiencesView>;
}

/** Base 1 (table 10: Name, Status) and app 50 on it. */
function reader(world: World = {}): SchemaPlanReader {
  return {
    userId: ME,
    grantableGroups: async () => [{ id: 7, name: 'Finance', managedBy: { id: 'u_ann', name: 'Ann' } }],
    appsEnabled: async () => world.apps ?? true,
    dispatch: async (actionId, payload) => {
      const input = payload as Record<string, number>;
      switch (actionId) {
        case 'getBase':
          return input.baseId === 1
            ? ok({
                base: { id: 1, name: 'Ops', owner_id: ME, visibility: 'private', team_role: 'viewer' },
                access: { level: world.level ?? 'owner' },
                tables: [{ id: 10, name: 'Tasks' }],
                dashboards: [],
              })
            : notFound;
        case 'getSchema':
          return input.tableId === 10
            ? ok({
                table: { id: 10, base_id: 1, name: 'Tasks' },
                fields: [
                  fieldRow(100, 'Name', 'text', { is_primary: true, required: true }),
                  fieldRow(102, 'Status', 'single_select', { config: statusConfig }),
                ],
                views: [],
              })
            : notFound;
        case 'listAutomations':
          return ok({ automations: [] });
        case 'listAssignableUsers':
          return ok({ users: [{ id: ME, nickname: 'Olive' }] });
        case 'getAppDraft':
          return input.appId === 50
            ? ok({
                app: { id: 50, baseId: 1, name: 'Desk', publishedVersion: 2 },
                spec: spec(10, 102),
                draftRevision: 6,
                errors: [],
                ...world.app,
              })
            : notFound;
        case 'listAppAudiences':
          return input.appId === 50
            ? ok({
                entries: [{ principal: { type: 'team' }, roleKey: 'worker', name: 'everyone' }],
                audiencesRevision: 3,
                roles: [{ key: 'worker', name: 'Worker' }],
                ...world.audiences,
              })
            : notFound;
        default:
          return notFound;
      }
    },
  };
}

async function draft(operations: SchemaPlanOperation[], world?: World) {
  return draftSchemaPlan(operations, reader(world));
}

describe('draftSchemaPlan — apps', () => {
  it('checks a new app’s spec with the app validator over the plan’s own fields', async () => {
    const drafted = await draft([
      { op: 'field.create', ref: 'stage', tableId: 10, name: 'Stage', type: 'text' },
      { op: 'app.create', ref: 'a', baseId: 1, name: 'Board', spec: spec(10, '$field:stage') },
    ]);
    expect(drafted).toMatchObject({ ok: true });
  });

  it('reports spec problems with their path, naming plan refs instead of placeholders', async () => {
    const drafted = await draft([
      { op: 'field.create', ref: 'stage', tableId: 10, name: 'Stage', type: 'text' },
      { op: 'app.create', ref: 'a', baseId: 1, name: 'Board', spec: spec(10, '$field:stage', 'read') },
    ]);
    expect(drafted.ok ? [] : drafted.problems).toEqual([
      'operation 2 (app.create "Board"): spec.pages[0].cards[0].actions[0].do: Role "worker" cannot edit field $field:stage on table 10',
    ]);
  });

  it('stops a builder at publishing and sharing, and anyone without Apps at every app step', async () => {
    const asBuilder = await draft([{ op: 'app.publish', appId: 50, notes: 'v3', draftRevision: 6 }], {
      level: 'builder',
    });
    expect(asBuilder.ok ? [] : asBuilder.problems).toEqual([
      'operation 1 (app.publish): only the creator of Base 1 can publish an app — your role there is "builder"',
    ]);
    const update = await draft([{ op: 'app.update', appId: 50, draftRevision: 6, name: 'Desk 2' }], {
      level: 'builder',
    });
    expect(update).toMatchObject({ ok: true, targetNames: { 0: 'Desk' } });
    const off = await draft([{ op: 'app.update', appId: 50, draftRevision: 6, name: 'x' }], { apps: false });
    expect(off.ok ? [] : off.problems[0]).toMatch(/Apps are turned off for you/);
  });

  it('refuses a stale draft revision and a draft whose stored problems publishing would refuse', async () => {
    const stale = await draft([{ op: 'app.update', appId: 50, draftRevision: 5, spec: spec(10, 102) }]);
    expect(stale.ok ? [] : stale.problems).toEqual([
      'operation 1 (app.update): the draft of app 50 is at revision 6, not 5 — re-read it',
    ]);
    const broken = await draft([{ op: 'app.publish', appId: 50, notes: 'v3', draftRevision: 6 }], {
      app: { errors: [{ path: 'pages[0].cards[0].fieldIds[0]', message: 'Field 99 does not exist on table 10' }] },
    });
    expect(broken.ok ? '' : broken.problems[0]).toMatch(/Field 99 does not exist/);
    // Fixing the draft in the same plan clears it.
    const fixed = await draft(
      [
        { op: 'app.update', appId: 50, draftRevision: 6, spec: spec(10, 102) },
        { op: 'app.publish', appId: 50, notes: 'v3' },
      ],
      { app: { errors: [{ path: 'x', message: 'broken' }] } },
    );
    expect(fixed).toMatchObject({ ok: true });
  });

  it('lists who gains the app before → after, and what goes live with the next version', async () => {
    const drafted = await draft([
      {
        op: 'app.audience',
        appId: 50,
        audiencesRevision: 3,
        entries: [
          { principal: { type: 'user', userId: ME }, roleKey: 'worker' },
          { principal: { type: 'group', groupId: 7 }, roleKey: 'worker' },
        ],
      },
      { op: 'app.publish', appId: 50, notes: 'v3', draftRevision: 6 },
    ]);
    expect(drafted.ok && drafted.accessChanges).toEqual([
      {
        index: 0,
        kind: 'app_audience',
        app: 'Desk',
        before: [{ principal: 'team', name: '', role: 'Worker' }],
        after: [
          { principal: 'user', name: 'Olive', role: 'Worker' },
          { principal: 'group', name: 'Finance', role: 'Worker', managedBy: 'Ann' },
        ],
      },
      {
        index: 1,
        kind: 'app_publish',
        app: 'Desk',
        version: 3,
        audience: [
          { principal: 'user', name: 'Olive', role: 'Worker' },
          { principal: 'group', name: 'Finance', role: 'Worker', managedBy: 'Ann' },
        ],
      },
    ]);
    if (!drafted.ok) return;
    expect(accessChangeWords(drafted.accessChanges[0]!, 'zh')).toEqual({
      subject: '应用 Desk 的受众',
      before: '团队所有人 → Worker',
      after: 'Olive → Worker；群组 Finance（由 Ann 管理） → Worker',
    });
    expect(accessChangeWords(drafted.accessChanges[1]!, 'en')).toMatchObject({
      subject: 'Publish the app Desk',
      before: 'v2 live',
    });
  });

  it('refuses audience roles the app does not have, unknown people and groups, and doubles', async () => {
    const problems = async (entries: unknown[]) => {
      const drafted = await draft([
        { op: 'app.audience', appId: 50, entries: entries as never } as SchemaPlanOperation,
      ]);
      return drafted.ok ? [] : drafted.problems;
    };
    expect(await problems([{ principal: { type: 'team' }, roleKey: 'boss' }])).toEqual([
      'operation 1 (app.audience): "boss" is not a role of the app — its roles: worker',
    ]);
    expect((await problems([{ principal: { type: 'group', groupId: 99 }, roleKey: 'worker' }]))[0]).toMatch(
      /group 99 was not found/,
    );
    expect((await problems([{ principal: { type: 'user', userId: 'u_nobody' }, roleKey: 'worker' }]))[0]).toMatch(
      /not an active internal user/,
    );
    expect(
      (
        await problems([
          { principal: { type: 'team' }, roleKey: 'worker' },
          { principal: { type: 'team' }, roleKey: 'worker' },
        ])
      )[0],
    ).toMatch(/the team is listed twice/);
  });

  it('words every line of a plan for a card the client cannot word itself', () => {
    expect(
      planLines(
        [
          { op: 'app.create', ref: 'a', baseId: 1, name: '采购申请', spec: {} },
          { op: 'app.publish', appId: 50, notes: 'v3', draftRevision: 6 },
        ],
        { 1: 'Desk' },
        'zh',
      ),
    ).toEqual([
      { op: 'app.create', label: '新建应用', target: '采购申请' },
      { op: 'app.publish', label: '发布应用', target: 'Desk' },
    ]);
  });
});
